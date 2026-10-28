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
  pre: boolean; // 결재 중 (선발주 대상)
}

/** 승인됐지만 아직 발주되지 않은 청구 줄. withPending 이면 결재 중인 청구서 줄도 (선발주) */
export function pendingLines(reqs: Requisition[], pos: PurchaseOrder[], withPending = false): PendingLine[] {
  const done = orderedKeys(pos);
  const out: PendingLine[] = [];
  for (const r of reqs) {
    const pre = r.status === 'pending';
    if (r.status !== 'approved' && !(withPending && pre)) continue;
    for (const l of r.lines) {
      const key = `${r.id}|${l.key}`;
      if (!done.has(key) && (l.orderQty || l.reqQty) > 0) out.push({ req: r, line: l, key, pre });
    }
  }
  return out;
}

export type PreState = 'pending' | 'approved' | 'rejected' | 'draft';
/** 선발주 발주서의 청구서 결재 상태 (반려 > 결재 중 > 승인) */
export function preOrderState(po: PurchaseOrder, reqs: Requisition[]): PreState | undefined {
  if (!po.preOrder) return undefined;
  const st = po.reqIds.map((id) => reqs.find((r) => r.id === id)?.status);
  if (st.includes('rejected')) return 'rejected';
  if (st.includes('draft')) return 'draft';
  if (st.includes('pending')) return 'pending';
  return 'approved';
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
