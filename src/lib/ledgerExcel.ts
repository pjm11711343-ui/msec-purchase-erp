// 월별 품목 엑셀 내보내기 (서식 포함, exceljs는 필요할 때만 불러옴)
import type ExcelJS from 'exceljs';
import { computePivot, mLong, type LRow, type Pivot } from './ledgerData';

const NAVY = 'FF0A1220';
const HD = 'FFDCE6F2';
const TOT = 'FFFCE4B6';
const LINE = 'FFD5DAE3';
const NF = '#,##0;[Red]-#,##0;""';
const NFQ = '#,##0.##;[Red]-#,##0.##;""';

const border = { top: { style: 'thin', color: { argb: LINE } }, left: { style: 'thin', color: { argb: LINE } }, bottom: { style: 'thin', color: { argb: LINE } }, right: { style: 'thin', color: { argb: LINE } } } as ExcelJS.Borders;
const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as ExcelJS.Fill;

async function newBook() {
  const { default: Excel } = await import('exceljs');
  return new Excel.Workbook();
}

async function download(wb: ExcelJS.Workbook, name: string) {
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function title(ws: ExcelJS.Worksheet, text: string, sub: string, lastCol: number) {
  ws.mergeCells(1, 1, 1, lastCol);
  const t = ws.getCell(1, 1);
  t.value = text;
  t.font = { size: 15, bold: true, color: { argb: NAVY } };
  ws.mergeCells(2, 1, 2, lastCol);
  const s = ws.getCell(2, 1);
  s.value = sub;
  s.font = { size: 9, color: { argb: 'FF6B7587' } };
  ws.getRow(1).height = 24;
}

/* ───── 월별 품목 리스트 엑셀 ('계산서 월별 품목 관리' 도구와 같은 양식) ─────
 *  [분류 요약] (분류 이름을 누르면 그 시트로) + [전체] + 분류별 시트
 *  월마다 수량·단가·금액·공정 4칸, 단가가 전월보다 오르면 빨강·내리면 파랑
 *  A4 가로·너비 한 장·머리글 반복·쪽번호·출력일, 틀 고정, 눈금선 숨김
 *  단가(금액)가 없는 달은 수량도 비움 (계산서 0원·미발행분) */
const C = {
  navy: 'FF0A1220',
  ink: 'FF1B2433',
  mut: 'FF6B7587',
  hd: 'FFDCE6F2',
  hd2: 'FFEDF2F9',
  hdLine: 'FFB7C3D6',
  g0: 'FFDCE2EC',
  g1: 'FFEDF0F5',
  zebra: 'FFF7F9FC',
  white: 'FFFFFFFF',
  amber: 'FFE8A33D',
  amberL: 'FFFEF6E7',
  amberT: 'FF8A5A10',
  totHd: 'FFFCE4B6',
  totHd2: 'FFFDEFD3',
  totLine: 'FFE3B873',
  tot: 'FFFFF4CC',
  totT: 'FFB45309',
  up: 'FFC2410C',
  down: 'FF2563EB',
  proc: 'FF5B6B82',
};
const FONT = '맑은 고딕';
const bd = (argb = LINE): ExcelJS.Border => ({ style: 'thin', color: { argb } });
const box = (argb = LINE) => ({ top: bd(argb), left: bd(argb), bottom: bd(argb), right: bd(argb) }) as ExcelJS.Borders;
interface St {
  sz?: number;
  b?: boolean;
  fc?: string;
  fill?: string;
  h?: 'left' | 'center' | 'right';
  nf?: string;
  bc?: string;
  nb?: boolean;
  ind?: number;
  topAmber?: boolean;
  wrap?: boolean;
}
function put(ws: ExcelJS.Worksheet, r: number, c: number, v: string | number | null | undefined, o: St = {}) {
  const cell = ws.getCell(r, c);
  cell.value = v === '' || v == null ? null : v;
  cell.font = { name: FONT, size: o.sz ?? 10, bold: !!o.b, color: { argb: o.fc ?? C.ink } };
  cell.alignment = { vertical: 'middle', horizontal: o.h ?? 'left', indent: o.ind ?? 0, wrapText: !!o.wrap };
  if (!o.nb) cell.border = { ...box(o.bc), ...(o.topAmber ? { top: { style: 'medium', color: { argb: C.amber } } } : {}) };
  if (o.fill) cell.fill = fill(o.fill);
  if (o.nf) cell.numFmt = o.nf;
  return cell;
}
const nfQ = (v: number) => (Math.round(v) === v ? NF : '#,##0.00;[Red]-#,##0.00;""');
/** 화면 글자 폭 (한글 2칸) */
const dispLen = (v: unknown) => {
  if (v == null || v === '') return 0;
  const t = typeof v === 'number' ? v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : String(v);
  let n = 0;
  for (const ch of t) n += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2.1 : 1.05;
  return n;
};
function widths(ws: ExcelJS.Worksheet, fromRow: number, min: Record<number, number> = {}, max = 60) {
  const w: Record<number, number> = {};
  ws.eachRow((row, rn) => {
    if (rn < fromRow) return;
    row.eachCell((cell, cn) => {
      if (cell.isMerged && cell.master !== cell) return;
      w[cn] = Math.max(w[cn] ?? 0, dispLen(cell.value));
    });
  });
  const n = ws.columnCount;
  for (let c = 1; c <= n; c++) ws.getColumn(c).width = Math.min(max, Math.max(min[c] ?? 6, (w[c] ?? 0) + 2.5));
}
function sheetSetup(ws: ExcelJS.Worksheet, headRows: [number, number], freeze: { r: number; c: number }) {
  ws.views = [{ state: 'frozen', xSplit: freeze.c, ySplit: freeze.r, showGridLines: false, zoomScale: 100 }];
  ws.properties.tabColor = { argb: C.amber };
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headRows[0]}:${headRows[1]}`, margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.55, header: 0.25, footer: 0.25 } };
  ws.headerFooter = { oddFooter: `&L&8명신기공 자재부&C&8&P / &N&R&8출력 ${new Date().toLocaleDateString('sv-SE')}` };
}
function titleRows(ws: ExcelJS.Worksheet, title: string, sub: string, lastC: number) {
  put(ws, 1, 1, title, { sz: 16, b: true, fc: C.navy, nb: true });
  put(ws, 2, 1, sub, { sz: 9, fc: C.mut, nb: true });
  for (let c = 1; c <= lastC; c++) ws.getCell(3, c).border = { bottom: { style: 'medium', color: { argb: C.amber } } };
  ws.getRow(1).height = 30;
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 6;
}
function sheetName(n: string, used: Set<string>) {
  const b = String(n || '미분류').replace(/[\\/?*[\]:]/g, '_').slice(0, 28) || '시트';
  let x = b;
  for (let i = 2; used.has(x); i++) x = `${b.slice(0, 26)}(${i})`;
  used.add(x);
  return x;
}

/** 한 시트 분량의 월별 품목 리스트 */
function pivotSheet(ws: ExcelJS.Worksheet, pv: Pivot, months: string[], title: string, sub: string, siteFixed: boolean, catFixed: boolean) {
  const { gk, groups, pre } = pv;
  const xs = !gk.includes('site') && !siteFixed;
  const xc = !gk.includes('cat') && !catFixed;
  const xv = !gk.includes('vendor');
  const fixed = ['품목', '규격', '단위', ...(xs ? ['현장'] : []), ...(xc ? ['분류'] : []), ...(xv ? ['업체'] : [])];
  const nF = fixed.length;
  const cT = nF + 1; // 합계 (1부터)
  const cM = nF + 3; // 첫 달
  const MC = 4;
  const lastC = cM + months.length * MC - 1;
  titleRows(ws, title, sub, lastC);
  const H1 = 4;
  const H2 = 5;
  const hs: St = { b: true, fill: C.hd, h: 'center', bc: C.hdLine };
  const hs2: St = { sz: 9, fc: 'FF3C4658', fill: C.hd2, h: 'center', bc: C.hdLine };
  fixed.forEach((t, i) => {
    put(ws, H1, i + 1, t, hs);
    put(ws, H2, i + 1, '', hs);
    ws.mergeCells(H1, i + 1, H2, i + 1);
  });
  put(ws, H1, cT, '합  계', { b: true, fc: C.navy, fill: C.totHd, h: 'center', bc: C.totLine });
  put(ws, H1, cT + 1, '', { fill: C.totHd, bc: C.totLine });
  ws.mergeCells(H1, cT, H1, cT + 1);
  put(ws, H2, cT, '수량', { sz: 9, b: true, fc: C.navy, fill: C.totHd2, h: 'center', bc: C.totLine });
  put(ws, H2, cT + 1, '금액', { sz: 9, b: true, fc: C.navy, fill: C.totHd2, h: 'center', bc: C.totLine });
  months.forEach((m, i) => {
    const c = cM + i * MC;
    put(ws, H1, c, mLong(m), hs);
    for (let j = 1; j < MC; j++) put(ws, H1, c + j, '', hs);
    ws.mergeCells(H1, c, H1, c + MC - 1);
    ['수량', '단가', '금액', '공정'].forEach((t, j) => put(ws, H2, c + j, t, hs2));
  });
  ws.getRow(H1).height = 22;
  let r = H2 + 1;
  const TA: Record<string, number> = {};
  let GT = 0;
  const sec = (L: number, label: string, p: { n: number; ta: number; mt: Record<string, number> }) => {
    const f = L === 0 ? C.g0 : C.g1;
    put(ws, r, 1, `${L === 0 ? '■ ' : '▸ '}${label}   (${p.n}품목)`, { b: true, fill: f, fc: L === 0 ? C.navy : 'FF2B3950', ind: L });
    for (let c = 2; c <= nF; c++) put(ws, r, c, '', { fill: f });
    if (nF > 1) ws.mergeCells(r, 1, r, nF);
    put(ws, r, cT, '', { fill: f, b: true });
    put(ws, r, cT + 1, Math.round(p.ta), { fill: f, b: true, h: 'right', nf: NF, fc: C.navy });
    months.forEach((m, i) => {
      const c = cM + i * MC;
      put(ws, r, c, '', { fill: f });
      put(ws, r, c + 1, '', { fill: f });
      put(ws, r, c + 2, Math.round(p.mt[m] ?? 0) || null, { fill: f, b: true, h: 'right', nf: NF, fc: C.navy });
      put(ws, r, c + 3, '', { fill: f });
    });
    r++;
  };
  let prev: string[] = [];
  let z = 0;
  for (const g of groups) {
    let d = 0;
    while (d < g.path.length && g.path[d] === prev[d]) d++;
    for (let L = d; L < g.path.length; L++) sec(L, g.path[L], pre.get(g.path.slice(0, L + 1).join('\u0001'))!);
    prev = g.path;
    for (const it of g.list) {
      const f = z++ % 2 ? C.zebra : C.white;
      const vals = [it.item, it.spec, it.unit, ...(xs ? [[...it.sites].join(', ')] : []), ...(xc ? [it.cat] : []), ...(xv ? [[...it.vendors].join(', ')] : [])];
      vals.forEach((v, i) => put(ws, r, i + 1, v, { fill: f, b: i === 0, h: i === 2 ? 'center' : 'left' }));
      const tq = months.reduce((t, m) => {
        const x = it.cells[m];
        return t + (x && x.a ? x.q : 0);
      }, 0);
      put(ws, r, cT, tq || null, { fill: C.amberL, h: 'right', nf: nfQ(tq) });
      put(ws, r, cT + 1, Math.round(it.ta) || null, { fill: C.amberL, h: 'right', b: true, nf: NF });
      let pp = 0;
      months.forEach((m, i) => {
        const c = cM + i * MC;
        const x = it.cells[m];
        const ok = !!(x && x.a);
        const p = ok && x.q ? x.a / x.q : 0;
        let pfc = C.amberT;
        if (p && pp && Math.abs(p - pp) / pp > 0.001) pfc = p > pp ? C.up : C.down;
        put(ws, r, c, ok ? x.q : null, { fill: f, h: 'right', nf: nfQ(ok ? x.q : 0) });
        put(ws, r, c + 1, p ? Math.round(p) : null, { fill: f, h: 'right', fc: pfc, sz: 9, nf: NF });
        put(ws, r, c + 2, ok ? Math.round(x.a) : null, { fill: f, h: 'right', nf: NF });
        put(ws, r, c + 3, ok && x.ps?.size ? [...x.ps].join(' · ') : '', { fill: f, sz: 9, fc: C.proc });
        if (x) {
          TA[m] = (TA[m] ?? 0) + x.a;
          if (p) pp = p;
        }
      });
      GT += it.ta;
      r++;
    }
  }
  const ts: St = { b: true, fill: C.tot, bc: C.hdLine, topAmber: true };
  put(ws, r, 1, '총  합  계', ts);
  for (let c = 2; c <= nF; c++) put(ws, r, c, '', ts);
  if (nF > 1) ws.mergeCells(r, 1, r, nF);
  put(ws, r, cT, '', ts);
  put(ws, r, cT + 1, Math.round(GT), { ...ts, fc: C.totT, h: 'right', nf: NF });
  months.forEach((m, i) => {
    const c = cM + i * MC;
    put(ws, r, c, '', ts);
    put(ws, r, c + 1, '', ts);
    put(ws, r, c + 2, Math.round(TA[m] ?? 0), { ...ts, fill: C.hd, h: 'right', nf: NF });
    put(ws, r, c + 3, '', ts);
  });
  const min: Record<number, number> = { [cT]: 8, [cT + 1]: 13 };
  months.forEach((_, i) => (min[cM + i * MC + 3] = 24));
  widths(ws, H1, min);
  months.forEach((_, i) => (ws.getColumn(cM + i * MC + 3).width = 24)); // 공정 열 폭 고정
  sheetSetup(ws, [H1, H2], { r: H2, c: 2 });
}

/** 월별 품목 리스트 엑셀: 분류 요약 + 전체 + 분류별 */
export async function exportPivotXlsx(
  rows: LRow[],
  canon: Map<string, string>,
  groupBy: string,
  opts: { site?: string; cond: string; fileName: string },
): Promise<number> {
  if (!rows.length) throw new Error('내보낼 자료가 없습니다.');
  const wb = await newBook();
  const months = [...new Set(rows.map((r) => r.m))].sort();
  const gbCat = (groupBy === 'none' ? [] : groupBy.split('>')).filter((k) => k !== 'cat');
  const gbC = gbCat.length ? gbCat.join('>') : opts.site ? 'none' : 'site';
  const cmpKo = (a: string, b: string) => a.localeCompare(b, 'ko', { numeric: true });
  const cats = [...new Set(rows.map((r) => r.cat))].sort(cmpKo);
  const sites = [...new Set(rows.map((r) => r.site))];
  const TTL = opts.site || (sites.length === 1 ? sites[0] : '월별 품목 리스트');
  const used = new Set(['분류 요약', '전체']);
  const catSheets = cats.map((c) => ({ cat: c, name: sheetName(c, used), rows: rows.filter((r) => r.cat === c) }));

  // 1) 분류 요약
  const sum = wb.addWorksheet('분류 요약');
  const lastC = 4 + months.length;
  titleRows(sum, `${TTL} — 분류 요약`, opts.cond, lastC);
  const H = 4;
  const hs: St = { b: true, fill: C.hd, h: 'center', bc: C.hdLine };
  ['분류', '품목 수', '현장 수', ...months.map(mLong), '합  계'].forEach((t, i) => put(sum, H, i + 1, t, i + 1 === lastC ? { b: true, fc: C.navy, fill: C.totHd, h: 'center', bc: C.totLine } : hs));
  sum.getRow(H).height = 24;
  let r = H + 1;
  const MT: Record<string, number> = {};
  let GT = 0;
  catSheets.forEach((cs, i) => {
    const f = i % 2 ? C.zebra : C.white;
    const mt: Record<string, number> = {};
    let t = 0;
    for (const x of cs.rows) {
      mt[x.m] = (mt[x.m] ?? 0) + x.amt;
      t += x.amt;
    }
    const cell = put(sum, r, 1, cs.cat, { fill: f, b: true, fc: 'FF1D4ED8' });
    cell.value = { text: cs.cat, hyperlink: `#'${cs.name}'!A1`, tooltip: `${cs.cat} 시트로 이동` };
    put(sum, r, 2, new Set(cs.rows.map((x) => x.ik)).size, { fill: f, h: 'center' });
    put(sum, r, 3, new Set(cs.rows.map((x) => x.site)).size, { fill: f, h: 'center' });
    months.forEach((m, j) => {
      put(sum, r, 4 + j, Math.round(mt[m] ?? 0) || null, { fill: f, h: 'right', nf: NF });
      MT[m] = (MT[m] ?? 0) + (mt[m] ?? 0);
    });
    put(sum, r, lastC, Math.round(t), { fill: C.amberL, b: true, h: 'right', nf: NF });
    GT += t;
    r++;
  });
  const ts: St = { b: true, fill: C.tot, bc: C.hdLine, topAmber: true };
  put(sum, r, 1, '합  계', ts);
  put(sum, r, 2, new Set(rows.map((x) => x.ik)).size, { ...ts, fill: C.hd, h: 'center' });
  put(sum, r, 3, new Set(rows.map((x) => x.site)).size, { ...ts, fill: C.hd, h: 'center' });
  months.forEach((m, j) => put(sum, r, 4 + j, Math.round(MT[m] ?? 0), { ...ts, h: 'right', nf: NF }));
  put(sum, r, lastC, Math.round(GT), { ...ts, fc: C.totT, h: 'right', nf: NF });
  put(sum, r + 2, 1, '※ 분류 이름을 누르면 해당 분류 시트로 이동합니다.', { sz: 9, fc: C.mut, nb: true });
  widths(sum, H, { 1: 14 });
  sheetSetup(sum, [H, H], { r: H, c: 1 });

  // 2) 전체
  pivotSheet(wb.addWorksheet('전체'), computePivot(rows, groupBy, canon), months, `${TTL} — 전체`, opts.cond, !!opts.site, false);
  // 3) 분류별
  for (const cs of catSheets)
    pivotSheet(wb.addWorksheet(cs.name), computePivot(cs.rows, gbC, canon), months, `${TTL} — ${cs.cat}`, opts.cond.replace(/분류: [^·]+·/, `분류: ${cs.cat}  ·`), !!opts.site, true);
  await download(wb, opts.fileName);
  return catSheets.length;
}

/** 표 여러 개를 서식 있는 시트로 (첫 줄 머리글, 숫자는 천 단위) */
export async function exportTablesXlsx(sheets: { name: string; title: string; sub?: string; aoa: (string | number | null)[][]; boldFirstCol?: boolean }[], fileName: string) {
  const wb = await newBook();
  const used = new Set<string>();
  for (const s of sheets) {
    let nm = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || '시트';
    for (let i = 2; used.has(nm); i++) nm = `${s.name.slice(0, 25)}(${i})`;
    used.add(nm);
    const ws = wb.addWorksheet(nm, { views: [{ state: 'frozen', ySplit: 3 }] });
    const cols = Math.max(...s.aoa.map((r) => r.length), 1);
    title(ws, s.title, s.sub ?? '', cols);
    s.aoa.forEach((vals, i) => {
      const row = ws.getRow(3 + i);
      vals.forEach((v, c) => {
        const cell = row.getCell(c + 1);
        cell.value = v === '' ? null : v;
        cell.border = border;
        if (i === 0) {
          cell.fill = fill(HD);
          cell.font = { bold: true, color: { argb: NAVY } };
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        } else {
          if (typeof v === 'number') cell.numFmt = Number.isInteger(v) ? NF : NFQ;
          if (c === 0 && s.boldFirstCol) cell.font = { bold: true };
          if (vals[0] === '합계') {
            cell.fill = fill(TOT);
            cell.font = { bold: true };
          }
        }
      });
    });
    for (let c = 1; c <= cols; c++) {
      const w = Math.max(...s.aoa.map((r) => String(r[c - 1] ?? '').length));
      ws.getColumn(c).width = Math.min(40, Math.max(8, w * 1.4 + 2));
    }
    if (s.aoa.length > 1) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: cols } };
  }
  await download(wb, fileName);
}
