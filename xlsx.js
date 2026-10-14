'use strict';

// A deliberately small, dependency-free .xlsx (Office Open XML) writer —
// just what the results export needs: several worksheets, string / number /
// date / formula cells, bold/italic/size/colour fonts, solid fills, custom
// number formats, merged cells and column widths. It replaces a general
// spreadsheet library whose (unmaintained) dependency tree kept tripping
// npm audit for every installer of this plugin.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal ZIP writer: deflated entries, UTF-8 names, no extras.
function zip(entries, now = new Date()) {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  });
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Control characters other than tab/newline/CR are illegal in XML 1.0.
function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetters(col) {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const cellRef = (row, col) => `${columnLetters(col)}${row}`;

// Excel stores dates as days since 1899-12-30 (the 1900 leap-year bug folded
// in). The caller passes a Date whose UTC fields hold the wall-clock to show.
const excelSerial = (date) => date.getTime() / 86400000 + 25569;

// Registers fonts / fills / number formats / cell formats as they're used,
// and emits xl/styles.xml. Index 0 of each is the default.
function createStyles() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const numFmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const cache = new Map();

  const indexOf = (list, xml) => {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  };

  function xfFor(style) {
    if (!style) return 0;
    const key = JSON.stringify(style);
    if (cache.has(key)) return cache.get(key);
    const f = style.font;
    let fontId = 0;
    if (f) {
      fontId = indexOf(
        fonts,
        '<font>' +
          (f.bold ? '<b/>' : '') +
          (f.italic ? '<i/>' : '') +
          `<sz val="${f.size || 11}"/>` +
          (f.color ? `<color rgb="${xmlEscape(f.color)}"/>` : '') +
          '<name val="Calibri"/></font>'
      );
    }
    const fillId = style.fill
      ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${xmlEscape(style.fill)}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    let numFmtId = 0;
    if (style.numFmt) {
      const idx = indexOf(numFmts, style.numFmt);
      numFmtId = 164 + idx;
    }
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"` +
      (numFmtId ? ' applyNumberFormat="1"' : '') +
      (fontId ? ' applyFont="1"' : '') +
      (fillId ? ' applyFill="1"' : '') +
      '/>';
    const id = indexOf(xfs, xf);
    cache.set(key, id);
    return id;
  }

  function toXml() {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (numFmts.length
        ? `<numFmts count="${numFmts.length}">` +
          numFmts.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEscape(code)}"/>`).join('') +
          '</numFmts>'
        : '') +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
      `<fills count="${fills.length}">${fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }

  return { xfFor, toXml };
}

// A cell is a plain value (string, number, Date, null) or an object:
//   { value, formula, numFmt, font: {bold, italic, size, color}, fill }
// `formula` (without the leading "=") may come with a cached `value` so
// viewers that don't recalculate still show a result.
function createWorkbook() {
  const styles = createStyles();
  const sheets = [];

  function addWorksheet(name) {
    const rows = []; // rows[r-1] = [cell specs by column]
    const merges = [];
    const widths = [];
    const sheet = {
      name,
      // Appends a row and returns its 1-based number. `rowStyle` is merged
      // under each cell's own style (e.g. a bold, filled header row).
      addRow(cells, rowStyle) {
        rows.push(cells.map((c) => normalise(c, rowStyle)));
        return rows.length;
      },
      mergeCells(row1, col1, row2, col2) {
        merges.push(`${cellRef(row1, col1)}:${cellRef(row2, col2)}`);
      },
      setColumnWidth(col, width) {
        widths[col - 1] = width;
      },
      toXml() {
        const sheetData = rows
          .map((cells, ri) => {
            const r = ri + 1;
            const cs = cells.map((spec, ci) => cellXml(spec, r, ci + 1)).join('');
            return cs ? `<row r="${r}">${cs}</row>` : '';
          })
          .join('');
        const cols = widths
          .map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : ''))
          .join('');
        return (
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          (cols ? `<cols>${cols}</cols>` : '') +
          `<sheetData>${sheetData}</sheetData>` +
          (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
          '</worksheet>'
        );
      }
    };
    sheets.push(sheet);
    return sheet;
  }

  function normalise(c, rowStyle) {
    const spec = c !== null && typeof c === 'object' && !(c instanceof Date) ? c : { value: c };
    const style = {
      font: spec.font || (rowStyle && rowStyle.font),
      fill: spec.fill || (rowStyle && rowStyle.fill),
      numFmt: spec.numFmt || (rowStyle && rowStyle.numFmt)
    };
    return { value: spec.value, formula: spec.formula, style: style.font || style.fill || style.numFmt ? style : null };
  }

  function cellXml(spec, row, col) {
    const s = styles.xfFor(spec.style);
    const attrs = `r="${cellRef(row, col)}"${s ? ` s="${s}"` : ''}`;
    const v = spec.value;
    if (spec.formula) {
      const f = `<f>${xmlEscape(spec.formula)}</f>`;
      if (typeof v === 'number') return `<c ${attrs}>${f}<v>${v}</v></c>`;
      return `<c ${attrs} t="str">${f}<v>${v == null ? '' : xmlEscape(v)}</v></c>`;
    }
    if (v === null || v === undefined || v === '') return s ? `<c ${attrs}/>` : '';
    if (v instanceof Date) return `<c ${attrs}><v>${excelSerial(v)}</v></c>`;
    if (typeof v === 'number') return isFinite(v) ? `<c ${attrs}><v>${v}</v></c>` : '';
    return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  }

  function toBuffer() {
    const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheetFiles = sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sh.toXml() }));
    const entries = [
      {
        name: '[Content_Types].xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets
            .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
            .join('') +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>'
      },
      {
        name: '_rels/.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          `<Relationship Id="rId1" Type="${NS}/officeDocument" Target="xl/workbook.xml"/>` +
          '</Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}">` +
          '<sheets>' +
          sheets.map((sh, i) => `<sheet name="${xmlEscape(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
          '</sheets><calcPr fullCalcOnLoad="1"/></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${sheets.length + 1}" Type="${NS}/styles" Target="styles.xml"/>` +
          '</Relationships>'
      },
      ...sheetFiles,
      // Styles are emitted last: building the sheets above is what
      // registers the fonts/fills/formats they use.
      { name: 'xl/styles.xml', data: styles.toXml() }
    ];
    return zip(entries);
  }

  return { addWorksheet, toBuffer };
}

module.exports = { createWorkbook, crc32, zip, columnLetters, excelSerial };
