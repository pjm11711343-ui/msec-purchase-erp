// 단가관리시스템 단가 읽기 + 품명·규격으로 찾기
import { useEffect, useState } from 'react';
import { collection, collectionGroup, getDocs, limit, query, type DocumentData } from 'firebase/firestore';
import { C, db, PRICE_COLLECTION, PRICE_VENDOR_COLLECTION } from './firebase';
import { commitBatch } from './db';
import { useAuth } from '../auth/AuthContext';
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

// 단가관리 단가표 전체(최대 1만 건)를 읽으면 문서 수만큼 읽기 한도를 쓴다.
// → ERP에 사본(erp_priceCache, 몇 개 문서)을 두고, 하루 한 번만 원본에서 다시 만든다 (자재부·관리자 화면에서)
const PART = 2000;
const MAX_AGE = 24 * 3600e3;

/** 단가관리 원본에서 직접 읽기 (읽기 많음) */
async function loadFromSource(): Promise<PriceRow[]> {
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
}

/** 사본 다시 만들기 (자재부·관리자) */
export async function rebuildPriceCache(): Promise<PriceRow[]> {
  const rows = await loadFromSource();
  const at = Date.now();
  const parts = Math.max(1, Math.ceil(rows.length / PART));
  const old = await getDocs(collection(db, C.priceCache));
  const ops: Parameters<typeof commitBatch>[0] = [];
  for (let i = 0; i < parts; i++) ops.push({ type: 'set', col: C.priceCache, id: `part_${i}`, data: { rows: rows.slice(i * PART, (i + 1) * PART), at }, merge: false });
  old.docs.forEach((d) => {
    if (!(Number(d.id.replace('part_', '')) < parts)) ops.push({ type: 'delete', col: C.priceCache, id: d.id });
  });
  for (let i = 0; i < ops.length; i += 3) await commitBatch(ops.slice(i, i + 3));
  return rows;
}

let cache: Promise<PriceRow[]> | null = null;
let cacheAt = 0;

/** 단가표: ERP 사본 → (없거나 하루 지났고 자재부·관리자면) 원본에서 다시 만들기 */
export function loadPrices(opts: { force?: boolean; canRebuild?: boolean } = {}): Promise<PriceRow[]> {
  if (cache && !opts.force) return cache;
  cache = (async () => {
    if (opts.force && opts.canRebuild) {
      cacheAt = Date.now();
      return rebuildPriceCache();
    }
    const snap = await getDocs(collection(db, C.priceCache));
    const parts = snap.docs.sort((a, b) => Number(a.id.replace('part_', '')) - Number(b.id.replace('part_', '')));
    const rows = parts.flatMap((d) => (d.data().rows ?? []) as PriceRow[]);
    const at = Math.max(0, ...parts.map((d) => d.data().at ?? 0));
    cacheAt = at;
    if (opts.canRebuild && (!rows.length || Date.now() - at > MAX_AGE)) {
      try {
        cacheAt = Date.now();
        return await rebuildPriceCache();
      } catch {
        if (rows.length) return rows;
        throw new Error('단가표를 읽지 못했습니다.');
      }
    }
    // 사본이 아직 없으면 (현장 사용자) 어쩔 수 없이 원본에서
    return rows.length ? rows : loadFromSource();
  })().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

export const priceCacheAt = () => cacheAt;

export function usePrices() {
  const { can } = useAuth();
  const office = can('admin', 'material');
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    loadPrices({ canRebuild: office })
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, [office]);
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
