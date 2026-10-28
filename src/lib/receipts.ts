import { orderBy, where } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { useCollection, useSiteScoped } from './db';
import { C } from './firebase';
import { usePoPrices, withVendorPrices } from './poPrices';
import type { PoLine, PurchaseOrder, Receipt } from '../types';

/** 사내: 전체 또는 담당 현장 / 업체: 자기 업체 것만 */
export function useReceipts() {
  const { siteIds, vendor } = useAuth();
  const office = useCollection<Receipt>(C.receipts, [orderBy('createdAt', 'desc')], '', siteIds === null && !vendor);
  const scoped = useSiteScoped<Receipt>(C.receipts, siteIds === null || vendor ? [] : siteIds);
  const mine = useCollection<Receipt>(C.receipts, vendor ? [where('vendorId', '==', vendor.vendorId)] : [], vendor?.vendorId ?? '', !!vendor);
  const src = vendor ? mine : siteIds === null ? office : scoped;
  return { ...src, data: [...src.data].sort((a, b) => b.createdAt - a.createdAt) };
}

/** 업체 포털: 자기 업체 발주서 (업체가 기입한 단가를 덧씌움) + 단가 요청 */
export function useVendorPOs() {
  const { vendor } = useAuth();
  const r = useCollection<PurchaseOrder>(C.purchaseOrders, vendor ? [where('vendorId', '==', vendor.vendorId)] : [], vendor?.vendorId ?? '', !!vendor);
  const prices = usePoPrices();
  return {
    ...r,
    prices: prices.data,
    data: r.data
      .filter((p) => p.status !== 'cancelled')
      .map((p) => withVendorPrices(p, prices.data))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

export const poLineKey = (l: PoLine) => `${l.reqId}|${l.lineKey}`;

/** 발주 줄별 입고 누계 */
export function receivedMap(receipts: Receipt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of receipts) {
    const k = `${r.poId}#${r.lineKey}`;
    m.set(k, (m.get(k) ?? 0) + r.qty);
  }
  return m;
}

export function poProgress(po: PurchaseOrder, rec: Map<string, number>) {
  let ordered = 0;
  let received = 0;
  for (const l of po.lines) {
    ordered += l.qty;
    received += Math.min(l.qty, rec.get(`${po.id}#${poLineKey(l)}`) ?? 0);
  }
  const state: '미입고' | '부분입고' | '입고완료' = received <= 0 ? '미입고' : received >= ordered ? '입고완료' : '부분입고';
  return { ordered, received, rate: ordered ? received / ordered : 0, state };
}

export const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
