// 같은 품목 판정 (기존 '계산서 월별 품목 관리' 프로그램과 같은 규칙)
//  - 띄어쓰기·대소문자·앞에 붙은 기호(★ ※ · 등) 무시
//  - 흔한 표기 차이 통일 (닙블→니플, 엘보우→엘보, 후렌지→플랜지 …)
//  - 규격: × * → X, 숫자 뒤 A·L·H·T 단위는 있으나 없으나 같게 (100A = 100)

const clean = (v: unknown) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const keyOf = (s: string) => clean(s).toUpperCase().replace(/\s+/g, '');
const LEAD_SYM = /^[\s★☆✩✪✦✧※＊*·∙•◦‣▶▷►▸◆◇■□▪▫●○◎△▲▽▼.]+/;
export const stripLead = (v: unknown) => String(v == null ? '' : v).replace(LEAD_SYM, '');

const SYN: [RegExp, string][] = [
  [/닙블|닛블|니블|니쁠|닙플/g, '니플'],
  [/엘보우/g, '엘보'],
  [/레듀샤|레듀서|레듀사|리듀샤|리듀서|레듀셔/g, '레듀샤'],
  [/붓싱|부씽|붓씽/g, '부싱'],
  [/소케트/g, '소켓'],
  [/티이/g, '티'],
  [/후렌지|후랜지|플렌지|프랜지|프렌지/g, '플랜지'],
  [/벨브|발브/g, '밸브'],
  [/스트레이너|스트레너/g, '스트레나'],
  [/후렉시블|플렉시블|플렉서블|후렉시볼|후렉서블/g, '플렉시블'],
  [/스테인레스|스텐레스|스테인리스/g, '스텐'],
  [/써비스/g, '서비스'],
  [/싸이폰/g, '사이폰'],
  [/죠인트/g, '조인트'],
  [/덕타일/g, '닥타일'],
  [/메커니컬|메카니컬/g, '메카니칼'],
  [/카플링|카프링/g, '커플링'],
  [/유니언/g, '유니온'],
];

export function normItem(s: unknown): string {
  let k = keyOf(stripLead(s));
  for (const [re, t] of SYN) k = k.replace(re, t);
  return k;
}

export function normSpec(s: unknown): string {
  const k = keyOf(stripLead(s)).replace(/[×✕Ｘ*]/g, 'X').replace(/[ΦφØø]|파이/g, 'Φ');
  return k
    .split('X')
    .map((t) => t.replace(/(\d)\s*[ALHT](?![A-Z0-9])/g, '$1'))
    .join('X');
}

/** 자동 판정 키 (품명|규격) */
export const baseKey = (item: unknown, spec: unknown) => `${normItem(item)}|${normSpec(spec)}`;

/** 직접 합친 품목까지 반영한 키 */
export const itemKeyOf = (item: unknown, spec: unknown, alias: Record<string, string>) => {
  const k = baseKey(item, spec);
  return alias[k] ?? k;
};
