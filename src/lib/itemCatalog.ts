// 계산서(월별 품목명세)에서 뽑은 품명·규격 목록 + 최신 단가
//  - 현장 사용자도 읽을 수 있게 erp_itemCatalog 에 따로 저장 (계산서 자체는 사내 사무실만 읽음)
//  - 같은 품목(표기 차이·직접 합친 품목)은 한 줄, 이름은 가장 많이 쓴 표기
//  - 단가: 현장별 최신 + 회사 전체 최신 (월 → 입고일 → 올린 시각 순)
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot } from 'firebase/firestore';
import { C, db } from './firebase';
import { commitBatch } from './db';
import { lineQty, linePrice } from './matching';
import { baseKey } from './itemNorm';
import type { Invoice } from '../types';

export interface LastPrice {
  p: number; // 단가
  m: string; // 월
  d?: string; // 입고일
  v: string; // 업체명
  vid: string; // 업체 id
}
export interface CatItem {
  k: string; // 품목 키 (합친 품목 반영)
  i: string; // 품명
  s: string; // 규격
  u: string; // 단위
  ct?: string; // 계산서 분류 원문 (가장 많이 쓰인 것)
  sc?: string; // 계산서 매핑 현장분류 id (가장 많이 쓰인 것)
  last: LastPrice; // 회사 전체 최신
  site: Record<string, LastPrice>; // 현장별 최신
}

const COL = 'erp_itemCatalog';
const PART = 600;

const newer = (a: { m: string; d?: string; t: number }, b: { m: string; d?: string; t: number }) => a.m > b.m || (a.m === b.m && ((a.d ?? '') > (b.d ?? '') || ((a.d ?? '') === (b.d ?? '') && a.t > b.t)));

export function buildCatalog(invoices: Invoice[], alias: Record<string, string>): CatItem[] {
  type Acc = { names: Map<string, number>; units: Map<string, number>; cts: Map<string, number>; scs: Map<string, number>; last?: LastPrice & { t: number }; site: Record<string, LastPrice & { t: number }> };
  const m = new Map<string, Acc>();
  for (const inv of invoices) {
    if (inv.submitted && !inv.appliedToLedger) continue;
    for (const l of inv.lines) {
      const item = l.itemName?.trim();
      if (!item) continue;
      const spec = (l.spec || '').trim() === '0' ? '' : (l.spec || '').trim();
      const bk = baseKey(item, spec);
      const k = alias[bk] ?? bk;
      const o: Acc = m.get(k) ?? { names: new Map(), units: new Map(), cts: new Map(), scs: new Map(), site: {} };
      const nm = `${item}\u0001${spec}`;
      o.names.set(nm, (o.names.get(nm) ?? 0) + 1);
      if (l.unit) o.units.set(l.unit, (o.units.get(l.unit) ?? 0) + 1);
      const ct = (l.categoryText ?? '').trim();
      if (ct) o.cts.set(ct, (o.cts.get(ct) ?? 0) + 1);
      if (l.siteCategoryId) o.scs.set(l.siteCategoryId, (o.scs.get(l.siteCategoryId) ?? 0) + 1);
      const q = lineQty(l);
      const p = Math.round(linePrice(l) || (q ? l.finalAmount / q : 0));
      if (p > 0) {
        const cand = { p, m: inv.month, ...(l.receivedDate ? { d: l.receivedDate } : {}), v: inv.vendorName, vid: inv.vendorId, t: inv.uploadedAt ?? 0 };
        if (!o.last || newer(cand, o.last)) o.last = cand;
        const cs = o.site[inv.siteId];
        if (!cs || newer(cand, cs)) o.site[inv.siteId] = cand;
      }
      m.set(k, o);
    }
  }
  const top = (x: Map<string, number>) => [...x].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const strip = ({ t: _t, ...r }: LastPrice & { t: number }): LastPrice => (void _t, r);
  const out: CatItem[] = [];
  for (const [k, o] of m) {
    if (!o.last) continue; // 단가가 없는 품목은 목록에만 쓸 이유가 적어 뺀다
    const [i, s] = top(o.names).split('\u0001');
    const ct = top(o.cts);
    const sc = top(o.scs);
    out.push({ k, i, s: s ?? '', u: top(o.units), ...(ct ? { ct } : {}), ...(sc ? { sc } : {}), last: strip(o.last), site: Object.fromEntries(Object.entries(o.site).map(([sid, v]) => [sid, strip(v)])) });
  }
  return out.sort((a, b) => a.i.localeCompare(b.i, 'ko') || a.s.localeCompare(b.s, 'ko'));
}

/** 계산서 전체를 읽어 품명 목록을 다시 만든다 (사무실 사용자) */
export async function rebuildCatalog(loaded?: Invoice[]): Promise<number> {
  // 화면에서 이미 읽은 계산서가 있으면 다시 읽지 않는다 (읽기 한도 절약)
  const [invoices, aliasDoc, old] = await Promise.all([
    loaded ?? getDocs(collection(db, C.invoices)).then((s) => s.docs.map((d) => ({ ...(d.data() as Omit<Invoice, 'id'>), id: d.id }))),
    getDoc(doc(db, C.ledgerMeta, 'itemAlias')),
    getDocs(collection(db, COL)),
  ]);
  const alias = Object.fromEntries((aliasDoc.data()?.pairs ?? []) as [string, string][]);
  const items = buildCatalog(invoices, alias);
  const parts = Math.max(1, Math.ceil(items.length / PART));
  const at = Date.now();
  const ops: Parameters<typeof commitBatch>[0] = [];
  for (let i = 0; i < parts; i++) ops.push({ type: 'set', col: COL, id: `part_${i}`, data: { items: items.slice(i * PART, (i + 1) * PART), at }, merge: false });
  old.docs.forEach((d) => {
    const n = Number(d.id.replace('part_', ''));
    if (!(n < parts)) ops.push({ type: 'delete', col: COL, id: d.id });
  });
  for (let i = 0; i < ops.length; i += 5) await commitBatch(ops.slice(i, i + 5));
  return items.length;
}

/** 화면을 막지 않고 뒤에서 다시 만든다 (실패해도 조용히) */
export function refreshCatalog() {
  rebuildCatalog().catch(() => undefined);
}

/** 품명 목록 구독 */
export function useItemCatalog() {
  const [items, setItems] = useState<CatItem[]>([]);
  const [at, setAt] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(
    () =>
      onSnapshot(
        collection(db, COL),
        (snap) => {
          const parts = snap.docs.sort((a, b) => Number(a.id.replace('part_', '')) - Number(b.id.replace('part_', '')));
          setItems(parts.flatMap((d) => (d.data().items ?? []) as CatItem[]));
          setAt(Math.max(0, ...parts.map((d) => d.data().at ?? 0)));
          setReady(true);
        },
        () => undefined,
      ),
    [],
  );
  return { items, at, ready };
}
