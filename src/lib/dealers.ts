// 현장 대리점: 자재분류별 지정이 있으면 그것, 없으면 기본 대리점
import type { Site } from '../types';

export function dealersFor(site: Site | undefined, catId?: string): string[] {
  if (!site) return [];
  if (catId) {
    const r = site.dealerRules?.find((x) => x.catIds.includes(catId));
    if (r?.dealerIds.length) return r.dealerIds;
  }
  return site.dealerIds ?? [];
}
