// 이름·규격·분류 표기를 비교하기 위한 정규화 함수 모음.

/** 전각 영숫자·기호를 반각으로 */
export function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** 업체명·현장명 비교용 키: 공백·법인표기·괄호기호 제거, 소문자 */
export function nameKey(s: unknown): string {
  return toHalfWidth(String(s ?? ''))
    .replace(/㈜|\(주\)|주식회사|\(유\)|유한회사/g, '')
    .replace(/[\s\n\r\t·.,:\-_/]/g, '')
    .toLowerCase();
}

/** 규격 비교용 키: 공백 제거, x/×/* 통일, 대문자 */
export function specKey(s: unknown): string {
  return toHalfWidth(String(s ?? ''))
    .replace(/[×xX*]/g, 'x')
    .replace(/\s+/g, '')
    .toUpperCase();
}

const TRADE_SUFFIX = /\((기계설비|소방설비|기계|소방|기|소)\)?$/;

/** 분류 비교용 키: 공종 꼬리표 제거, STS→SUS, 공백 제거 */
export function categoryKey(s: unknown): string {
  let t = toHalfWidth(String(s ?? '')).replace(/[\s\n\r]/g, '');
  // 끝에 붙은 공종 꼬리표 제거 — 잘린 표기 "(기계설" "(소방" 도 처리
  t = t.replace(/\((기계설비?|기계설|기계|소방설비?|소방설|소방)\)?$/, '');
  t = t.replace(TRADE_SUFFIX, '');
  t = t.replace(/STS/gi, 'SUS').replace(/스텐|스텐레스/g, 'SUS');
  return t.toUpperCase();
}

/** 분류 원문에서 공종 추정 */
export function tradeOf(s: unknown): '기계' | '소방' | undefined {
  const t = String(s ?? '');
  if (/소방/.test(t)) return '소방';
  if (/기계/.test(t)) return '기계';
  return undefined;
}

/** 숫자 변환 — 빈칸·문자는 0 */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = Number(String(v).replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 엑셀 날짜(일련번호·Date·문자열) → YYYY-MM-DD */
export function toDateStr(v: unknown, fallbackYear?: number): string | undefined {
  if (v == null || v === '' || v === 0 || v === '0') return undefined;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return undefined;
    // 엑셀 날짜를 Date로 읽으면 옛 시간대 보정 때문에 자정이 전날 23:59로 밀리는 경우가 있어 반나절 더해 날짜만 취한다
    return fmtDate(new Date(v.getTime() + 12 * 3600 * 1000));
  }
  if (typeof v === 'number') {
    if (v < 1) return undefined; // 시간만 있는 값
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m && fallbackYear) return `${fallbackYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return undefined;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** "26년07월" → "2026-07" */
export function parseYearMonth(s: unknown): string | undefined {
  const t = String(s ?? '');
  const m = t.match(/(\d{2,4})\s*년\s*(\d{1,2})\s*월/);
  if (!m) return undefined;
  const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  return `${y}-${m[2].padStart(2, '0')}`;
}

export function won(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

export function pct(a: number, b: number): string {
  if (!b) return '-';
  return `${((a / b) * 100).toFixed(1)}%`;
}

/** 두 문자열이 비슷한지 (포함 관계) */
export function looselyEqual(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y));
}
