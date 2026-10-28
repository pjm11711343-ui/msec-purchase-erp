// 월별 품목 엑셀 내보내기 (서식 포함, exceljs는 필요할 때만 불러옴)
import type ExcelJS from 'exceljs';
import { GLBL, mLong, type Pivot } from './ledgerData';

const NAVY = 'FF0A1220';
const HD = 'FFDCE6F2';
const HD2 = 'FFEDF2F9';
const G0 = 'FFDCE2EC';
const G1 = 'FFEDF0F5';
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

/** 월별 품목 리스트 (묶음 줄 + 품목 줄, 월마다 수량·단가·금액) */
export async function exportPivotXlsx(pv: Pivot, sub: string, fileName: string, opts: { showSite: boolean; showCat: boolean; showVen: boolean }) {
  const wb = await newBook();
  const ws = wb.addWorksheet('월별 품목', { views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }] });
  const extra: [string, (it: Pivot['groups'][number]['list'][number]) => string][] = [];
  if (opts.showSite) extra.push(['현장', (it) => [...it.sites].join(', ')]);
  if (opts.showCat) extra.push(['분류', (it) => it.cat]);
  if (opts.showVen) extra.push(['업체', (it) => [...it.vendors].join(', ')]);
  const cT = 4 + extra.length; // 합계 시작 열
  const cM = cT + 2; // 월 시작 열
  const last = cM + pv.months.length * 3 - 1;
  title(ws, '계산서 월별 품목 리스트', sub, Math.max(last, 6));

  const H1 = 3;
  const H2 = 4;
  const head = (r: number, c: number, v: string, f = HD, bold = true) => {
    const cell = ws.getCell(r, c);
    cell.value = v;
    cell.font = { bold, size: r === H2 ? 9 : 10, color: { argb: NAVY } };
    cell.fill = fill(f);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  };
  ['품목', '규격', '단위', ...extra.map((e) => e[0])].forEach((t, i) => {
    head(H1, i + 1, t);
    head(H2, i + 1, '');
    ws.mergeCells(H1, i + 1, H2, i + 1);
  });
  head(H1, cT, '합  계', TOT);
  head(H1, cT + 1, '', TOT);
  ws.mergeCells(H1, cT, H1, cT + 1);
  head(H2, cT, '수량', TOT);
  head(H2, cT + 1, '금액', TOT);
  pv.months.forEach((m, i) => {
    const c = cM + i * 3;
    head(H1, c, mLong(m));
    head(H1, c + 1, '');
    head(H1, c + 2, '');
    ws.mergeCells(H1, c, H1, c + 2);
    head(H2, c, '수량', HD2);
    head(H2, c + 1, '단가', HD2);
    head(H2, c + 2, '금액', HD2);
  });

  let r = H2 + 1;
  // 전체 합계
  const gt = ws.getRow(r);
  gt.getCell(1).value = '전체 합계';
  gt.getCell(cT + 1).value = Math.round(pv.ta);
  pv.months.forEach((m, i) => (gt.getCell(cM + i * 3 + 2).value = Math.round(pv.mt[m] ?? 0) || null));
  for (let c = 1; c <= last; c++) {
    const cell = gt.getCell(c);
    cell.fill = fill(NAVY);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.border = border;
    cell.numFmt = NF;
  }
  r++;
  let prev: string[] = [];
  for (const g of pv.groups) {
    let d = 0;
    while (d < g.path.length && g.path[d] === prev[d]) d++;
    for (let L = d; L < g.path.length; L++) {
      const p = pv.pre.get(g.path.slice(0, L + 1).join('\u0001'))!;
      const row = ws.getRow(r++);
      row.getCell(1).value = `${'   '.repeat(L)}${GLBL[pv.gk[L]]}: ${g.path[L]}  (${p.n}품목)`;
      row.getCell(cT + 1).value = Math.round(p.ta);
      pv.months.forEach((m, i) => (row.getCell(cM + i * 3 + 2).value = Math.round(p.mt[m] ?? 0) || null));
      for (let c = 1; c <= last; c++) {
        const cell = row.getCell(c);
        cell.fill = fill(L === 0 ? G0 : G1);
        cell.font = { bold: true, color: { argb: NAVY } };
        cell.border = border;
        cell.numFmt = NF;
      }
    }
    prev = g.path;
    for (const it of g.list) {
      const row = ws.getRow(r++);
      row.getCell(1).value = it.item;
      row.getCell(2).value = it.spec;
      row.getCell(3).value = it.unit;
      extra.forEach((e, i) => (row.getCell(4 + i).value = e[1](it)));
      row.getCell(cT).value = it.tq || null;
      row.getCell(cT + 1).value = Math.round(it.ta) || null;
      pv.months.forEach((m, i) => {
        const c = it.cells[m];
        if (!c) return;
        row.getCell(cM + i * 3).value = c.q || null;
        row.getCell(cM + i * 3 + 1).value = c.q ? Math.round(c.a / c.q) : null;
        row.getCell(cM + i * 3 + 2).value = Math.round(c.a) || null;
      });
      for (let c = 1; c <= last; c++) {
        const cell = row.getCell(c);
        cell.border = border;
        if (c >= cT) cell.numFmt = (c - cM) % 3 === 0 || c === cT ? NFQ : NF;
      }
    }
  }
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 6;
  extra.forEach((_, i) => (ws.getColumn(4 + i).width = 16));
  for (let c = cT; c <= last; c++) ws.getColumn(c).width = 11;
  ws.autoFilter = undefined;
  await download(wb, fileName);
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
