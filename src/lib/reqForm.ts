// 구매청구서 엑셀: 회사 기존 '청구서' 양식(public/templates/req-form.xlsx)에 값을 채워 내려받기
// 양식 배치 (기존 청구서 엑셀과 동일)
//   U2 현장명 · B4 "현장명 : ○○ 현장" · O4 결의 날짜 · S4 결의번호
//   품목: 7~20행(1쪽 14줄) → 35~188행(이어지는 쪽)
//     B 품명 · C 규격 · D 단위 · E 계약수량 · F 계약단가 · G 실행량 · H 기반입 · I 금회청구 · J 본/비고
//     K 발주수량 · N 단가 · P 금액 · R 거래선 · T 비고 (T7 '사용 목적', T8 사용 목적 내용)
//   분류 요약: 22·24·26·28행 B 분류 · C 계약 · D 변경(예상) · G 실행 · H 기반입금액 · I 금회청구
//   결재란: 29행 머리글, 31~32행 이름·승인일 (현장 M 담당 · O 소장 / 본사 T 담당 · U 팀장 · V 임원 · W 대표)
//   B32 날짜, I32 합계
import type ExcelJS from 'exceljs';
import type { Requisition } from '../types';

export const ITEM_ROWS = [...Array.from({ length: 14 }, (_, i) => 7 + i), ...Array.from({ length: 154 }, (_, i) => 35 + i)];

export interface ReqFormCat {
  name: string;
  contract: number;
  change: number;
  exec: number;
  prior: number; // 기반입 금액
  current: number; // 금회청구 금액
}

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
export function fillReqForm(wb: ExcelJS.Workbook, req: Requisition, cats: ReqFormCat[], logo?: ArrayBuffer): { truncated: number } {
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

  // 분류 요약 (최대 4개)
  [22, 24, 26, 28].forEach((r, i) => {
    const c = cats[i];
    set(`B${r}`, c ? c.name : null);
    set(`C${r}`, c ? n(c.contract) : null);
    set(`D${r}`, c ? n(c.change) : null);
    set(`G${r}`, c ? n(c.exec) : null);
    set(`H${r}`, c ? n(c.prior) : null);
    set(`I${r}`, c ? n(c.current) : null);
  });

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
