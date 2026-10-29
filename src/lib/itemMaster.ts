// 품목 목록(직접 등록·현장 요청·숨김)과 ERP 단가표
//  - 청구서 품명·규격 = 계산서(월별 품목명세) 품목 + 여기 등록한 품목 (숨김 표시한 것은 뺀다)
//  - 현장 사용자는 '요청'만, 자재부·관리자가 승인하면 등록
//  - 단가표: 품목 × 업체 (현장을 지정하면 그 현장만의 예외 단가), 바뀔 때마다 이전 단가를 이력으로
import { orderBy } from 'firebase/firestore';
import { useCollection } from './db';
import { C } from './firebase';
import { normItem, normSpec } from './itemNorm';

export interface ItemEntry {
  id: string;
  itemName: string;
  spec: string;
  unit: string;
  stdCatId?: string; // 표준 자재분류
  status: 'active' | 'requested' | 'rejected' | 'hidden'; // hidden = 계산서 품목을 청구서 목록에서 숨김
  note?: string;
  requestedBy?: string;
  requestedByName?: string;
  requestSiteName?: string;
  decidedByName?: string;
  decideNote?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface PriceEntry {
  id: string;
  itemName: string;
  spec: string;
  unit: string;
  vendorId: string;
  vendorName: string;
  siteId?: string; // 있으면 그 현장만의 예외 단가
  siteName?: string;
  listPrice: number; // 협가
  negoRate: number; // 네고율 %
  price: number; // 구매단가
  validFrom?: string; // 적용 시작일
  validTo?: string; // 적용 끝
  note?: string;
  updatedAt: number;
  updatedByName: string;
  history: { at: number; by: string; price: number; listPrice?: number; negoRate?: number }[];
}

export const itemKey = (item: string, spec: string) => `${normItem(item)}|${normSpec(spec)}`;

export function useItemEntries() {
  return useCollection<ItemEntry>(C.items, [orderBy('createdAt', 'desc')]);
}
export function usePriceList() {
  return useCollection<PriceEntry>(C.priceList, [orderBy('updatedAt', 'desc')]);
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export const priceValid = (p: PriceEntry, day = today()) => (!p.validFrom || p.validFrom <= day) && (!p.validTo || p.validTo >= day);

/** 청구서 단가: 이 현장 예외 단가 → 업체 단가. 거래선이 정해져 있으면 그 업체, 없으면 가장 싼 것 */
export function pickListPrice(list: PriceEntry[], item: string, spec: string, siteId?: string, vendorId?: string): PriceEntry | undefined {
  const k = itemKey(item, spec);
  const cands = list.filter((p) => itemKey(p.itemName, p.spec) === k && p.price > 0 && priceValid(p) && (!p.siteId || p.siteId === siteId));
  if (!cands.length) return undefined;
  const pool = vendorId ? cands.filter((p) => p.vendorId === vendorId) : cands;
  const use = pool.length ? pool : cands;
  // 현장 예외가 있으면 그것을 먼저
  const siteOnes = use.filter((p) => p.siteId && p.siteId === siteId);
  return [...(siteOnes.length ? siteOnes : use)].sort((a, b) => a.price - b.price)[0];
}

/** 협가·네고율 → 구매단가 */
export const buyPrice = (list: number, nego: number) => Math.round(list * (1 - (nego || 0) / 100));
