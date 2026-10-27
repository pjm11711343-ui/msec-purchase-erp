// 단가관리시스템 단가 읽기 + 품명·규격으로 찾기
import { useEffect, useState } from 'react';
import { collection, collectionGroup, getDocs, limit, query, type DocumentData } from 'firebase/firestore';
import { db, PRICE_COLLECTION, PRICE_VENDOR_COLLECTION } from './firebase';
import { nameKey, num, specKey } from './normalize';

export interface PriceRow {
  priceVendorId: string;
  vendorName: string;
  itemName: string;
  spec: string;
  unit: string;
  listPrice: number; // 협가
  negoRate: number; // 네고율(%)
  buyPrice: number; // 구매단가
  maker?: string;
}

const pick = (d: DocumentData, ...keys: string[]) => {
  for (const k of keys) if (d[k] != null && d[k] !== '') return d[k];
  return undefined;
};

function toRow(d: DocumentData, vendorId: string, vendorName: string): PriceRow {
  const listPrice = num(pick(d, 'costPrice', 'listPrice', '협가', 'price'));
  const negoRaw = num(pick(d, 'negoRate', 'nego', '네고율'));
  const negoRate = Math.abs(negoRaw) <= 1 && negoRaw !== 0 ? Math.abs(negoRaw) * 100 : Math.abs(negoRaw);
  const base = num(pick(d, 'baseUnitPrice', 'purchasePrice', '구매단가'));
  const buyPrice = base || Math.round(listPrice * (1 - negoRate / 100));
  return {
    priceVendorId: vendorId,
    vendorName,
    itemName: String(pick(d, 'itemName', 'name', '품명') ?? ''),
    spec: String(pick(d, 'spec', '규격') ?? ''),
    unit: String(pick(d, 'unit', '단위') ?? ''),
    listPrice,
    negoRate,
    buyPrice,
    maker: pick(d, 'maker', '메이커') as string | undefined,
  };
}

let cache: Promise<PriceRow[]> | null = null;

export function loadPrices(force = false): Promise<PriceRow[]> {
  if (cache && !force) return cache;
  cache = (async () => {
    const vSnap = await getDocs(collection(db, PRICE_VENDOR_COLLECTION));
    const vName = new Map<string, string>();
    vSnap.docs.forEach((d) => {
      const x = d.data();
      vName.set(d.id, String(x.name ?? x.companyName ?? d.id));
    });
    const pSnap = await getDocs(query(collectionGroup(db, PRICE_COLLECTION), limit(10000)));
    return pSnap.docs
      .map((d) => {
        const vid = d.ref.parent.parent?.id ?? '';
        return toRow(d.data(), vid, vName.get(vid) ?? vid);
      })
      .filter((r) => r.itemName && r.buyPrice > 0);
  })().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

export function usePrices() {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    loadPrices()
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, []);
  return { rows, error };
}

export function priceKey(item: string, spec: string) {
  return `${nameKey(item)}|${specKey(spec)}`;
}

/** 품명+규격 일치 단가 목록 (싼 순) */
export function findPrices(rows: PriceRow[], item: string, spec: string): PriceRow[] {
  const k = priceKey(item, spec);
  return rows.filter((r) => priceKey(r.itemName, r.spec) === k).sort((a, b) => a.buyPrice - b.buyPrice);
}

/** 거래선 이름으로 단가관리 업체 찾기 */
export function sameVendor(priceVendorName: string, erpVendorName: string, aliases: string[] = []) {
  const a = nameKey(priceVendorName);
  return [erpVendorName, ...aliases].some((n) => {
    const b = nameKey(n);
    if (!a || !b) return false;
    if (a === b) return true;
    // 포함 관계는 짧은 쪽이 3글자 이상일 때만 (예: 시트 이름 "지오"가 "지오테크"에 붙지 않게)
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.length >= 3 && l.includes(s);
  });
}
