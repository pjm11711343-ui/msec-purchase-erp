// 5단계: 계산서 줄 ↔ 발주 줄 · 입고 자동매칭, 투입원장 반영
import { C } from './firebase';
import { commitBatch, fetchWhere } from './db';
import { priceKey } from './prices';
import { poLineKey } from './receipts';
import type { Invoice, InvoiceLine, LedgerEntry, PoLine, PurchaseOrder, Receipt } from '../types';

export interface Candidate {
  po: PurchaseOrder;
  line: PoLine;
  key: string; // `${poId}#${poLineKey}`
  received: number;
  billed: number; // 다른 계산서에서 이미 청구된 수량
  avail: number; // 청구 가능 = 입고 - 기청구
}

export const lineQty = (l: InvoiceLine) => l.changedQty ?? l.qty;
export const linePrice = (l: InvoiceLine) => l.changedPrice ?? l.unitPrice;

/** 다른 계산서에서 이미 청구된 수량: `${poId}#${poLineKey}` → 수량 */
export function billedMap(invoices: Invoice[], excludeId?: string) {
  const m = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.id === excludeId) continue;
    for (const l of inv.lines) if (l.poId && l.poLineKey) m.set(`${l.poId}#${l.poLineKey}`, (m.get(`${l.poId}#${l.poLineKey}`) ?? 0) + lineQty(l));
  }
  return m;
}

export function candidatesFor(l: InvoiceLine, inv: Pick<Invoice, 'vendorId' | 'siteId' | 'id'>, pos: PurchaseOrder[], receipts: Receipt[], billed: Map<string, number>): Candidate[] {
  const k = priceKey(l.itemName, l.spec);
  const rec = new Map<string, number>();
  for (const r of receipts) rec.set(`${r.poId}#${r.lineKey}`, (rec.get(`${r.poId}#${r.lineKey}`) ?? 0) + r.qty);
  const out: Candidate[] = [];
  for (const po of pos) {
    if (po.status === 'cancelled' || po.vendorId !== inv.vendorId || po.siteId !== inv.siteId) continue;
    for (const pl of po.lines) {
      if (priceKey(pl.itemName, pl.spec) !== k) continue;
      const key = `${po.id}#${poLineKey(pl)}`;
      const received = rec.get(key) ?? 0;
      const b = billed.get(key) ?? 0;
      out.push({ po, line: pl, key, received, billed: b, avail: received - b });
    }
  }
  // 발주일이 계산서 줄 발주일과 같은 것 → 오래된 발주 순
  return out.sort((a, b) => Number(b.po.orderDate === l.orderDate) - Number(a.po.orderDate === l.orderDate) || a.po.orderDate.localeCompare(b.po.orderDate));
}

/** 계산서 한 장 자동매칭. 수동으로 지정한 줄(manual)은 그대로 둔다. */
export function autoMatch(inv: Invoice, pos: PurchaseOrder[], receipts: Receipt[], otherInvoices: Invoice[], tolerance: number): InvoiceLine[] {
  const billed = billedMap(otherInvoices, inv.id);
  // 이 계산서 안에서 먼저 잡은 줄 수량도 빼 가면서 배정
  const used = new Map<string, number>();
  for (const l of inv.lines) if (l.matchStatus === 'manual' && l.poId && l.poLineKey) used.set(`${l.poId}#${l.poLineKey}`, (used.get(`${l.poId}#${l.poLineKey}`) ?? 0) + lineQty(l));
  return inv.lines.map((l) => {
    if (l.matchStatus === 'migrated' || l.matchStatus === 'manual') return l;
    const base: InvoiceLine = { ...l };
    delete base.poId;
    delete base.poLineKey;
    delete base.matchIssue;
    const q = lineQty(l);
    if (q <= 0) return { ...base, matchStatus: 'matched' }; // 반품·0원 줄은 확인만
    const cands = candidatesFor(l, inv, pos, receipts, billed);
    if (!cands.length) return { ...base, matchStatus: 'unmatched', matchIssue: '미발주' };
    const left = (c: Candidate) => c.avail - (used.get(c.key) ?? 0);
    const fit = cands.find((c) => left(c) >= q) ?? cands.find((c) => c.received === 0 && c.line.qty - c.billed - (used.get(c.key) ?? 0) >= q);
    const pick = fit ?? cands[0];
    used.set(pick.key, (used.get(pick.key) ?? 0) + q);
    const link = { poId: pick.po.id, poLineKey: poLineKey(pick.line), siteCategoryId: l.siteCategoryId ?? pick.line.siteCategoryId };
    let issue: InvoiceLine['matchIssue'];
    if (!fit) issue = '수량초과';
    else if (pick.received === 0) issue = '미입고';
    else if (Math.abs(linePrice(l) - pick.line.price) > tolerance && pick.line.price > 0) issue = '단가차이';
    return { ...base, ...link, matchStatus: issue ? 'unmatched' : 'matched', ...(issue ? { matchIssue: issue } : {}) };
  });
}

export function matchSummary(inv: Invoice) {
  const ls = inv.lines.filter((l) => l.matchStatus !== 'migrated');
  const ok = ls.filter((l) => l.matchStatus === 'matched' || l.matchStatus === 'manual').length;
  const issues: Record<string, number> = {};
  ls.forEach((l) => l.matchIssue && (issues[l.matchIssue] = (issues[l.matchIssue] ?? 0) + 1));
  return { total: ls.length, ok, issues };
}

/** 투입원장 다시 쓰기: 이 계산서의 이전 원장 기록을 지우고 분류별 합계로 새로 만든다 */
export async function rebuildLedger(inv: Invoice, extra: Parameters<typeof commitBatch>[0] = []) {
  const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', inv.id);
  const ops: Parameters<typeof commitBatch>[0] = [...extra, ...old.map((e) => ({ type: 'delete' as const, col: C.ledger, id: e.id }))];
  if (inv.appliedToLedger) {
    const agg = new Map<string, number>();
    for (const l of inv.lines) if (l.siteCategoryId) agg.set(l.siteCategoryId, (agg.get(l.siteCategoryId) ?? 0) + l.finalAmount);
    agg.forEach((amount, cid) => {
      const e: Omit<LedgerEntry, 'id'> = { siteId: inv.siteId, siteCategoryId: cid, month: inv.month, amount: Math.round(amount), source: 'invoice', invoiceId: inv.id, createdAt: Date.now() };
      ops.push({ type: 'set', col: C.ledger, id: `${inv.id}__${cid}`, data: e, merge: false });
    });
  }
  await commitBatch(ops);
}
