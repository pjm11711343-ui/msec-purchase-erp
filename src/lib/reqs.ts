import { deleteField, orderBy } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { commitBatch, useCollection, useSiteScoped } from './db';
import { C } from './firebase';
import { priceKey } from './prices';
import type { ApprovalLine, ErpUser, ReqLine, Requisition } from '../types';

/**
 * 결재자(대표·사장 등 executive)는 앞 단계(관리자·자재부 등) 결재가 끝나 자기 차례가 오기 전에는 청구서를 볼 수 없다.
 * 볼 수 있는 것: 최종 승인된 청구서, 결재 중이면서 자기 칸까지 차례가 온 청구서(이미 결재한 것 포함)
 */
export function execCanSee(r: Requisition, uid?: string): boolean {
  if (r.status === 'approved') return true;
  if (!uid) return false;
  const mine = r.steps.map((s, i) => (s.userId === uid ? i : -1)).filter((i) => i >= 0);
  if (!mine.length) return false;
  if (r.steps.some((s) => s.userId === uid && s.result)) return true; // 이미 결재(승인·반려)한 청구서
  // 본사 팀장 칸은 본사 담당 승인 전에도 먼저 결재할 수 있으므로 결재 중이면 보인다
  return r.status === 'pending' && mine.some((i) => i <= r.currentStep || /팀장/.test(r.steps[i].label));
}

export function useRequisitions() {
  const { siteIds, profile } = useAuth();
  const all = useCollection<Requisition>(C.requisitions, [orderBy('createdAt', 'desc')], '', siteIds === null);
  const scoped = useSiteScoped<Requisition>(C.requisitions, siteIds === null ? [] : siteIds);
  const src = siteIds === null ? all : scoped;
  const isExec = profile?.role === 'executive';
  const sorted = [...src.data].filter((r) => !isExec || execCanSee(r, profile?.id)).sort((a, b) => b.createdAt - a.createdAt);
  // 휴지통에 있는 청구서는 목록·기반입·집계에서 뺀다
  const data = sorted.filter((r) => !r.deletedAt);
  const trash = sorted.filter((r) => r.deletedAt).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return { ...src, data, trash };
}

export function useApprovalLines() {
  return useCollection<ApprovalLine>(C.approvalLines);
}

export function useUsers() {
  return useCollection<ErpUser>(C.users, [orderBy('name')]);
}

/**
 * 기반입: 같은 현장의 승인된 청구를 시간순으로 누적한다.
 * 엑셀로 들어온 청구에 기반입 값이 있으면(이관) 그 값에서 다시 시작한다.
 */
export function priorQtyMap(reqs: Requisition[], siteId: string, excludeId?: string): Map<string, number> {
  const run = new Map<string, number>();
  const list = reqs.filter((r) => r.siteId === siteId && r.id !== excludeId && r.status === 'approved').sort((a, b) => (a.approvedAt ?? a.createdAt) - (b.approvedAt ?? b.createdAt));
  for (const r of list)
    for (const l of r.lines) {
      const k = priceKey(l.itemName, l.spec);
      run.set(k, (l.priorQtyManual ?? run.get(k) ?? 0) + (l.reqQty || 0));
    }
  return run;
}

/** 직전 발주단가 (같은 품명·규격, 가장 최근 승인 청구) */
export function lastOrderPrice(reqs: Requisition[], item: string, spec: string): { price: number; vendorId?: string; vendorName?: string; date: string } | undefined {
  const k = priceKey(item, spec);
  for (const r of reqs) {
    if (r.status !== 'approved') continue;
    const l = r.lines.find((x) => priceKey(x.itemName, x.spec) === k && x.orderPrice > 0);
    if (l) return { price: l.orderPrice, vendorId: l.vendorId, vendorName: l.vendorName, date: r.requestDate };
  }
  return undefined;
}

export function lineAmount(l: ReqLine) {
  return Math.round((l.orderQty || 0) * (l.orderPrice || 0));
}

export function newLine(): ReqLine {
  return {
    key: Math.random().toString(36).slice(2, 10),
    itemName: '',
    spec: '',
    unit: '',
    contractQty: 0,
    contractPrice: 0,
    execQty: 0,
    priorQty: 0,
    reqQty: 0,
    orderQty: 0,
    orderPrice: 0,
  };
}

export { bonNote, bonText, pipeLength } from './pipe';

/** 휴지통에서 복원 */
export async function restoreReq(r: Requisition, who: string) {
  await commitBatch([
    { type: 'set', col: C.requisitions, id: r.id, data: { deletedAt: deleteField(), deletedBy: deleteField(), deletedByName: deleteField(), history: [...r.history, { at: Date.now(), by: who, action: '휴지통에서 복원' }] } },
  ]);
}

/** 휴지통에서 영구 삭제 (관리자) */
export async function purgeReq(r: Requisition) {
  await commitBatch([{ type: 'delete', col: C.requisitions, id: r.id }]);
}
