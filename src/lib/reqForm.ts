// 구매청구서 엑셀: 회사 기존 '청구서' 양식(public/templates/req-form.xlsx)에 값을 채워 내려받기
// 양식 배치 (기존 청구서 엑셀과 동일)
//   U2 현장명 · B4 "현장명 : ○○ 현장" · O4 결의 날짜 · S4 결의번호
//   품목: 7~20행(1쪽 14줄) → 35~188행(이어지는 쪽)
//     B 품명 · C 규격 · D 단위 · E 계약수량 · F 계약단가 · G 실행량 · H 기반입 · I 금회청구 · J 본/비고
//     K 발주수량 · N 단가 · P 금액 · R 거래선 · T 비고 (T7 '사용 목적', T8 사용 목적 내용)
//   분류 요약: 22·24·26·28행 B 분류 · C 계약 · D 변경(예상) · G 실행 · H 기반입금액 · I 금회청구
//     21행 N·P·R·T = 금회청구 업체 (업체별 금액은 같은 행)  ※ 4칸이 넘으면 '외' 로 묶고 전체는 '투입집계' 시트
//   결재란: 29행 머리글, 31~32행 이름·승인일 (현장 M 담당 · O 소장 / 본사 T 담당 · U 팀장 · V 임원 · W 대표)
//   B32 날짜, I32 합계
import type ExcelJS from 'exceljs';
import type { Requisition } from '../types';
import { NO_VENDOR, type ReqSummary, type SumRow } from './reqSummary';

export const ITEM_ROWS = [...Array.from({ length: 14 }, (_, i) => 7 + i), ...Array.from({ length: 154 }, (_, i) => 35 + i)];


const SIGN_COL: { test: RegExp; col: string }[] = [
  { test: /현장\s*담당/, col: 'M' },
  { test: /소장/, col: 'O' },
  { test: /대표/, col: 'W' },
  { test: /임원/, col: 'V' },
  { test: /팀장/, col: 'U' },
  { test: /(본사\s*담당|자재부)/, col: 'T' },
];

const amt = (l: Requisition['lines'][number]) => (l.orderQty || l.reqQty) * (l.orderPrice || 0);
const n = (v?: number) => (v ? v : null);
const md = (t?: number) => {
  if (!t) return '';
  const d = new Date(t + 9 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** 양식 워크북에 청구서 내용을 채운다 (워크북을 그대로 고쳐 쓴다) */
export function fillReqForm(wb: ExcelJS.Workbook, req: Requisition, sum: ReqSummary, logo?: ArrayBuffer): { truncated: number } {
  const ws = wb.getWorksheet('청구서') ?? wb.worksheets[0];
  if (logo) {
    // 회사 로고 (양식 왼쪽 위)
    const id = wb.addImage({ buffer: logo as unknown as ExcelJS.Buffer, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 1 }, ext: { width: 220, height: 44 }, editAs: 'oneCell' });
  }
  const set = (ref: string, v: ExcelJS.CellValue) => {
    ws.getCell(ref).value = v;
  };
  const date = new Date(`${req.requestDate}T00:00:00Z`);

  set('U2', req.siteName);
  set('B4', `현장명 : ${req.siteName}  현장`);
  set('O4', isNaN(date.getTime()) ? req.requestDate : date);
  set('S4', req.docNo || null);
  set('T8', req.purpose || null);

  const lines = req.lines.filter((l) => l.itemName);
  // 양식의 금액 칸은 수식용 회색 글씨, 첫 줄 품명은 굵은 글씨라 일반 글씨로 맞춘다
  const plain = { ...(ws.getCell('K8').font ?? {}), color: { argb: 'FF000000' } };
  ws.getCell('B7').font = { ...(ws.getCell('B8').font ?? {}) };
  lines.slice(0, ITEM_ROWS.length).forEach((l, i) => {
    const r = ITEM_ROWS[i];
    set(`B${r}`, l.itemName);
    set(`C${r}`, l.spec || null);
    set(`D${r}`, l.unit || null);
    set(`E${r}`, n(l.contractQty));
    set(`F${r}`, n(l.contractPrice));
    set(`G${r}`, n(l.execQty));
    set(`H${r}`, n(l.priorQty));
    set(`I${r}`, n(l.reqQty));
    set(`J${r}`, l.note || null);
    set(`K${r}`, n(l.orderQty || l.reqQty));
    set(`N${r}`, n(l.orderPrice));
    set(`P${r}`, n(amt(l)));
    ws.getCell(`P${r}`).font = plain;
    set(`R${r}`, l.vendorName || null);
    if (r !== 7 && r !== 8) set(`T${r}`, l.remark || null);
  });

  // 분류 요약 (양식 4칸): 이번 청구 분류, 금액 큰 순. 넘치면 4번째 칸을 '외 N개'로 묶음
  const curRows = sum.rows.filter((r) => r.current).sort((a, b) => b.current - a.current);
  const slots: (Pick<SumRow, 'name' | 'contract' | 'change' | 'exec' | 'prior' | 'current' | 'byVendor'> | undefined)[] =
    curRows.length <= 4 ? curRows : [...curRows.slice(0, 3), merge(curRows.slice(3), `외 ${curRows.length - 3}개 분류`)];
  // 업체 4칸: 금액 큰 순, 넘치면 4번째 칸 '외 N개 업체'
  const vs = sum.vendors.map((v) => v.name);
  const vCols = vs.length <= 4 ? vs.map((v) => [v]) : [...vs.slice(0, 3).map((v) => [v]), vs.slice(3)];
  const V_COL = ['N', 'P', 'R', 'T'];
  const vHead = (g: string[]) => (g.length === 1 ? g[0] : `외 ${g.length}개 업체`);
  const black = { name: '맑은 고딕', size: 9, color: { argb: 'FF000000' } };
  V_COL.forEach((c, i) => {
    set(`${c}21`, vCols[i] ? vHead(vCols[i]) : null);
    ws.getCell(`${c}21`).font = { ...black, bold: true };
    ws.getCell(`${c}21`).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  // 칸 모양 정리: 금회청구(I~M)는 한 칸으로, 4번째 칸(28행)은 결재란 위 한 줄
  const tryUnmerge = (ref: string) => {
    try {
      ws.unMergeCells(ref);
    } catch {
      /* 이미 풀림 */
    }
  };
  const thin = { style: 'thin' as const };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  for (const r of [22, 24, 26]) {
    tryUnmerge(`K${r}:M${r}`);
    tryUnmerge(`K${r + 1}:M${r + 1}`);
    ws.mergeCells(`I${r}:M${r + 1}`);
  }
  ws.mergeCells('I28:M28');
  for (const [a, b] of [['N', 'O'], ['P', 'Q'], ['R', 'S'], ['T', 'W']]) ws.mergeCells(`${a}28:${b}28`);
  [22, 24, 26, 28].forEach((r, i) => {
    const c = slots[i];
    set(`B${r}`, c ? c.name : null);
    set(`C${r}`, c ? n(c.contract) : null);
    set(`D${r}`, c ? n(c.change) : null);
    set(`G${r}`, c ? n(c.exec) : null);
    set(`H${r}`, c ? n(c.prior) : null);
    set(`I${r}`, c ? n(c.current) : null);
    const small = r === 28; // 28행은 낮은 줄
    const cur = ws.getCell(`I${r}`);
    cur.font = { ...black, size: small ? 8 : 10, bold: true };
    cur.numFmt = '#,##0';
    cur.alignment = { horizontal: 'right', vertical: 'middle' };
    cur.border = box;
    V_COL.forEach((col, j) => {
      const v = c && vCols[j] ? vCols[j].reduce((a, name) => a + (c.byVendor[name] ?? 0), 0) : 0;
      const cell = ws.getCell(`${col}${r}`);
      cell.value = n(v);
      cell.numFmt = '#,##0';
      cell.font = { ...black, size: small ? 8 : 9 };
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.border = box;
    });
  });
  addSummarySheet(wb, req, sum);

  // 결재란
  for (const s of req.steps) {
    const col = SIGN_COL.find((x) => x.test.test(s.label))?.col;
    if (!col || !s.userName || s.result === 'skipped') continue;
    const state = s.result === 'approved' ? `${md(s.at)} 승인` : s.result === 'rejected' ? '반려' : '';
    if (col === 'M' || col === 'O') set(`${col}31`, state ? `${s.userName}\n${state}` : s.userName);
    else {
      set(`${col}31`, s.userName);
      set(`${col}32`, state || null);
    }
    ws.getCell(`${col}31`).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }

  const total = lines.reduce((a, l) => a + amt(l), 0);
  set('B32', { formula: '+$O$4', result: isNaN(date.getTime()) ? undefined : date } as ExcelJS.CellFormulaValue);
  set('I32', { formula: 'SUM(P6:Q188)', result: total } as ExcelJS.CellFormulaValue);

  // 인쇄 범위: 쓴 줄까지만 (빈 쪽이 인쇄되지 않게)
  const extra = Math.max(0, lines.length - 14);
  const last = extra ? 34 + extra : 32;
  ws.pageSetup.printArea = `A1:X${last}`;
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };
  return { truncated: Math.max(0, lines.length - ITEM_ROWS.length) };
}

function merge(rows: SumRow[], name: string) {
  const byVendor: Record<string, number> = {};
  rows.forEach((r) => Object.entries(r.byVendor).forEach(([k, v]) => (byVendor[k] = (byVendor[k] ?? 0) + v)));
  const t = (k: 'contract' | 'change' | 'exec' | 'prior' | 'current') => rows.reduce((a, r) => a + r[k], 0);
  return { name, contract: t('contract'), change: t('change'), exec: t('exec'), prior: t('prior'), current: t('current'), byVendor };
}

/** '투입집계' 시트: 현장 전체 분류 × (계약·변경·실행·기반입·금회청구·업체별·실행 잔액) + 업체별 합계 */
function addSummarySheet(wb: ExcelJS.Workbook, req: Requisition, sum: ReqSummary) {
  const old = wb.getWorksheet('투입집계');
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet('투입집계', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const vs = sum.vendors.map((v) => v.name);
  const head = ['자재분류', '계약내역', '변경내역(예상)', '실행금액', '기반입금액', '금회청구', ...vs, '실행 잔액'];
  const thin = { style: 'thin' as const, color: { argb: 'FF9AA3B5' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const font = { name: '맑은 고딕', size: 10 };
  ws.getCell('A1').value = `${req.siteName} 현장 · 자재분류별 투입 현황`;
  ws.getCell('A1').font = { ...font, size: 14, bold: true };
  ws.getCell('A2').value = `청구일 ${req.requestDate}${req.docNo ? ` · 결의번호 ${req.docNo}` : ''} · 기반입금액 = 이 청구서보다 먼저 올린 청구서의 발주 금액`;
  ws.getCell('A2').font = { ...font, color: { argb: 'FF667085' } };
  // 머리글 2줄 (업체 열은 '금회청구 업체별 금액' 아래)
  const h1 = 4;
  const h2 = 5;
  head.forEach((h, i) => {
    const isV = i >= 6 && i < 6 + vs.length;
    const c1 = ws.getCell(h1, i + 1);
    const c2 = ws.getCell(h2, i + 1);
    if (isV) {
      c2.value = h;
      if (i === 6) c1.value = '금회청구 업체별 금액';
    } else {
      c1.value = h;
      ws.mergeCells(h1, i + 1, h2, i + 1);
    }
    for (const c of [c1, c2]) {
      c.font = { ...font, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i === 5 ? 'FFFDF1DC' : 'FFEEF1F6' } };
      c.border = border;
    }
  });
  if (vs.length > 1) ws.mergeCells(h1, 7, h1, 6 + vs.length);
  const remain = (r: { exec: number; prior: number; current: number }) => (r.exec ? r.exec - r.prior - r.current : null);
  const rowVals = (r: Omit<SumRow, 'id'>) => [r.name, r.contract || null, r.change || null, r.exec || null, r.prior || null, r.current || null, ...vs.map((v) => r.byVendor[v] || null), remain(r)];
  let row = h2 + 1;
  for (const r of sum.rows) {
    const x = ws.getRow(row++);
    x.values = rowVals(r);
    x.eachCell({ includeEmpty: true }, (c, col) => {
      if (col > head.length) return;
      c.font = { ...font, bold: !!r.current, color: { argb: r.current ? 'FF101828' : 'FF475467' } };
      c.border = border;
      if (col > 1) c.numFmt = '#,##0;[Red]-#,##0';
      if (r.current) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8EA' } };
    });
  }
  const t = ws.getRow(row++);
  t.values = rowVals({ ...sum.total, name: '합   계' });
  t.eachCell({ includeEmpty: true }, (c, col) => {
    if (col > head.length) return;
    c.font = { ...font, bold: true };
    c.border = border;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F6' } };
    if (col > 1) c.numFmt = '#,##0;[Red]-#,##0';
  });

  // 업체별 합계
  row += 1;
  const vh = ws.getRow(row++);
  vh.values = ['금회청구 업체', '줄 수', '금회청구 금액', '비율'];
  vh.eachCell((c) => {
    c.font = { ...font, bold: true };
    c.border = border;
    c.alignment = { horizontal: 'center' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F6' } };
  });
  for (const v of sum.vendors) {
    const x = ws.getRow(row++);
    x.values = [v.name, v.lines, v.amount, sum.total.current ? v.amount / sum.total.current : null];
    x.eachCell((c, col) => {
      c.font = { ...font, color: v.name === NO_VENDOR ? { argb: 'FFB54708' } : undefined };
      c.border = border;
      c.numFmt = col === 4 ? '0.0%' : col > 1 ? '#,##0' : '@';
    });
  }
  const vt = ws.getRow(row++);
  vt.values = ['합   계', sum.vendors.reduce((a, v) => a + v.lines, 0), sum.total.current, null];
  vt.eachCell((c, col) => {
    c.font = { ...font, bold: true };
    c.border = border;
    if (col > 1) c.numFmt = '#,##0';
  });

  ws.getColumn(1).width = 30;
  for (let i = 2; i <= head.length; i++) ws.getColumn(i).width = i >= 7 && i < 7 + vs.length ? 14 : 15;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: h2 }];
}
