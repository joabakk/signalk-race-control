const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { createWorkbook, crc32, zip, columnLetters, excelSerial } = require('../xlsx.js');

// Reads the entries back out of a ZIP via its central directory.
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = method === 8 ? zlib.inflateRawSync(buf.subarray(dataStart, dataStart + csize)) : buf.subarray(dataStart, dataStart + csize);
    assert.equal(crc32(raw), crc, `crc of ${name}`);
    files[name] = raw.toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

describe('xlsx helpers', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('columnLetters', () => {
    assert.equal(columnLetters(1), 'A');
    assert.equal(columnLetters(10), 'J');
    assert.equal(columnLetters(26), 'Z');
    assert.equal(columnLetters(27), 'AA');
    assert.equal(columnLetters(52), 'AZ');
    assert.equal(columnLetters(703), 'AAA');
  });

  test('excelSerial: 1900-01-01 is 2 and the Unix epoch is 25569', () => {
    assert.equal(excelSerial(new Date(Date.UTC(1970, 0, 1))), 25569);
    assert.equal(excelSerial(new Date(Date.UTC(1900, 0, 1))), 2);
    assert.equal(excelSerial(new Date(Date.UTC(1970, 0, 1, 12))), 25569.5);
  });

  test('zip round-trips entries with valid CRCs', () => {
    const files = unzip(zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: 'x'.repeat(5000) }]));
    assert.equal(files['a.txt'], 'hello');
    assert.equal(files['dir/b.txt'], 'x'.repeat(5000));
  });
});

describe('createWorkbook', () => {
  const build = () => {
    const wb = createWorkbook();
    const sh = wb.addWorksheet('Results & <more>');
    const title = sh.addRow([{ value: 'Title "q" & <b>', font: { bold: true, size: 14 } }]);
    sh.mergeCells(title, 1, title, 3);
    sh.addRow([]);
    sh.addRow(['Boat', 'TCF', 'Start', 'Elapsed'], { font: { bold: true }, fill: 'FFE2E8F0' });
    sh.addRow(['Alpha', 0.97, { value: new Date(Date.UTC(2026, 9, 13, 18, 5, 0)), numFmt: 'hh:mm:ss' }, { formula: 'B4*2', value: 1.94, numFmt: '[h]:mm:ss' }]);
    sh.addRow(['Beta', null, null, { formula: 'IF(1=1,"","x")', value: '', numFmt: '[h]:mm:ss' }]);
    sh.setColumnWidth(1, 24);
    return unzip(wb.toBuffer());
  };

  test('emits the expected package parts', () => {
    const files = build();
    assert.deepEqual(Object.keys(files).sort(), [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml'
    ]);
  });

  test('escapes sheet names and strings, and writes merges, widths, values and formulas', () => {
    const files = build();
    assert.match(files['xl/workbook.xml'], /name="Results &amp; &lt;more&gt;"/);
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /Title &quot;q&quot; &amp; &lt;b&gt;/);
    assert.match(sheet, /<mergeCell ref="A1:C1"\/>/);
    assert.match(sheet, /<col min="1" max="1" width="24" customWidth="1"\/>/);
    assert.match(sheet, /<c r="B4"[^>]*><v>0\.97<\/v><\/c>/);
    assert.match(sheet, /<c r="D4"[^>]*><f>B4\*2<\/f><v>1\.94<\/v><\/c>/);
    assert.match(sheet, /<c r="D5"[^>]*t="str"><f>IF\(1=1,&quot;&quot;,&quot;x&quot;\)<\/f><v><\/v><\/c>/);
    assert.match(sheet, new RegExp(`<c r="C4"[^>]*><v>${excelSerial(new Date(Date.UTC(2026, 9, 13, 18, 5, 0)))}</v></c>`));
    // Null cells are simply absent.
    assert.doesNotMatch(sheet, /r="B5"/);
  });

  test('registers fonts, fills and number formats in styles.xml', () => {
    const styles = build()['xl/styles.xml'];
    assert.match(styles, /<numFmt numFmtId="164" formatCode="hh:mm:ss"\/>/);
    assert.match(styles, /<numFmt numFmtId="165" formatCode="\[h\]:mm:ss"\/>/);
    assert.match(styles, /<b\/>/);
    assert.match(styles, /<sz val="14"\/>/);
    assert.match(styles, /<fgColor rgb="FFE2E8F0"\/>/);
  });
});
