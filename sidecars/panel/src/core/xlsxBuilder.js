/**
 * @fileoverview 零外部依赖原生 Excel (`.xlsx` / ECMA-376 OOXML) 多工作表构建器 (`xlsxBuilder.js`)。
 * 内置标准 IEEE 802.3 CRC-32 及 ZIP STORE 封装，支持：
 * - 多 Sheet 分页、冻结首行表头、自动筛选下拉箭头；
 * - 按中英文混合视觉宽度精确自动计算最佳列宽（彻底消除截断及 `###` / `1E+08` 科学计数法）；
 * - 原生数字格式（整数千分位 `#,##0`、货币 `$#,##0.00` / `$#,##0.0000`、原生百分比 `0.0%`、小数 `#,##0.0`）；
 * - 专业视觉样式（深石板蓝表头、斑马纹、汇总高亮、异常红底警示、压缩蓝底提示）；
 * - 全部字符串采用 `inlineStr` 并剔除 XML 1.0 非法控制符，天然免疫公式注入及 Excel 损坏警告。
 */

const INVALID_XML_CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
const INVALID_SHEET_NAME_RE = /[\\/?*[\]:]/g;

// --- 样式索引常量（对应下方 STYLES_XML 中的 cellXfs 顺序） ---
const STYLE_TEXT_LEFT = 1;
const STYLE_TEXT_LEFT_ALT = 2;
const STYLE_TEXT_CENTER = 3;
const STYLE_TEXT_CENTER_ALT = 4;
const STYLE_TEXT_RIGHT = 5;
const STYLE_TEXT_RIGHT_ALT = 6;
const STYLE_INT = 7;
const STYLE_INT_ALT = 8;
const STYLE_DEC1 = 9;
const STYLE_DEC1_ALT = 10;
const STYLE_DEC2 = 11;
const STYLE_DEC2_ALT = 12;
const STYLE_PCT = 13;
const STYLE_PCT_ALT = 14;
const STYLE_USD2 = 15;
const STYLE_USD2_ALT = 16;
const STYLE_USD4 = 17;
const STYLE_USD4_ALT = 18;
const STYLE_HEADER_LEFT = 19;
const STYLE_HEADER_CENTER = 20;
const STYLE_HEADER_RIGHT = 21;
const STYLE_DANGER_TEXT = 22;
const STYLE_DANGER_CENTER = 23;
const STYLE_DANGER_INT = 24;
const STYLE_DANGER_DEC1 = 25;
const STYLE_DANGER_DEC2 = 26;
const STYLE_DANGER_PCT = 27;
const STYLE_DANGER_USD4 = 28;
const STYLE_INFO_TEXT = 29;
const STYLE_INFO_CENTER = 30;
const STYLE_INFO_INT = 31;
const STYLE_INFO_DEC1 = 32;
const STYLE_INFO_DEC2 = 33;
const STYLE_INFO_PCT = 34;
const STYLE_INFO_USD4 = 35;
const STYLE_SUMMARY_LABEL = 36;
const STYLE_SUMMARY_CENTER = 37;
const STYLE_SUMMARY_TEXT_RIGHT = 38;
const STYLE_SUMMARY_INT = 39;
const STYLE_SUMMARY_DEC1 = 40;
const STYLE_SUMMARY_DEC2 = 41;
const STYLE_SUMMARY_PCT = 42;
const STYLE_SUMMARY_USD2 = 43;
const STYLE_SUMMARY_USD4 = 44;

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function computeCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeUtf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(String(str ?? ''));
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(String(str ?? ''), 'utf8'));
  }
  const s = unescape(encodeURIComponent(String(str ?? '')));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * 将 `Uint8Array` 编码为标准 Base64 字符串（兼容浏览器及 Node 环境）。
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * 标准零依赖 ZIP STORE 打包器（用于生成严格合规的 `.xlsx` OOXML 容器）。
 *
 * @param {Array<{ name: string, data: Uint8Array | string }>} entries
 * @returns {Uint8Array}
 */
function buildZipStoreArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const nameBytes = encodeUtf8Bytes(entries[i].name);
    const dataBytes =
      entries[i].data instanceof Uint8Array
        ? entries[i].data
        : encodeUtf8Bytes(entries[i].data);
    const crc = computeCrc32(dataBytes);
    const size = dataBytes.length;

    // Local File Header (30 bytes + filename + data)
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // compression: STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x5821, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, dataBytes);

    // Central Directory Header (46 bytes + filename)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5821, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + dataBytes.length;
  }

  let cdSize = 0;
  for (let i = 0; i < centralParts.length; i += 1) cdSize += centralParts[i].length;

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLen = offset + cdSize + eocd.length;
  const archive = new Uint8Array(totalLen);
  let pos = 0;
  for (let i = 0; i < localParts.length; i += 1) {
    archive.set(localParts[i], pos);
    pos += localParts[i].length;
  }
  for (let i = 0; i < centralParts.length; i += 1) {
    archive.set(centralParts[i], pos);
    pos += centralParts[i].length;
  }
  archive.set(eocd, pos);
  return archive;
}

function escapeXmlText(val) {
  return String(val ?? '')
    .replace(INVALID_XML_CTRL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnIndexToLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 估算文本在 Excel 单元格中的视觉字符宽度（中文/全角约占 2.05 宽，ASCII 约 1.05 宽）。
 */
function measureExcelVisualWidth(str) {
  const s = String(str ?? '').replace(/\r?\n/g, ' ');
  let w = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      w += 2.05;
    } else {
      w += 1.05;
    }
  }
  return w;
}

function estimateFormattedValueWidth(val, colType) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (colType === 'int') {
      return Math.round(val).toLocaleString('en-US').length * 1.1;
    }
    if (colType === 'usd2') {
      return (`$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).length * 1.1;
    }
    if (colType === 'usd4') {
      return (`$${val.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`).length * 1.1;
    }
    if (colType === 'pct') {
      return (`${(val * 100).toFixed(1)}%`).length * 1.1;
    }
    if (colType === 'dec1') {
      return (`${val.toFixed(1)}`).length * 1.1;
    }
    if (colType === 'dec2') {
      return (`${val.toFixed(2)}`).length * 1.1;
    }
  }
  return measureExcelVisualWidth(String(val));
}

function sanitizeSheetName(rawName, usedNames) {
  const base =
    String(rawName || 'Sheet')
      .replace(INVALID_XML_CTRL_RE, '')
      .replace(INVALID_SHEET_NAME_RE, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 31) || 'Sheet';
  let name = base;
  let seq = 2;
  while (usedNames.has(name.toLowerCase())) {
    const suffix = ` ${seq}`;
    name = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    seq += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

function resolveHeaderStyle(col) {
  const align =
    col.align ||
    (col.type === 'center'
      ? 'center'
      : col.type && col.type !== 'text'
        ? 'right'
        : 'left');
  if (align === 'center') return STYLE_HEADER_CENTER;
  if (align === 'right') return STYLE_HEADER_RIGHT;
  return STYLE_HEADER_LEFT;
}

function resolveCellStyle(col, isAlt, rowTone) {
  const colType = col.type || 'text';
  if (rowTone === 'summary') {
    if (colType === 'center') return STYLE_SUMMARY_CENTER;
    if (colType === 'int') return STYLE_SUMMARY_INT;
    if (colType === 'dec1') return STYLE_SUMMARY_DEC1;
    if (colType === 'dec2') return STYLE_SUMMARY_DEC2;
    if (colType === 'pct') return STYLE_SUMMARY_PCT;
    if (colType === 'usd2') return STYLE_SUMMARY_USD2;
    if (colType === 'usd4') return STYLE_SUMMARY_USD4;
    if (colType === 'text_right' || col.align === 'right') return STYLE_SUMMARY_TEXT_RIGHT;
    return STYLE_SUMMARY_LABEL;
  }
  if (rowTone === 'danger') {
    if (colType === 'center') return STYLE_DANGER_CENTER;
    if (colType === 'int') return STYLE_DANGER_INT;
    if (colType === 'dec1') return STYLE_DANGER_DEC1;
    if (colType === 'dec2') return STYLE_DANGER_DEC2;
    if (colType === 'pct') return STYLE_DANGER_PCT;
    if (colType === 'usd2' || colType === 'usd4') return STYLE_DANGER_USD4;
    return STYLE_DANGER_TEXT;
  }
  if (rowTone === 'info') {
    if (colType === 'center') return STYLE_INFO_CENTER;
    if (colType === 'int') return STYLE_INFO_INT;
    if (colType === 'dec1') return STYLE_INFO_DEC1;
    if (colType === 'dec2') return STYLE_INFO_DEC2;
    if (colType === 'pct') return STYLE_INFO_PCT;
    if (colType === 'usd2' || colType === 'usd4') return STYLE_INFO_USD4;
    return STYLE_INFO_TEXT;
  }
  if (colType === 'center') return isAlt ? STYLE_TEXT_CENTER_ALT : STYLE_TEXT_CENTER;
  if (colType === 'text_right') return isAlt ? STYLE_TEXT_RIGHT_ALT : STYLE_TEXT_RIGHT;
  if (colType === 'int') return isAlt ? STYLE_INT_ALT : STYLE_INT;
  if (colType === 'dec1') return isAlt ? STYLE_DEC1_ALT : STYLE_DEC1;
  if (colType === 'dec2') return isAlt ? STYLE_DEC2_ALT : STYLE_DEC2;
  if (colType === 'pct') return isAlt ? STYLE_PCT_ALT : STYLE_PCT;
  if (colType === 'usd2') return isAlt ? STYLE_USD2_ALT : STYLE_USD2;
  if (colType === 'usd4') return isAlt ? STYLE_USD4_ALT : STYLE_USD4;
  return isAlt ? STYLE_TEXT_LEFT_ALT : STYLE_TEXT_LEFT;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="6">
    <numFmt numFmtId="164" formatCode="#,##0"/>
    <numFmt numFmtId="165" formatCode="#,##0.0"/>
    <numFmt numFmtId="166" formatCode="#,##0.00"/>
    <numFmt numFmtId="167" formatCode="$#,##0.00"/>
    <numFmt numFmtId="168" formatCode="$#,##0.0000"/>
    <numFmt numFmtId="169" formatCode="0.0%"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="10"/><color rgb="FF1E293B"/><name val="Microsoft YaHei UI"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei UI"/></font>
    <font><sz val="10"/><color rgb="FFB91C1C"/><name val="Microsoft YaHei UI"/></font>
    <font><sz val="10"/><color rgb="FF0369A1"/><name val="Microsoft YaHei UI"/></font>
    <font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Microsoft YaHei UI"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF2F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF0F9FF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/></patternFill></fill>
  </fills>
  <borders count="4">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
      <diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FF334155"/></left>
      <right style="thin"><color rgb="FF334155"/></right>
      <top style="thin"><color rgb="FF334155"/></top>
      <bottom style="medium"><color rgb="FF0F172A"/></bottom>
      <diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FF94A3B8"/></top>
      <bottom style="medium"><color rgb="FF475569"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="45">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="169" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="169" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="167" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="168" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="169" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="168" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="169" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="168" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="6" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="6" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="6" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="169" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="167" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="168" fontId="4" fillId="6" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;
}

function buildWorksheetXml(sheet, isFirstSheet) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const hasAutoFilter = sheet.autoFilter !== false;
  const headerPad = hasAutoFilter ? 5.5 : 3.8;
  const colWidths = columns.map((col) => {
    const headerW = measureExcelVisualWidth(col.header || '') + headerPad;
    return Math.max(Number(col.minWidth || 9), headerW);
  });

  const rowXmls = [];
  // Row 1: Header
  const headerCells = [];
  for (let c = 0; c < columns.length; c += 1) {
    const ref = `${columnIndexToLetter(c)}1`;
    const styleId = resolveHeaderStyle(columns[c]);
    headerCells.push(
      `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t xml:space="preserve">${escapeXmlText(columns[c].header || '')}</t></is></c>`
    );
  }
  rowXmls.push(`<row r="1" ht="26" customHeight="1">${headerCells.join('')}</row>`);

  // Data Rows
  for (let r = 0; r < rows.length; r += 1) {
    const rowObj = rows[r];
    const rowValues = Array.isArray(rowObj) ? rowObj : Array.isArray(rowObj?.values) ? rowObj.values : [];
    const rowTone = !Array.isArray(rowObj) && rowObj?.tone ? rowObj.tone : '';
    const isAlt = r % 2 === 1;
    const excelRowIdx = r + 2;
    const cellXmls = [];

    for (let c = 0; c < columns.length; c += 1) {
      const col = columns[c];
      const rawVal = rowValues[c];
      const ref = `${columnIndexToLetter(c)}${excelRowIdx}`;
      const isCellObj = rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal);
      const val = isCellObj ? rawVal.value : rawVal;
      const cellCol = isCellObj && rawVal.type ? { ...col, type: rawVal.type } : col;
      const styleId = resolveCellStyle(cellCol, isAlt, rowTone);

      const estW = estimateFormattedValueWidth(val, cellCol.type) + 3.8;
      const maxW = Number(col.maxWidth || 52);
      if (estW > colWidths[c]) {
        colWidths[c] = Math.min(maxW, estW);
      }

      if (val === null || val === undefined || val === '') {
        cellXmls.push(`<c r="${ref}" s="${styleId}"/>`);
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        cellXmls.push(`<c r="${ref}" s="${styleId}"><v>${val}</v></c>`);
      } else {
        const textVal = String(val);
        cellXmls.push(
          `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t xml:space="preserve">${escapeXmlText(textVal)}</t></is></c>`
        );
      }
    }
    const rowHeight = rowTone === 'summary' ? 24 : 21;
    rowXmls.push(`<row r="${excelRowIdx}" ht="${rowHeight}" customHeight="1">${cellXmls.join('')}</row>`);
  }

  const colsXml = columns
    .map((_, idx) => {
      const w = Math.max(8, Math.min(64, +colWidths[idx].toFixed(1)));
      return `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`;
    })
    .join('');

  const lastCol = columnIndexToLetter(Math.max(0, columns.length - 1));
  const lastRow = Math.max(1, rows.length + 1);
  // 若末尾包含合计行，自动筛选区自动排除合计行，避免按列排序时把合计行混入明细
  let filterEndRow = lastRow;
  while (filterEndRow > 1) {
    const tailRow = rows[filterEndRow - 2];
    if (tailRow && !Array.isArray(tailRow) && tailRow.tone === 'summary') {
      filterEndRow -= 1;
    } else {
      break;
    }
  }
  const autoFilterXml =
    hasAutoFilter && columns.length > 0 && filterEndRow > 1
      ? `<autoFilter ref="A1:${lastCol}${filterEndRow}"/>`
      : '';
  const tabSel = isFirstSheet ? ' tabSelected="1"' : '';
  const freezeXml =
    sheet.freezeHeader !== false
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews><sheetView${tabSel} workbookViewId="0">${freezeXml}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="21"/>
  <cols>${colsXml}</cols>
  <sheetData>${rowXmls.join('')}</sheetData>
  ${autoFilterXml}
</worksheet>`;
}

/**
 * 将结构化多工作表数据编译为标准 `.xlsx` 二进制字节流 (`Uint8Array`)。
 *
 * @param {Array<{
 *   name: string,
 *   columns: Array<{ header: string, type?: 'text'|'center'|'int'|'dec1'|'dec2'|'pct'|'usd2'|'usd4', align?: 'left'|'center'|'right', minWidth?: number, maxWidth?: number }>,
 *   rows: Array<Array<unknown> | { values: Array<unknown>, tone?: ''|'danger'|'info'|'summary' }>,
 *   autoFilter?: boolean,
 *   freezeHeader?: boolean,
 * }>} sheets
 * @returns {Uint8Array}
 */
export function buildXlsxWorkbookBytes(sheets) {
  const validSheets = (Array.isArray(sheets) ? sheets : []).filter(
    (s) => s && Array.isArray(s.columns) && s.columns.length > 0
  );
  if (validSheets.length === 0) {
    validSheets.push({
      name: 'Sheet1',
      columns: [{ header: 'Empty', type: 'text', minWidth: 14 }],
      rows: [],
    });
  }

  const usedNames = new Set();
  const normalizedSheets = validSheets.map((s) => ({
    ...s,
    safeName: sanitizeSheetName(s.name, usedNames),
  }));

  const contentOverrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...normalizedSheets.map(
      (_, idx) =>
        `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ),
  ].join('');

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${contentOverrides}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbSheetsXml = normalizedSheets
    .map(
      (s, idx) =>
        `<sheet name="${escapeXmlText(s.safeName)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
    )
    .join('');

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${wbSheetsXml}</sheets>
</workbook>`;

  const wbRelsList = [
    ...normalizedSheets.map(
      (_, idx) =>
        `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
    ),
    `<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ].join('');

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${wbRelsList}
</Relationships>`;

  const archiveEntries = [
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRelsXml },
    { name: 'xl/styles.xml', data: buildStylesXml() },
    ...normalizedSheets.map((s, idx) => ({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: buildWorksheetXml(s, idx === 0),
    })),
  ];

  return buildZipStoreArchive(archiveEntries);
}
