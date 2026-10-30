// 품목 목록(직접 등록·현장 요청·숨김)과 ERP 단가표
//  - 청구서 품명·규격 = 계산서(월별 품목명세) 품목 + 여기 등록한 품목 (숨김 표시한 것은 뺀다)
//  - 현장 사용자는 '요청'만, 자재부·관리자가 승인하면 등록
//  - 단가표: 품목 × 업체 (현장을 지정하면 그 현장만의 예외 단가), 바뀔 때마다 이전 단가를 이력으로
import { orderBy } from 'firebase/firestore';
import { useCollection } from './db';
import { C } from './firebase';
import { normItem, normSpec } from './itemNorm';
import { similarity, stdOfText } from './catMatch';
import type { SiteCategory, StandardCategory } from '../types';

export interface ItemEntry {
  id: string;
  itemName: string;
  spec: string;
  unit: string;
  stdCatId?: string; // 표준 자재분류
  maker?: string; // 제조사(메이커)
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
  maker?: string; // 제조사(메이커)
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

/* ───────── 품목별 자재분류 ─────────
 * 표준 자재분류를 품목마다 정해 둔다. 우선순위:
 *   1) 자재부가 지정한 분류 (erp_itemCats)
 *   2) 직접 등록 품목에 넣은 분류
 *   3) 계산서에서 가장 많이 쓰인 분류 (현장분류 → 표준분류, 없으면 분류 원문 → 표준분류)
 * 청구서에서 품목을 고르면 이 표준분류에 연결된 현장 자재분류가 자동으로 들어간다. */
export interface ItemCat {
  id: string;
  itemName: string;
  spec: string;
  stdCatId: string;
  byName?: string;
  at: number;
}
export function useItemCats() {
  return useCollection<ItemCat>(C.itemCats);
}
/** 품목 키 → 문서 id (같은 품목은 같은 문서) */
export function itemCatId(item: string, spec: string) {
  const s = itemKey(item, spec);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `ic_${h1.toString(36)}${h2.toString(36)}`;
}

export type CatFrom = '지정' | '등록' | '계산서' | '';

/** 품목들의 표준 자재분류를 한 번에 계산하는 함수를 만든다 */
export function makeItemStd(opts: {
  itemCats: ItemCat[];
  entries: ItemEntry[];
  catalog: { i: string; s: string; ct?: string; sc?: string }[];
  siteCats: SiteCategory[];
  std: StandardCategory[];
}): (item: string, spec: string) => { stdCatId: string; from: CatFrom } {
  const over = new Map(opts.itemCats.map((c) => [itemKey(c.itemName, c.spec), c.stdCatId]));
  const reg = new Map(opts.entries.filter((e) => e.stdCatId && e.status !== 'hidden' && e.status !== 'rejected').map((e) => [itemKey(e.itemName, e.spec), e.stdCatId!]));
  const scStd = new Map(opts.siteCats.map((c) => [c.id, c.standardCategoryId ?? '']));
  const textMemo = new Map<string, string>();
  const inv = new Map<string, string>();
  for (const c of opts.catalog) {
    let id = c.sc ? scStd.get(c.sc) ?? '' : '';
    if (!id && c.ct) {
      if (!textMemo.has(c.ct)) textMemo.set(c.ct, stdOfText(c.ct, opts.std)?.id ?? '');
      id = textMemo.get(c.ct)!;
    }
    if (id) inv.set(itemKey(c.i, c.s), id);
  }
  return (item, spec) => {
    const k = itemKey(item, spec);
    const o = over.get(k);
    if (o) return { stdCatId: o, from: '지정' };
    const r = reg.get(k);
    if (r) return { stdCatId: r, from: '등록' };
    const i = inv.get(k);
    if (i) return { stdCatId: i, from: '계산서' };
    return { stdCatId: '', from: '' };
  };
}

/** 표준분류 → 이 현장의 자재분류 id (연결된 것이 여럿이면 이름이 가장 비슷한 것) */
export function siteCatOfStd(stdCatId: string, siteCats: SiteCategory[], std: StandardCategory[]): string {
  if (!stdCatId) return '';
  const linked = siteCats.filter((c) => c.standardCategoryId === stdCatId);
  if (linked.length <= 1) return linked[0]?.id ?? '';
  const name = std.find((x) => x.id === stdCatId)?.name ?? '';
  return [...linked].sort((a, b) => similarity(name, b.name) - similarity(name, a.name))[0].id;
}
