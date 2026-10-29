// 구매청구서 하단 요약: 자재분류별 계약·변경(예상)·실행·기반입·금회청구 + 금회청구 업체별 금액
//  - 분류: 현장 투입집계 분류 전체 (순서대로) + 분류가 없는 줄은 '미분류'
//  - 기반입금액: 이 청구서보다 먼저 올린 같은 현장 청구서(결재 중·승인)의 발주 금액.
//    발주된 줄은 발주서 금액, 아직 발주 전인 줄은 청구서 발주결의 금액
//  - 금회청구: 이 청구서 줄 (발주수량 없으면 청구수량) × 발주단가
import type { PurchaseOrder, ReqLine, Requisition, SiteCategory } from '../types';

export const NO_CAT = '__none__';
export const NO_VENDOR = '거래선 미지정';

export interface SumRow {
  id: string; // 분류 id (미분류 = NO_CAT)
  name: string;
  contract: number;
  change: number;
  exec: number;
  prior: number;
  current: number;
  byVendor: Record<string, number>;
}
export interface VendorSum {
  name: string;
  lines: number;
  amount: number;
}
export interface ReqSummary {
  rows: SumRow[];
  vendors: VendorSum[]; // 금회청구 금액 큰 순
  total: Omit<SumRow, 'id' | 'name' | 'byVendor'> & { byVendor: Record<string, number> };
}

const amt = (l: ReqLine) => Math.round((l.orderQty || l.reqQty || 0) * (l.orderPrice || 0));

export function reqSummary(
  req: { id?: string; siteId: string; requestDate: string; createdAt?: number; lines: ReqLine[] },
  cats: SiteCategory[],
  reqs: Requisition[],
  pos: PurchaseOrder[],
): ReqSummary {
  const siteCats = cats.filter((c) => c.siteId === req.siteId).sort((a, b) => a.order - b.order);
  const catIds = new Set(siteCats.map((c) => c.id));
  const catOf = (id?: string) => (id && catIds.has(id) ? id : NO_CAT);
  const me = req.createdAt ?? Date.now();

  // 이 청구서보다 먼저 올린 청구서
  const earlier = reqs.filter(
    (r) =>
      r.id !== req.id &&
      r.siteId === req.siteId &&
      (r.status === 'approved' || r.status === 'pending') &&
      (r.requestDate < req.requestDate || (r.requestDate === req.requestDate && (r.createdAt ?? 0) < me)),
  );
  const earlierIds = new Set(earlier.map((r) => r.id));
  const prior = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  // 발주된 줄: 발주서 금액
  const ordered = new Set<string>();
  for (const p of pos) {
    if (p.status === 'cancelled' || p.siteId !== req.siteId) continue;
    for (const l of p.lines) {
      const known = earlierIds.has(l.reqId);
      // 청구서가 없는(이관 등) 발주는 발주일로 판단
      if (!known && (l.reqId === req.id || reqs.some((r) => r.id === l.reqId) || p.orderDate > req.requestDate)) continue;
      ordered.add(`${l.reqId}|${l.lineKey}`);
      add(prior, catOf(l.siteCategoryId), l.amount || 0);
    }
  }
  // 아직 발주 전인 줄: 청구서 금액
  for (const r of earlier) for (const l of r.lines) if (l.itemName && !ordered.has(`${r.id}|${l.key}`)) add(prior, catOf(l.siteCategoryId), amt(l));

  // 금회청구
  const cur = new Map<string, number>();
  const curV = new Map<string, Record<string, number>>();
  const vend = new Map<string, VendorSum>();
  for (const l of req.lines) {
    if (!l.itemName?.trim()) continue;
    const c = catOf(l.siteCategoryId);
    const a = amt(l);
    const v = l.vendorName?.trim() || NO_VENDOR;
    add(cur, c, a);
    const bv = curV.get(c) ?? {};
    bv[v] = (bv[v] ?? 0) + a;
    curV.set(c, bv);
    const vs = vend.get(v) ?? { name: v, lines: 0, amount: 0 };
    vs.lines++;
    vs.amount += a;
    vend.set(v, vs);
  }

  const rows: SumRow[] = siteCats.map((c) => ({
    id: c.id,
    name: c.name,
    contract: c.contractAmount || 0,
    change: c.changeAmount || 0,
    exec: c.execAmount || 0,
    prior: prior.get(c.id) ?? 0,
    current: cur.get(c.id) ?? 0,
    byVendor: curV.get(c.id) ?? {},
  }));
  if (prior.get(NO_CAT) || cur.get(NO_CAT)) rows.push({ id: NO_CAT, name: '미분류', contract: 0, change: 0, exec: 0, prior: prior.get(NO_CAT) ?? 0, current: cur.get(NO_CAT) ?? 0, byVendor: curV.get(NO_CAT) ?? {} });

  const vendors = [...vend.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ko'));
  const total = rows.reduce(
    (t, r) => {
      t.contract += r.contract;
      t.change += r.change;
      t.exec += r.exec;
      t.prior += r.prior;
      t.current += r.current;
      for (const [k, v] of Object.entries(r.byVendor)) t.byVendor[k] = (t.byVendor[k] ?? 0) + v;
      return t;
    },
    { contract: 0, change: 0, exec: 0, prior: 0, current: 0, byVendor: {} as Record<string, number> },
  );
  return { rows, vendors, total };
}
