// 계산서월: 입고 물량을 몇 월 계산서로 청구할지
//  - 마감은 매월 20일: 전월 21일 ~ 당월 20일 입고분 = 당월 계산서 (예: 10/21~11/20 → 11월)
//  - 자재부·관리자가 줄마다 다른 달로 지정(이월)할 수 있다
import type { Invoice, Receipt } from '../types';

export const CLOSE_DAY = 20;

export function addMonth(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export const monthDiff = (a: string, b: string) => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
};
/** 입고일 → 자동 계산서월 (21일부터 다음 달) */
export function autoBillMonth(date: string) {
  if (!date || date.length < 10) return (date ?? '').slice(0, 7);
  return Number(date.slice(8, 10)) > CLOSE_DAY ? addMonth(date.slice(0, 7), 1) : date.slice(0, 7);
}
/** 이 입고 줄의 계산서월 */
export const billMonthOf = (r: Pick<Receipt, 'date' | 'billMonth'>) => r.billMonth || autoBillMonth(r.date);
/** 자동 계산서월보다 몇 달 넘겼는지 (0 = 그대로) */
export const carryOf = (r: Pick<Receipt, 'date' | 'billMonth'>) => (r.billMonth ? monthDiff(autoBillMonth(r.date), r.billMonth) : 0);
/** 계산서월의 입고 기간 (예: 2026-11 → 2026-10-21 ~ 2026-11-20) */
export function billPeriod(ym: string) {
  const p = addMonth(ym, -1);
  return { from: `${p}-${CLOSE_DAY + 1}`, to: `${ym}-${CLOSE_DAY}` };
}
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
/** 오늘 입고하면 들어갈 계산서월 */
export const openBillMonth = () => autoBillMonth(kst());
/** 이번 계산서월 마감까지 남은 날 (마감일 당일 = 0) */
export function daysToClose() {
  const t = kst();
  const close = `${openBillMonth()}-${CLOSE_DAY}`;
  return Math.round((Date.parse(close) - Date.parse(t)) / 86400e3);
}

/** 계산서에 이미 들어간 입고 줄 id: 업체 포털 제출(receiptIds) + 계산서정리 엑셀(같은 발주 줄·같은 입고일) */
export function billedReceiptIds(receipts: Receipt[], invoices: Invoice[]) {
  const s = new Set<string>();
  const byLine = new Set<string>();
  for (const inv of invoices)
    for (const l of inv.lines) {
      l.receiptIds?.forEach((id) => s.add(id));
      if (!l.receiptIds?.length && l.poId && l.poLineKey) byLine.add(`${l.poId}#${l.poLineKey}#${l.receivedDate ?? ''}`);
    }
  for (const r of receipts) if (!s.has(r.id) && (byLine.has(`${r.poId}#${r.lineKey}#${r.date}`) || byLine.has(`${r.poId}#${r.lineKey}#`))) s.add(r.id);
  return s;
}
