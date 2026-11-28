import { inflateRawSync } from 'node:zlib';
import { ValidationError } from '../core/errors.ts';

/**
 * Reading an Excel workbook (.xlsx) without a library: an .xlsx file is a zip
 * of XML parts. Only what an import needs is read: the sheets' names, and the
 * cell values of one sheet as text (numbers as Excel stores them, dates as
 * YYYY-MM-DD, formulas as their last computed value). Formatting is ignored.
 */

const MAX_UNZIPPED = 200 * 1_048_576;

/** The files in a zip, by name (stored or deflated entries only). */
function unzip(buf: Buffer): Map<string, () => Buffer> {
  // The end of central directory record is in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ValidationError('this is not an Excel workbook (.xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, () => Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ValidationError('the workbook is damaged');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    total += size;
    if (total > MAX_UNZIPPED) throw new ValidationError('the workbook is too large; save the sheet as CSV or split it');
    files.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new ValidationError('the workbook is damaged');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      throw new ValidationError('the workbook uses a compression BAATS cannot read; save it again in Excel');
    });
  }
  return files;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (XML_ENTITIES[e] ?? m));
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]) : undefined; };
/** The text of all <t> elements inside a string item (rich text has several runs; phonetic runs are skipped). */
const textOf = (si: string) => [...si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((m) => unescape(m[1] ?? '')).join('');

/** Built-in number formats that are dates (Excel's numbering), and custom ones are recognised by their pattern. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDatePattern = (code: string) => /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^[#0.,%E+-]+$/i.test(code);

/** An Excel date number as YYYY-MM-DD (the 1900 system, with Excel's leap-year bug). */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Workbook { sheets: string[]; read(sheet?: string): string[][] }

/** Open a workbook: its sheet names, and a reader for the rows of one sheet (the first by default). */
export function openXlsx(buf: Buffer): Workbook {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new ValidationError(buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
      ? 'this is an old Excel file (.xls); open it in Excel and save it as .xlsx or CSV'
      : 'this is not an Excel workbook (.xlsx)');
  }
  const files = unzip(buf);
  const part = (name: string) => files.get(name)?.().toString('utf8');
  const wb = part('xl/workbook.xml');
  if (!wb) throw new ValidationError('this is not an Excel workbook (.xlsx)');
  const rels = new Map([...(part('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(attr(m[0], 'r:id')) ?? '';
    return { name: attr(m[0], 'name') ?? '', path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`, hidden: attr(m[0], 'state') !== undefined && attr(m[0], 'state') !== 'visible' };
  }).filter((s) => !s.hidden);
  if (!sheets.length) throw new ValidationError('the workbook has no sheets');
  let shared: string[] | null = null;
  let dateStyles: boolean[] | null = null;
  const load = () => {
    shared = [...(part('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textOf(m[1] ?? ''));
    const st = part('xl/styles.xml') ?? '';
    const custom = new Map([...st.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '']));
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st)?.[1] ?? '';
    dateStyles = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
      const id = Number(attr(m[0], 'numFmtId') ?? 0);
      return DATE_FORMATS.has(id) || (custom.has(id) && isDatePattern(custom.get(id)!));
    });
  };
  return {
    sheets: sheets.map((s) => s.name),
    read(name?: string) {
      const s = name === undefined ? sheets[0] : sheets.find((x) => x.name === name);
      if (!s) throw new ValidationError(`the workbook has no sheet "${name}"; it has ${sheets.map((x) => `"${x.name}"`).join(', ')}`);
      if (!shared) load();
      const xml = part(s.path);
      if (xml === undefined) throw new ValidationError('the workbook is damaged');
      const rows: string[][] = [];
      for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
        const rowNo = Number(attr(r[1] ?? r[3], 'r')) || rows.length + 1;
        const cells: string[] = [];
        for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attr(c[1], 'r');
          const col = ref ? colIndex(ref) : cells.length;
          const type = attr(c[1], 't') ?? 'n';
          const body = c[2] ?? '';
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          let value = '';
          if (type === 's') value = shared![Number(v)] ?? '';
          else if (type === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
          else if (type === 'str' || type === 'e') value = type === 'e' ? '' : unescape(v ?? '');
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'd') value = (v ?? '').slice(0, 10);
          else if (v !== undefined) {
            const n = Number(v);
            value = dateStyles![Number(attr(c[1], 's') ?? 0)] && Number.isFinite(n) && n >= 1 && n < 2_958_466 ? excelDate(n) : v;
          }
          cells[col] = value;
        }
        while (rows.length < rowNo - 1) rows.push([]);
        rows.push(Array.from(cells, (x) => x ?? ''));
      }
      // Trailing empty rows (formatted but empty) are not data.
      while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
      // Every row as wide as the widest, as a CSV export would be.
      const w = Math.max(0, ...rows.map((r) => r.length));
      return rows.map((r) => (r.length < w ? [...r, ...Array(w - r.length).fill('')] : r));
    },
  };
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
  return n - 1;
}

/** Rows as CSV text, so a workbook goes through exactly the same checks as a CSV file. */
export function rowsToCsv(rows: string[][]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
