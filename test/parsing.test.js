const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCsvText,
  parseNorwegianNumber,
  parseHandicapSheet,
  stripHtmlToText,
  parseKtkHtml,
  extractGoogleSheetId,
  parseManage2SailEventPage,
  parseManage2SailEntries,
  findHandicapSystem,
  resolveHandicapSystem
} = require('../index.js').internal;

describe('parseCsvText', () => {
  test('splits plain comma-separated rows', () => {
    assert.deepEqual(parseCsvText('a,b,c\n1,2,3'), [
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ]);
  });

  test('keeps a comma inside a quoted field as part of that field', () => {
    assert.deepEqual(parseCsvText('name,value\nSolli,"1,050"'), [
      ['name', 'value'],
      ['Solli', '1,050']
    ]);
  });

  test('un-escapes a doubled quote inside a quoted field', () => {
    assert.deepEqual(parseCsvText('a\n"say ""hi"""'), [['a'], ['say "hi"']]);
  });

  test('drops \\r before \\n but keeps rows intact', () => {
    assert.deepEqual(parseCsvText('a,b\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2']
    ]);
  });
});

describe('parseNorwegianNumber', () => {
  test('treats a comma as the decimal separator', () => {
    assert.equal(parseNorwegianNumber('1,05'), 1.05);
  });

  test('still accepts a plain dot', () => {
    assert.equal(parseNorwegianNumber('1.05'), 1.05);
  });

  test('null for null/undefined/blank input', () => {
    assert.equal(parseNorwegianNumber(null), null);
    assert.equal(parseNorwegianNumber(undefined), null);
    assert.equal(parseNorwegianNumber('   '), null);
  });

  test('null for non-numeric text', () => {
    assert.equal(parseNorwegianNumber('n/a'), null);
  });
});

describe('parseHandicapSheet', () => {
  const csv = [
    'SSCA VET-tall 2026',
    ',,,,,',
    'Båt,Gyldig,Seilføring,VET 1,Klasse,Eier',
    'RS 21 Solli,OK,Uten spinnaker,"1,050",IRC,Bakke',
    ',,,,,', // blank name — must be skipped
    'No Vets,OK,,,IRC,Nobody' // no parseable VET value — must be skipped
  ].join('\n');

  test('finds the header row and reads boats after it', () => {
    const boats = parseHandicapSheet(csv);
    assert.equal(boats.length, 1);
    assert.equal(boats[0].name, 'RS 21 Solli');
    assert.equal(boats[0].validity, 'OK');
    assert.equal(boats[0].class, 'IRC');
    assert.equal(boats[0].owner, 'Bakke');
  });

  test('reads the VET value and its label from the column before it', () => {
    const boats = parseHandicapSheet(csv);
    assert.deepEqual(boats[0].vets, [{ label: 'Uten spinnaker', value: 1.05 }]);
  });

  test('throws when the header row cannot be found', () => {
    assert.throws(() => parseHandicapSheet('just,some,junk\n1,2,3'), /header row/);
  });

  test('falls back to a generic "VET n" label when the label column is blank', () => {
    const noLabelCsv = ['Båt,Gyldig,,VET 1,Klasse', 'Solveig,OK,,"1,20",IRC'].join('\n');
    const boats = parseHandicapSheet(noLabelCsv);
    assert.equal(boats[0].vets[0].label, 'VET 1');
  });
});

describe('stripHtmlToText', () => {
  test('removes tags and decodes the entities this app actually emits', () => {
    assert.equal(stripHtmlToText('<td>Solveig&nbsp;II &amp; co</td>'), 'Solveig II & co');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(stripHtmlToText('  <b>hi</b>  '), 'hi');
  });
});

describe('parseKtkHtml', () => {
  test('throws when there is no table on the page', () => {
    assert.throws(() => parseKtkHtml('<html><body>no table here</body></html>'), /KLR table/);
  });

  test('parses one boat, one KLR value, plain "KLR" label', () => {
    const html = '<table><tr><td>Boat</td><td>KLR</td></tr><tr><td>Njord</td><td>166</td></tr></table>';
    const boats = parseKtkHtml(html);
    assert.equal(boats.length, 1);
    assert.equal(boats[0].name, 'Njord');
    assert.deepEqual(boats[0].vets, [{ label: 'KLR', value: 1.66, raw: 166 }]);
  });

  test('groups multiple rows for the same boat (case-insensitively) and numbers the labels', () => {
    const html =
      '<table>' +
      '<tr><td>Boat</td><td>KLR</td></tr>' +
      '<tr><td>Solveig</td><td>166</td></tr>' +
      '<tr><td>solveig</td><td>170</td></tr>' +
      '</table>';
    const boats = parseKtkHtml(html);
    assert.equal(boats.length, 1);
    assert.deepEqual(boats[0].vets, [
      { label: 'KLR 1', value: 1.66, raw: 166 },
      { label: 'KLR 2', value: 1.7, raw: 170 }
    ]);
  });

  test('skips a row whose second cell is not a usable positive number', () => {
    const html = '<table><tr><td>Boat</td><td>KLR</td></tr><tr><td>Njord</td><td>n/a</td></tr></table>';
    assert.deepEqual(parseKtkHtml(html), []);
  });
});

describe('extractGoogleSheetId', () => {
  test('pulls the id out of a full sheets URL', () => {
    assert.equal(
      extractGoogleSheetId('https://docs.google.com/spreadsheets/d/1AbC-xyz_123/edit#gid=0'),
      '1AbC-xyz_123'
    );
  });

  test('null when no sheets link is present', () => {
    assert.equal(extractGoogleSheetId('nothing relevant here'), null);
  });
});

describe('parseManage2SailEventPage', () => {
  const eventId = '12345678-1234-1234-1234-123456789012';
  const html = `
    <a href="/en-US/support/EventIssue?eventId=${eventId}">Report an issue</a>
    <script>window.boostrapedResourceData = {"Regatta":[{"Id":"r1","Name":"ORC A"},{"Id":"r2","Name":"ORC B"}]};</script>
  `;

  test('extracts the event id and class list', () => {
    const result = parseManage2SailEventPage(html);
    assert.equal(result.eventId, eventId);
    assert.deepEqual(result.classes, [
      { id: 'r1', name: 'ORC A' },
      { id: 'r2', name: 'ORC B' }
    ]);
  });

  test('throws when the event id is missing', () => {
    assert.throws(() => parseManage2SailEventPage('<html>nothing here</html>'), /event's id/);
  });

  test('throws when the resource data script is missing', () => {
    assert.throws(
      () => parseManage2SailEventPage(`<a href="/EventIssue?eventId=${eventId}"></a>`),
      /class data/
    );
  });
});

describe('parseManage2SailEntries', () => {
  test('picks a display name from the first available field, in priority order', () => {
    const json = {
      HcpName: 'YS',
      Entries: [
        { BoatName: 'Njord', SailNumber: 'NOR 1', Hcp: '95' },
        { SailNumber: 'NOR 2', TeamName: 'Team Two', Hcp: '100' },
        { TeamName: 'Team Three', SkipperName: 'Skipper Three', Hcp: '105' },
        { SkipperName: 'Skipper Four', Hcp: '110' }
      ]
    };
    const result = parseManage2SailEntries(json);
    assert.deepEqual(result.entries.map((e) => e.name), ['Njord', 'NOR 2', 'Team Three', 'Skipper Four']);
  });

  test('accepts a comma decimal in Hcp', () => {
    const result = parseManage2SailEntries({ Entries: [{ BoatName: 'Njord', Hcp: '95,5' }] });
    assert.equal(result.entries[0].hcp, 95.5);
  });

  test('skips entries with no usable name or a non-positive/invalid Hcp', () => {
    const json = {
      Entries: [
        { Hcp: '95' }, // no name at all
        { BoatName: 'Njord', Hcp: '0' }, // zero
        { BoatName: 'Njord', Hcp: 'n/a' } // unparseable
      ]
    };
    const result = parseManage2SailEntries(json);
    assert.equal(result.entries.length, 0);
    assert.equal(result.skipped, 3);
  });
});

describe('findHandicapSystem / resolveHandicapSystem', () => {
  test('findHandicapSystem looks up by key', () => {
    assert.equal(findHandicapSystem('py').key, 'py');
    assert.equal(findHandicapSystem('nope'), null);
  });

  test('resolves YS on DSV-scale values (40-250) to "ys"', () => {
    assert.deepEqual(resolveHandicapSystem('YS', [95, 100, 110]), { resolved: 'ys' });
  });

  test('resolves YS on RYA-scale values (400-3000) to "py"', () => {
    assert.deepEqual(resolveHandicapSystem('YS', [950, 1000, 1100]), { resolved: 'py' });
  });

  test('reports candidates when YS values fit neither scale unambiguously', () => {
    const result = resolveHandicapSystem('YS', [300]);
    assert.equal(result.resolved, null);
    assert.deepEqual(result.candidates, ['ys', 'py', 'tcf']);
  });

  test('PY/PN always resolves to "py" regardless of values', () => {
    assert.deepEqual(resolveHandicapSystem('PY', []), { resolved: 'py' });
    assert.deepEqual(resolveHandicapSystem('PN', [1]), { resolved: 'py' });
  });

  test('an unrecognized/blank name defaults to "tcf"', () => {
    assert.deepEqual(resolveHandicapSystem('', []), { resolved: 'tcf' });
    assert.deepEqual(resolveHandicapSystem('ORC', [1.05]), { resolved: 'tcf' });
  });
});
