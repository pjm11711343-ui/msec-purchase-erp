import { orderBy } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { C } from './firebase';
import { useCollection, useSiteScoped } from './db';
import type { LedgerEntry, Site, SiteCategory, StandardCategory, Vendor } from '../types';

export function useSites() {
  const { siteIds } = useAuth();
  const all = useCollection<Site>(C.sites, [orderBy('code')]);
  // 현장 사용자는 담당 현장만
  const data = siteIds === null ? all.data : all.data.filter((s) => siteIds.includes(s.id));
  return { ...all, data };
}

export function useVendors() {
  return useCollection<Vendor>(C.vendors, [orderBy('name')]);
}

export function useStandardCategories() {
  return useCollection<StandardCategory>(C.standardCategories, [orderBy('order')]);
}

export function useSiteCategories() {
  const { siteIds } = useAuth();
  return useSiteScoped<SiteCategory>(C.siteCategories, siteIds);
}

export function useLedger() {
  const { siteIds } = useAuth();
  return useSiteScoped<LedgerEntry>(C.ledger, siteIds);
}

export interface SummaryRow {
  cat: SiteCategory;
  migrated: number;
  byMonth: Record<string, number>;
  afterCutoff: number;
  input: number;
  rate: number; // 실행 대비
  remain: number; // 실행 - 투입
}

export function summarize(cats: SiteCategory[], ledger: LedgerEntry[]): { rows: SummaryRow[]; months: string[] } {
  const monthSet = new Set<string>();
  const byCat = new Map<string, Record<string, number>>();
  for (const e of ledger) {
    monthSet.add(e.month);
    const m = byCat.get(e.siteCategoryId) ?? {};
    m[e.month] = (m[e.month] ?? 0) + e.amount;
    byCat.set(e.siteCategoryId, m);
  }
  const rows = [...cats]
    .sort((a, b) => a.order - b.order)
    .map((cat) => {
      const byMonth = byCat.get(cat.id) ?? {};
      const afterCutoff = Object.values(byMonth).reduce((a, b) => a + b, 0);
      const input = (cat.migratedInput ?? 0) + afterCutoff;
      const exec = cat.execAmount ?? 0;
      return { cat, migrated: cat.migratedInput ?? 0, byMonth, afterCutoff, input, rate: exec ? input / exec : 0, remain: exec - input };
    });
  return { rows, months: [...monthSet].sort() };
}
