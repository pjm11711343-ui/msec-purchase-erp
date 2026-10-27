// 계산서 '분류' 원문 → 현장분류 찾기 / 비슷한 분류 추천
import { categoryKey, nameKey } from './normalize';
import type { SiteCategory, StandardCategory } from '../types';

export const NO_CAT = '(분류 없음)';

/** 비교용 키: 공종 꼬리표·괄호·공백 제거 */
function k(s: string): string {
  return categoryKey(s).replace(/[()（）\[\]·.,\-_/\s]/g, '');
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out.length ? out : [s];
}

/** 0~1 유사도 */
export function similarity(a: string, b: string): number {
  const x = k(a);
  const y = k(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.6 + 0.3 * (Math.min(x.length, y.length) / Math.max(x.length, y.length));
  const bx = bigrams(x);
  const by = bigrams(y);
  const pool = [...by];
  let hit = 0;
  for (const g of bx) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  const dice = (2 * hit) / (bx.length + by.length);
  // 앞 글자가 2자 이상 같으면(예: 밸브류 ↔ 밸브+스트레나) 최소한 추천은 되게 한다
  let pre = 0;
  while (pre < Math.min(x.length, y.length) && x[pre] === y[pre]) pre++;
  return pre >= 2 ? Math.max(dice, 0.4 + 0.05 * Math.min(pre - 2, 4)) : dice;
}

const same = (a: string, b: string) => nameKey(a) === nameKey(b) || (k(a) !== '' && k(a) === k(b));

/** 원문이 '같은 것'으로 묶인 표준분류 (표준분류 이름 또는 원문 사전) */
export function stdOfText(text: string, std: StandardCategory[]): StandardCategory | undefined {
  const nk = nameKey(text);
  return std.find((s) => (s.aliases ?? []).some((a) => nameKey(a) === nk)) ?? std.find((s) => same(s.name, text));
}

/** 원문 → 현장분류 id ('' = 못 찾음). 현장분류 이름·계산서 표기 → 원문 사전(표준분류) 순 */
export function resolveCat(text: string, siteCats: SiteCategory[], std: StandardCategory[]): string {
  if (!text || text === NO_CAT) return '';
  const nk = nameKey(text);
  const direct = siteCats.find((c) => nameKey(c.name) === nk || (c.aliases ?? []).some((a) => nameKey(a) === nk));
  if (direct) return direct.id;
  const st = stdOfText(text, std);
  if (st) {
    const linked = siteCats.filter((c) => c.standardCategoryId === st.id);
    if (linked.length === 1) return linked[0].id;
    if (linked.length > 1) return [...linked].sort((a, b) => similarity(text, b.name) - similarity(text, a.name))[0].id;
  }
  const ck = k(text);
  return siteCats.find((c) => k(c.name) === ck)?.id ?? '';
}

export interface CatSuggestion {
  cat: SiteCategory;
  score: number;
}

/** 비슷한 현장분류 추천 (점수 높은 순) */
export function suggestCats(text: string, siteCats: SiteCategory[], std: StandardCategory[], n = 3): CatSuggestion[] {
  if (!text || text === NO_CAT) return [];
  return siteCats
    .map((cat) => {
      const st = std.find((s) => s.id === cat.standardCategoryId);
      const names = [cat.name, ...(cat.aliases ?? []), ...(st ? [st.name, ...(st.aliases ?? [])] : [])];
      return { cat, score: Math.max(...names.map((x) => similarity(text, x))) };
    })
    .filter((s) => s.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** 비슷한 표준분류 추천 */
export function suggestStd(text: string, std: StandardCategory[], n = 3): { std: StandardCategory; score: number }[] {
  return std
    .map((s) => ({ std: s, score: Math.max(...[s.name, ...(s.aliases ?? [])].map((x) => similarity(text, x))) }))
    .filter((s) => s.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
