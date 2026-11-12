// 구매청구 '새 청구' 표시: 현장별로 마지막에 본 시각을 이 브라우저에 기억
import type { Requisition } from '../types';

export interface Seen {
  init: number; // 처음 쓴 시각 (그 전 청구는 새것으로 안 봄)
  all: number; // [전체] 카드를 마지막으로 본 시각
  sites: Record<string, number>;
}
const key = (uid?: string) => `erp.reqSeen:${uid ?? ''}`;

export function readSeen(uid?: string): Seen {
  try {
    const v = JSON.parse(localStorage.getItem(key(uid)) ?? 'null') as Seen | null;
    if (v && typeof v.init === 'number') return { init: v.init, all: v.all ?? 0, sites: v.sites ?? {} };
  } catch {
    /* 무시 */
  }
  const s: Seen = { init: Date.now(), all: 0, sites: {} };
  writeSeen(uid, s);
  return s;
}
export function writeSeen(uid: string | undefined, s: Seen) {
  try {
    localStorage.setItem(key(uid), JSON.stringify(s));
  } catch {
    /* 저장 못 해도 동작은 그대로 */
  }
}
/** 청구서가 마지막으로 바뀐 시각 */
export const reqStamp = (r: Requisition) => Math.max(r.updatedAt ?? 0, r.submittedAt ?? 0, r.approvedAt ?? 0, r.createdAt ?? 0);
/** 내가 본 뒤에 남이 올리거나 바꾼 청구서 */
export function isNewReq(r: Requisition, s: Seen, myName?: string): boolean {
  if (r.status === 'draft') return false;
  const last = r.history?.at(-1);
  if (last && myName && last.by === myName) return false;
  return reqStamp(r) > Math.max(s.init, s.all, s.sites[r.siteId] ?? 0);
}
/** 결재가 멈춘 날수 (결재 중일 때만, 아니면 0) */
export function stalledDays(r: Requisition, now = Date.now()): number {
  if (r.status !== 'pending') return 0;
  const since = Math.max(r.submittedAt ?? 0, ...r.steps.map((s) => s.at ?? 0));
  return since ? Math.floor((now - since) / 86400000) : 0;
}
export const STALL_DAYS = 3;
