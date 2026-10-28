// 업체 단가 입력·변경 요청
//  - 발주서 단가가 비어 있는 줄: 업체가 입고 등록할 때 단가를 넣는다 (kind 'fill', 바로 인정)
//  - 단가가 있는 줄: 업체가 변경을 요청하고 자재부가 승인하면 발주서 단가가 바뀐다 (kind 'change')
//  - 업체는 발주서를 직접 고칠 수 없으므로(보안 규칙) 요청은 erp_poPrices 에 따로 두고,
//    사내(자재부·관리자) 화면이 열릴 때 'fill' 을 발주서에 옮겨 적는다.
import { useEffect, useMemo, useRef } from 'react';
import { where } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { commitBatch, stripUndefined, useCollection } from './db';
import { C } from './firebase';
import type { PoLine, PurchaseOrder } from '../types';

export interface PoPrice {
  id: string; // `${poId}__${lineKey}`
  poId: string;
  poNo: string;
  siteId: string;
  siteName: string;
  vendorId: string;
  vendorName: string;
  lineKey: string; // reqId|lineKey (발주 줄)
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  oldPrice: number;
  price: number;
  kind: 'fill' | 'change';
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
  by: string;
  byName: string;
  at: number;
  applied?: boolean; // 발주서에 반영됨
  appliedAt?: number;
  decidedByName?: string;
  decidedAt?: number;
  decideNote?: string;
}

export const priceDocId = (poId: string, lineKey: string) => `${poId}__${lineKey}`;
const lk = (l: PoLine) => `${l.reqId}|${l.lineKey}`;

/** 사내: 전체 / 업체: 자기 것 */
export function usePoPrices() {
  const { vendor, can } = useAuth();
  const office = can('admin', 'material');
  const mine = useCollection<PoPrice>(C.poPrices, vendor ? [where('vendorId', '==', vendor.vendorId)] : [], vendor?.vendorId ?? '', !!vendor);
  const all = useCollection<PoPrice>(C.poPrices, [], 'all', !vendor && office);
  return vendor ? mine : all;
}

/** 업체 화면용: 아직 발주서에 옮겨지지 않은 'fill' 단가를 발주서 줄에 덧씌운다 */
export function withVendorPrices(po: PurchaseOrder, prices: PoPrice[]): PurchaseOrder {
  const fills = prices.filter((p) => p.poId === po.id && p.kind === 'fill' && p.status === 'approved' && !p.applied);
  if (!fills.length) return po;
  const lines = po.lines.map((l) => {
    const f = fills.find((p) => p.lineKey === lk(l));
    return f && !l.price ? { ...l, price: f.price, amount: Math.round(l.qty * f.price), priceBy: 'vendor' as const } : l;
  });
  return { ...po, lines, totalAmount: lines.reduce((a, l) => a + l.amount, 0) };
}

/** 단가 변경을 발주서에 적는 작업 (여러 건을 한 발주서에 모아서) */
function applyOps(po: PurchaseOrder, items: { p: PoPrice; ok: boolean; note?: string }[], who: string) {
  const now = Date.now();
  let lines = po.lines;
  const hist: PurchaseOrder['history'] = [];
  const docOps: Parameters<typeof commitBatch>[0] = [];
  for (const { p, ok, note } of items) {
    const i = lines.findIndex((l) => lk(l) === p.lineKey);
    const line = lines[i];
    // 'fill' 은 발주서 단가가 아직 비어 있을 때만
    const can = ok && !!line && (p.kind === 'change' || !line.price);
    if (can) {
      lines = lines.map((l, j) =>
        j === i ? stripUndefined({ ...l, price: p.price, amount: Math.round(l.qty * p.price), priceBy: 'vendor' as const, priceOld: p.kind === 'change' ? l.price : undefined }) : l,
      );
      hist.push({ at: now, by: who, action: p.kind === 'fill' ? `업체 단가 기입 ${p.itemName} ${p.spec} ${p.price.toLocaleString()}원` : `단가 변경 승인 ${p.itemName} ${p.spec} ${p.oldPrice.toLocaleString()}→${p.price.toLocaleString()}원` });
    } else if (p.kind === 'change' && !ok) {
      hist.push({ at: now, by: who, action: `단가 변경 거절 ${p.itemName} ${p.spec} (요청 ${p.price.toLocaleString()}원)` });
    }
    docOps.push({
      type: 'set',
      col: C.poPrices,
      id: p.id,
      data: stripUndefined({
        status: can ? 'approved' : 'rejected',
        applied: true,
        appliedAt: now,
        ...(p.kind === 'change' || !can ? { decidedByName: who, decidedAt: now } : {}),
        decideNote: note ?? (!can && p.kind === 'fill' ? '발주서에 이미 단가가 있어 반영하지 않음' : undefined),
      }),
    });
  }
  const changed = lines !== po.lines;
  return [
    ...(changed || hist.length
      ? [{ type: 'set' as const, col: C.purchaseOrders, id: po.id, data: { lines, totalAmount: lines.reduce((a, l) => a + l.amount, 0), history: [...po.history, ...hist] } }]
      : []),
    ...docOps,
  ];
}

/** 자재부: 단가 변경 요청 승인/거절 */
export async function decidePrices(pos: PurchaseOrder[], items: { p: PoPrice; ok: boolean; note?: string }[], who: string) {
  const byPo = new Map<string, typeof items>();
  items.forEach((x) => byPo.set(x.p.poId, [...(byPo.get(x.p.poId) ?? []), x]));
  const ops: Parameters<typeof commitBatch>[0] = [];
  for (const [poId, list] of byPo) {
    const po = pos.find((p) => p.id === poId);
    if (po) ops.push(...applyOps(po, list, who));
  }
  await commitBatch(ops);
}

/** 사내 화면이 열려 있으면 업체가 기입한 단가('fill')를 발주서에 옮긴다 */
export function usePoPriceSync(pos: PurchaseOrder[], enabled: boolean) {
  const prices = usePoPrices();
  const busy = useRef(false);
  const todo = useMemo(() => prices.data.filter((p) => p.kind === 'fill' && p.status === 'approved' && !p.applied), [prices.data]);
  useEffect(() => {
    if (!enabled || busy.current || !todo.length || !pos.length) return;
    const ready = todo.filter((p) => pos.some((x) => x.id === p.poId));
    if (!ready.length) return;
    busy.current = true;
    decidePrices(
      pos,
      ready.map((p) => ({ p, ok: true })),
      '업체 기입',
    )
      .catch(() => undefined)
      .finally(() => (busy.current = false));
  }, [todo, pos, enabled]);
  return prices;
}
