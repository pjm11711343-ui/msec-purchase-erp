import { orderBy } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { useCollection, useSiteScoped } from './db';
import { C } from './firebase';
import type { PurchaseOrder, Requisition, ReqLine } from '../types';

export function usePurchaseOrders() {
  const { siteIds } = useAuth();
  const all = useCollection<PurchaseOrder>(C.purchaseOrders, [orderBy('createdAt', 'desc')], '', siteIds === null);
  const scoped = useSiteScoped<PurchaseOrder>(C.purchaseOrders, siteIds === null ? [] : siteIds);
  const src = siteIds === null ? all : scoped;
  return { ...src, data: [...src.data].sort((a, b) => b.createdAt - a.createdAt) };
}

/** 이미 발주(취소 제외)된 청구 줄: `${reqId}|${lineKey}` */
export function orderedKeys(pos: PurchaseOrder[]): Map<string, PurchaseOrder> {
  const m = new Map<string, PurchaseOrder>();
  for (const p of pos) if (p.status !== 'cancelled') for (const l of p.lines) m.set(`${l.reqId}|${l.lineKey}`, p);
  return m;
}

export interface PendingLine {
  req: Requisition;
  line: ReqLine;
  key: string; // reqId|lineKey
}

/** 승인됐지만 아직 발주되지 않은 청구 줄 */
export function pendingLines(reqs: Requisition[], pos: PurchaseOrder[]): PendingLine[] {
  const done = orderedKeys(pos);
  const out: PendingLine[] = [];
  for (const r of reqs) {
    if (r.status !== 'approved') continue;
    for (const l of r.lines) {
      const key = `${r.id}|${l.key}`;
      if (!done.has(key) && (l.orderQty || l.reqQty) > 0) out.push({ req: r, line: l, key });
    }
  }
  return out;
}

export function yymmdd(date: string) {
  return date.replace(/-/g, '').slice(2);
}

/** 다음 발주번호: 현장코드-YYMMDD-NN */
export function nextPoNo(pos: PurchaseOrder[], siteCode: string, date: string, taken: Set<string> = new Set()) {
  const prefix = `${siteCode}-${yymmdd(date)}-`;
  const used = new Set([...pos.map((p) => p.poNo), ...taken]);
  for (let n = 1; ; n++) {
    const no = `${prefix}${String(n).padStart(2, '0')}`;
    if (!used.has(no)) return no;
  }
}
