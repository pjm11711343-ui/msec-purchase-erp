// 프로그램 기준 품명·규격 목록 (청구서와 같은 기준)
//  = 월별 품목명세(계산서) 품목 + 직접 등록·요청 품목 + ERP 단가표 + 단가관리 단가표 (숨긴 품목 제외)
//  - 다른 표기는 "품명 다른 표기"(회사 공용 기억)로 기준 품명·규격에 맞춘다
import { useMemo } from 'react';
import { similarity } from './catMatch';
import { useItemCatalog } from './itemCatalog';
import { itemKey, useItemEntries, usePriceList } from './itemMaster';
import { normItem, normSpec } from './itemNorm';
import { usePrices } from './prices';
import { aliasKey, useReqAliases } from './reqAlias';

export interface Recognized {
  itemName: string;
  spec: string;
  status: 'std' | 'alias' | 'unknown'; // 기준 품명 그대로 / 다른 표기로 인식 / 못 찾음
}

export function useStdItems() {
  const catalog = useItemCatalog();
  const entries = useItemEntries();
  const priceList = usePriceList();
  const prices = usePrices();
  const aliases = useReqAliases();
  const lists = useMemo(() => {
    const hidden = new Set(entries.data.filter((e) => e.status === 'hidden').map((e) => itemKey(e.itemName, e.spec)));
    const items = new Map<string, string>();
    const specs = new Map<string, Map<string, string>>();
    const units = new Map<string, string>();
    const put = (item: string, spec: string, unit: string) => {
      const ni = normItem(item);
      if (!ni || hidden.has(itemKey(item, spec))) return;
      if (!items.has(ni)) items.set(ni, item.trim());
      const sp = (spec ?? '').trim();
      if (sp) {
        const m = specs.get(ni) ?? new Map<string, string>();
        if (!m.has(normSpec(sp))) m.set(normSpec(sp), sp);
        specs.set(ni, m);
      }
      const k = `${ni}|${normSpec(sp)}`;
      if (unit && !units.has(k)) units.set(k, unit.trim());
    };
    catalog.items.forEach((c) => put(c.i, c.s, c.u));
    entries.data.forEach((e) => (e.status === 'active' || e.status === 'requested') && put(e.itemName, e.spec, e.unit));
    priceList.data.forEach((p) => put(p.itemName, p.spec, p.unit));
    prices.rows.forEach((p) => put(p.itemName, p.spec, p.unit));
    return { items, specs, units };
  }, [catalog.items, entries.data, priceList.data, prices.rows]);
  const aliasMap = useMemo(() => new Map(aliases.list.map((a) => [aliasKey(a.fromItem, a.fromSpec), a])), [aliases.list]);
  const itemOptions = useMemo(() => [...lists.items.values()].sort((a, b) => a.localeCompare(b, 'ko')), [lists]);

  const sizeOf = (s: string) => {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const specOptions = (item: string) => [...(lists.specs.get(normItem(item))?.values() ?? [])].sort((a, b) => sizeOf(a) - sizeOf(b) || a.localeCompare(b, 'ko'));
  const hasItem = (item: string) => lists.items.has(normItem(item));
  const specOk = (item: string, spec: string) => !spec.trim() || specOptions(item).some((x) => normSpec(x) === normSpec(spec));
  const unitOf = (item: string, spec: string) => lists.units.get(`${normItem(item)}|${normSpec(spec)}`) ?? '';
  const isStd = (item: string, spec: string) => !!item.trim() && hasItem(item) && specOk(item, spec);

  /** 적힌 품명·규격 → 기준 품명·규격 (그대로 있음 → 다른 표기 기억 → 못 찾음) */
  const recognize = (item0: string, spec0: string): Recognized => {
    const item = item0.trim();
    const spec = (spec0 ?? '').trim();
    const ni = normItem(item);
    if (hasItem(item) && (!spec || specOk(item, spec))) return { itemName: lists.items.get(ni) ?? item, spec: spec ? (lists.specs.get(ni)?.get(normSpec(spec)) ?? spec) : '', status: 'std' };
    const a = aliasMap.get(aliasKey(item, spec));
    if (a && hasItem(a.toItem)) return { itemName: a.toItem, spec: a.toSpec, status: 'alias' };
    return { itemName: item, spec, status: 'unknown' };
  };
  /** 비슷한 기준 품명·규격 후보 3개 */
  const suggest = (item: string, spec: string): { i: string; s: string }[] => {
    const ni = normItem(item);
    const scored = itemOptions.map((o) => ({ o, sc: similarity(ni, normItem(o)) })).filter((x) => x.sc > 0.3);
    scored.sort((a, b) => b.sc - a.sc);
    const out: { i: string; s: string; sc: number }[] = [];
    for (const { o, sc } of scored.slice(0, 6)) {
      const ss = specOptions(o);
      if (!ss.length) out.push({ i: o, s: '', sc });
      else {
        const best = ss.map((s) => ({ s, v: spec ? (normSpec(spec) === normSpec(s) ? 1 : similarity(normSpec(spec), normSpec(s))) : 0 })).sort((a, b) => b.v - a.v)[0];
        out.push({ i: o, s: best.s, sc: sc * 0.7 + best.v * 0.3 });
      }
    }
    return out.sort((a, b) => b.sc - a.sc).slice(0, 3).map(({ i, s }) => ({ i, s }));
  };
  return { itemOptions, specOptions, unitOf, isStd, recognize, suggest, aliasMap, ready: catalog.ready };
}
