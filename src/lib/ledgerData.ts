// 월별 품목: 저장된 계산서 줄 → 평평한 행 → 묶음별 품목·월 집계
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { C, db } from './firebase';
import { commitBatch } from './db';
import { NO_CAT, stdOfText } from './catMatch';
import { lineQty } from './matching';
import { baseKey } from './itemNorm';
import type { Invoice, Site, SiteCategory, StandardCategory } from '../types';

export interface LRow {
  m: string; // YYYY-MM
  siteId: string;
  site: string;
  vendor: string;
  cat: string;
  item: string;
  spec: string;
  unit: string;
  qty: number;
  amt: number;
  date?: string;
  proc?: string;
  note?: string;
  bk: string; // 자동 판정 키
  ik: string; // 직접 합치기 반영 키
  invId: string;
  source: Invoice['source'];
}

export type Basis = 'site' | 'std' | 'raw';
export const UNCAT = '미분류';

export function buildRows(
  invoices: Invoice[],
  sites: Site[],
  cats: SiteCategory[],
  std: StandardCategory[],
  basis: Basis,
  alias: Record<string, string>,
): LRow[] {
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const catById = new Map(cats.map((c) => [c.id, c]));
  const stdById = new Map(std.map((s) => [s.id, s.name]));
  const out: LRow[] = [];
  for (const inv of invoices) {
    if (inv.submitted && !inv.appliedToLedger) continue; // 업체 포털 제출만 하고 반영 전 → 엑셀 계산서와 중복 방지
    const site = siteName.get(inv.siteId);
    if (!site) continue;
    for (const l of inv.lines) {
      const raw = (l.categoryText || '').trim();
      const sc = l.siteCategoryId ? catById.get(l.siteCategoryId) : undefined;
      const cat =
        basis === 'raw'
          ? raw && raw !== NO_CAT
            ? raw
            : UNCAT
          : basis === 'site'
            ? (sc?.name ?? UNCAT)
            : (sc?.standardCategoryId && stdById.get(sc.standardCategoryId)) || stdOfText(raw, std)?.name || UNCAT;
      const spec = (l.spec || '').trim() === '0' ? '' : (l.spec || '').trim();
      const bk = baseKey(l.itemName, spec);
      out.push({
        m: inv.month,
        siteId: inv.siteId,
        site,
        vendor: inv.vendorName,
        cat,
        item: l.itemName.trim(),
        spec,
        unit: l.unit,
        qty: lineQty(l),
        amt: l.finalAmount,
        date: l.receivedDate,
        proc: l.process,
        note: l.note,
        bk,
        ik: alias[bk] ?? bk,
        invId: inv.id,
        source: inv.source,
      });
    }
  }
  return out;
}

/* ===== 묶음 ===== */
export type GroupKey = 'site' | 'cat' | 'vendor';
export const GROUPS: [string, string][] = [
  ['site>cat', '현장 → 분류'],
  ['site>cat>vendor', '현장 → 분류 → 업체'],
  ['site>vendor', '현장 → 업체'],
  ['site', '현장'],
  ['cat', '분류'],
  ['cat>vendor', '분류 → 업체'],
  ['vendor', '업체'],
  ['none', '묶음 없음(품목 통합)'],
];
export const GLBL: Record<GroupKey, string> = { site: '현장', cat: '분류', vendor: '업체' };

export interface Cell {
  q: number;
  a: number;
  n: number;
  ps?: Set<string>; // 공정
}
export interface PItem {
  key: string;
  item: string;
  spec: string;
  unit: string;
  cat: string;
  names: Map<string, number>; // "품명\u0001규격" → 건수
  nameKey: Map<string, string>; // 표기 → 자동 키
  vendors: Set<string>;
  sites: Set<string>;
  cells: Record<string, Cell>;
  tq: number;
  ta: number;
  recs: LRow[];
}
export interface PGroup {
  path: string[];
  pk: string;
  list: PItem[];
}
export interface PSum {
  mt: Record<string, number>;
  mq: Record<string, number>;
  ta: number;
  tq: number;
  n: number;
}

const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
export const cmp = (a?: string, b?: string) => coll.compare(a ?? '', b ?? '');
const top1 = (o: Map<string, number>) => {
  let b = '';
  let n = -1;
  for (const [k, v] of o)
    if (v > n) {
      n = v;
      b = k;
    }
  return b;
};

/** 같은 품목 키마다 가장 많이 쓴 표기 (전체 자료 기준) */
export function canonNames(rows: LRow[]): Map<string, string> {
  const c = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const nm = `${r.item}\u0001${r.spec}`;
    const o = c.get(r.ik) ?? new Map<string, number>();
    o.set(nm, (o.get(nm) ?? 0) + 1);
    c.set(r.ik, o);
  }
  const out = new Map<string, string>();
  for (const [k, o] of c) out.set(k, top1(o));
  return out;
}

export function computePivot(rows: LRow[], gb: string, canon: Map<string, string>) {
  const gk = (gb === 'none' ? [] : gb.split('>')) as GroupKey[];
  const months = [...new Set(rows.map((r) => r.m))].sort();
  const G = new Map<string, { path: string[]; pk: string; items: Map<string, PItem & { units: Map<string, number>; cats: Map<string, number> }> }>();
  for (const r of rows) {
    const path = gk.map((k) => r[k]);
    const pk = path.join('\u0001');
    let g = G.get(pk);
    if (!g) G.set(pk, (g = { path, pk, items: new Map() }));
    let it = g.items.get(r.ik);
    if (!it) {
      it = { key: r.ik, item: r.item, spec: r.spec, unit: '', cat: '', names: new Map(), nameKey: new Map(), vendors: new Set(), sites: new Set(), cells: {}, tq: 0, ta: 0, recs: [], units: new Map(), cats: new Map() };
      g.items.set(r.ik, it);
    }
    const nm = `${r.item}\u0001${r.spec}`;
    it.names.set(nm, (it.names.get(nm) ?? 0) + 1);
    it.nameKey.set(nm, r.bk);
    const c = it.cells[r.m] ?? (it.cells[r.m] = { q: 0, a: 0, n: 0 });
    c.q += r.qty;
    c.a += r.amt;
    c.n++;
    if (r.proc && !/^[\d,.\s]+$/.test(r.proc)) (c.ps ?? (c.ps = new Set())).add(r.proc);
    it.tq += r.qty;
    it.ta += r.amt;
    it.units.set(r.unit, (it.units.get(r.unit) ?? 0) + 1);
    it.cats.set(r.cat, (it.cats.get(r.cat) ?? 0) + r.amt + 1);
    it.vendors.add(r.vendor);
    it.sites.add(r.site);
    it.recs.push(r);
  }
  const groups: PGroup[] = [...G.values()]
    .sort((a, b) => {
      for (let i = 0; i < a.path.length; i++) {
        const c = cmp(a.path[i], b.path[i]);
        if (c) return c;
      }
      return 0;
    })
    .map((g) => {
      const list = [...g.items.values()].map((it) => {
        const t = (canon.get(it.key) ?? top1(it.names)).split('\u0001');
        it.item = t[0];
        it.spec = t[1] ?? '';
        it.unit = top1(it.units);
        it.cat = top1(it.cats);
        return it as PItem;
      });
      list.sort((a, b) => cmp(a.item, b.item) || cmp(a.spec, b.spec));
      return { path: g.path, pk: g.pk, list };
    });
  // 묶음 단계별 합계 (현장 합계, 현장›분류 합계 …)
  const pre = new Map<string, PSum>();
  for (const g of groups)
    for (let L = 1; L <= g.path.length; L++) {
      const pk = g.path.slice(0, L).join('\u0001');
      let p = pre.get(pk);
      if (!p) pre.set(pk, (p = { mt: {}, mq: {}, ta: 0, tq: 0, n: 0 }));
      for (const it of g.list) {
        p.n++;
        p.ta += it.ta;
        p.tq += it.tq;
        for (const m in it.cells) {
          p.mt[m] = (p.mt[m] ?? 0) + it.cells[m].a;
          p.mq[m] = (p.mq[m] ?? 0) + it.cells[m].q;
        }
      }
    }
  const mt: Record<string, number> = {};
  let ta = 0;
  for (const r of rows) {
    mt[r.m] = (mt[r.m] ?? 0) + r.amt;
    ta += r.amt;
  }
  return { gk, months, groups, pre, mt, ta, nItems: groups.reduce((s, g) => s + g.list.length, 0) };
}
export type Pivot = ReturnType<typeof computePivot>;

/* ===== 품목 합치기 (회사 공용) ===== */
const ALIAS_DOC = 'itemAlias';
export function useItemAlias(enabled = true) {
  const [alias, setAlias] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(
      doc(db, C.ledgerMeta, ALIAS_DOC),
      (d) => {
        const pairs = (d.data()?.pairs ?? []) as [string, string][];
        setAlias(Object.fromEntries(pairs));
      },
      () => undefined,
    );
  }, [enabled]);
  return alias;
}
export async function saveItemAlias(alias: Record<string, string>) {
  await commitBatch([{ type: 'set', col: C.ledgerMeta, id: ALIAS_DOC, data: { pairs: Object.entries(alias), updatedAt: Date.now() }, merge: false }]);
}

/* ===== 표시 ===== */
export const mL = (m: string) => (m ? `${m.slice(2, 4)}.${m.slice(5, 7)}` : '');
export const mLong = (m: string) => (m ? `${m.slice(0, 4)}년 ${+m.slice(5, 7)}월` : '');
export const fmtA = (v: number) => (v ? Math.round(v).toLocaleString('ko-KR') : '');
export const fmtQ = (v: number) => (v ? (Math.round(v * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '');
export const fmtW = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e10 ? 0 : 2).replace(/\.?0+$/, '') + '억';
  if (a >= 1e4) return Math.round(v / 1e4).toLocaleString('ko-KR') + '만';
  return Math.round(v).toLocaleString('ko-KR');
};
