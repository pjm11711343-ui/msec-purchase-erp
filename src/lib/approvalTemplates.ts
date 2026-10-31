// 결재선 틀 (2단계 / 전자결재 7칸)
//  - '6칸'은 예전 이름(내부 값)을 그대로 쓰고, 화면에는 "전자결재 7칸"으로 보인다
import type { ApprovalLine } from '../types';

export const TEMPLATES: Record<ApprovalLine['type'], string[]> = {
  '2단계': ['현장소장', '자재부'],
  '6칸': ['현장 담당', '현장 소장', '본사 담당', '본사 담당', '본사 팀장', '본사 사장', '본사 대표이사'],
};
export const TYPE_LABEL: Record<ApprovalLine['type'], string> = { '2단계': '2단계', '6칸': '전자결재 7칸' };

/** 예전 6칸 결재선(현장 담당·현장 소장·본사 담당·팀장·임원·대표)을 새 7칸으로 옮긴다 (지정된 결재자는 같은 자리로) */
export function upgradeSteps<T extends { label: string; userId?: string; userName?: string }>(type: ApprovalLine['type'], steps: T[]): T[] {
  if (type !== '6칸') return steps;
  const want = TEMPLATES['6칸'];
  if (steps.length === want.length && steps.every((s, i) => s.label === want[i])) return steps;
  const key = (l: string) => l.replace(/\s/g, '');
  const pick = (re: RegExp) => steps.find((s) => re.test(key(s.label)));
  const hqStaff = steps.filter((s) => /^본사담당|^자재부/.test(key(s.label)));
  const from = [pick(/^현장담당/), pick(/^현장소장|^소장/), hqStaff[0], hqStaff[1], pick(/팀장/), pick(/사장|임원/), pick(/대표/)];
  return want.map((label, i) => ({ label, ...(from[i]?.userId ? { userId: from[i]!.userId } : {}), ...(from[i]?.userName ? { userName: from[i]!.userName } : {}) }) as unknown as T);
}

/** 결재란 칸 머리글: "본사 대표이사" → "대표이사", "현장 담당" → "담당" */
export const boxLabel = (label: string) => label.replace(/^(현장|본사)\s*/, '').trim() || label;
export const isSiteStepLabel = (label: string) => /^현장/.test(label.replace(/\s/g, '')) || /^소장/.test(label.replace(/\s/g, ''));
