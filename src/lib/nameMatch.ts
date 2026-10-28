// 다른 프로그램·파일에 적힌 현장명·업체명 → ERP 현장·업체 찾기
import { looselyEqual, nameKey } from './normalize';
import type { Site, Vendor } from '../types';

function bigr(s: string): string[] {
  const t = s.replace(/[\s()（）[\]_&·.,-]/g, '').toUpperCase();
  const a: string[] = [];
  for (let i = 0; i < t.length - 1; i++) a.push(t.slice(i, i + 2));
  return a;
}
function dice(a: string, b: string): number {
  const A = bigr(a);
  const B = bigr(b);
  if (!A.length || !B.length) return 0;
  const m = new Map<string, number>();
  for (const x of A) m.set(x, (m.get(x) ?? 0) + 1);
  let n = 0;
  for (const x of B) {
    const c = m.get(x);
    if (c) {
      n++;
      m.set(x, c - 1);
    }
  }
  return (2 * n) / (A.length + B.length);
}
const GENERIC = /푸르지오|푸리지오|우미린|신축공사|공사|현장|기계|소방|\d*블[럭록]|\d*공구|민간참여|공공주택|아파트/g;
const core = (t: string) => t.replace(GENERIC, '');
const kind = (t: string) => (/소방/.test(t) ? 'F' : /기계/.test(t) ? 'M' : '');

/** 현장명 → ERP 현장 id ('' = 못 찾음) */
export function matchSite(name: string, sites: Site[]): string {
  if (!name) return '';
  const k = nameKey(name);
  const names = (s: Site) => [s.name, s.fullName, ...(s.aliases ?? [])].filter(Boolean) as string[];
  const exact = sites.filter((s) => names(s).some((x) => nameKey(x) === k));
  const tk = kind(name);
  const pickKind = (L: Site[]) => (L.length === 1 ? L[0] : (tk && L.find((s) => kind(s.trade + s.name) === tk)) || undefined);
  if (exact.length) return pickKind(exact)?.id ?? '';
  const loose = sites.filter((s) => [...names(s), s.groupName ?? ''].some((x) => x && looselyEqual(x, name)));
  if (loose.length) return pickKind(loose)?.id ?? '';
  // 흔한 단어(푸르지오·기계·소방 등)를 뺀 고유 이름끼리 비교
  let best = '';
  let bs = 0;
  for (const s of sites) {
    let sc = Math.max(...names(s).map((x) => dice(core(name), core(x))));
    const k1 = tk;
    const k2 = kind(s.trade + ' ' + s.name);
    if (k1 && k2) sc += k1 === k2 ? 0.15 : -0.15;
    if (sc > bs) {
      bs = sc;
      best = s.id;
    }
  }
  return bs >= 0.45 ? best : '';
}

/** 업체명 → ERP 업체 */
export function matchVendor(name: string, vendors: Vendor[]): Vendor | undefined {
  const k = nameKey(name);
  if (!k) return undefined;
  return vendors.find((v) => nameKey(v.name) === k || (v.aliases ?? []).some((a) => nameKey(a) === k)) ?? vendors.find((v) => nameKey(v.name).length >= 3 && (k.includes(nameKey(v.name)) || nameKey(v.name).includes(k)));
}
