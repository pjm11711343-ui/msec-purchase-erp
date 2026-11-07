// 1식 분류: 구매청구서 계약내역을 수량 '1식' · 단가 '금액'(투입집계 변경예상금액, 없으면 도급금액)으로 보여 준다
//  - 붙어 있는 같은 분류 줄은 계약내역 칸을 합쳐서 한 번만
import { nameKey } from './normalize';
import type { SiteCategory } from '../types';

export const LUMP_CATS = ['소모잡자재', '공구손료', '조립식가대', 'SUPPORT', '안전장비류', '가설공사', '가설공사+가설울타리공사', '명판'];
const KEYS = new Set(LUMP_CATS.map((x) => nameKey(x).toLowerCase()));
/** 괄호 안 내용은 빼고 비교 (예: 소모잡자재(기계설비) · 공구손료(소방설비) → 소모잡자재 · 공구손료) */
export const isLumpCat = (name?: string) => !!name && KEYS.has(nameKey(name.replace(/[(（［\[][^)）］\]]*[)）］\]]/g, '')).toLowerCase());
/** 1식 금액: 변경예상금액, 없으면 도급금액 */
export const lumpAmount = (c: Pick<SiteCategory, 'changeAmount' | 'contractAmount'>) => c.changeAmount || c.contractAmount || 0;

export interface LumpCell {
  catId: string;
  name: string;
  amount: number;
  span: number; // 합친 칸의 첫 줄이면 줄 수, 이어지는 줄이면 0
}
/**
 * 줄마다 1식 정보. breakBefore(i)가 true면 그 줄에서 합치기를 끊는다 (엑셀 쪽 넘김 등)
 */
export function lumpCells(lines: { siteCategoryId?: string }[], cats: SiteCategory[], breakBefore?: (i: number) => boolean): (LumpCell | null)[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out: (LumpCell | null)[] = lines.map((l) => {
    const c = l.siteCategoryId ? byId.get(l.siteCategoryId) : undefined;
    return c && isLumpCat(c.name) ? { catId: c.id, name: c.name, amount: lumpAmount(c), span: 1 } : null;
  });
  let head = -1;
  out.forEach((x, i) => {
    const prev = out[i - 1];
    if (x && prev && prev.catId === x.catId && head >= 0 && !breakBefore?.(i)) {
      out[head]!.span++;
      x.span = 0;
    } else head = x ? i : -1;
  });
  return out;
}
