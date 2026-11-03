// 세대 단위 청구: 세대수 × 세대당 수량 = 금회청구
//  - 에어컨 매립배관 동관/멀티튜브(거실·침실): 타입별 세대당 M
//  - PB난방 롤관-주문제작: 현장 하나의 세대당 롤 수
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, C } from './firebase';
import { normItem, normSpec } from './itemNorm';
import type { HhRates, HhRule, ReqLine } from '../types';

/** 설정 화면에 처음 보여 줄 품목 */
export const HH_PRESETS: Omit<HhRule, 'id'>[] = [
  { itemName: '동관/멀티튜브(거실)', unit: 'M', byType: true, perType: {} },
  { itemName: '동관/멀티튜브(침실)', unit: 'M', byType: true, perType: {} },
  { itemName: 'PB난방 롤관-주문제작', spec: '16mm', unit: '롤', byType: false, qty: 0 },
  { itemName: '난방롤관', spec: 'ISO 16mm 주문품', unit: '롤', byType: false, qty: 0 },
  { itemName: '난방롤관ISO', spec: '16mm주문품', unit: '롤', byType: false, qty: 0 },
];
/** 예전에 잘못 넣었던 기본 품목 (수량을 안 넣은 채로 남아 있으면 정리) */
const RETIRED = [
  { itemName: 'PB난방 롤관-주문제작', spec: '16A' },
  { itemName: '난방롤관 IOS', spec: '16A' },
  { itemName: '난방코일', spec: '16A' },
];
/** 저장된 설정에 없는 기본 품목을 뒤에 붙인다 (품명·규격 기준) */
export function withPresets(rules: HhRule[], rid: () => string): HhRule[] {
  const retired = (r: HhRule) => !r.qty && !Object.values(r.perType ?? {}).some((v) => v > 0) && RETIRED.some((x) => normItem(x.itemName) === normItem(r.itemName) && normSpec(x.spec) === normSpec(r.spec ?? ''));
  const kept = rules.filter((r) => !retired(r));
  const hasK = (p: Omit<HhRule, 'id'>) => kept.some((r) => normItem(r.itemName) === normItem(p.itemName) && normSpec(r.spec ?? '') === normSpec(p.spec ?? ''));
  return [...kept, ...HH_PRESETS.filter((p) => !hasK(p)).map((p) => ({ ...p, id: rid() }))];
}

export function useHhRates(siteId?: string) {
  const [s, setS] = useState<{ data?: HhRates; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!siteId) return setS({ loading: false });
    setS({ loading: true });
    return onSnapshot(
      doc(db, C.hhRates, siteId),
      (d) => setS({ data: d.exists() ? ({ ...(d.data() as Omit<HhRates, 'id'>), id: d.id } as HhRates) : undefined, loading: false }),
      () => setS({ loading: false }),
    );
  }, [siteId]);
  return s;
}

/** 이 품명·규격에 맞는 세대 규칙 (규격이 정해진 규칙이 먼저) */
export function hhRuleFor(rates: HhRates | undefined, itemName: string, spec: string): HhRule | undefined {
  if (!rates || !itemName) return undefined;
  const i = normItem(itemName);
  const sp = normSpec(spec ?? '');
  const hit = rates.rules.filter((r) => normItem(r.itemName) === i && (!r.spec || normSpec(r.spec) === sp));
  return hit.find((r) => r.spec) ?? hit[0];
}
/** 세대당 수량 */
export const hhPerOf = (rule: HhRule, type?: string) => (rule.byType ? (type ? rule.perType?.[type] ?? 0 : 0) : rule.qty ?? 0);
/** 세대 청구 줄인지 */
export const isHhLine = (l: Pick<ReqLine, 'hhCount'>) => l.hhCount != null && l.hhCount > 0;
export const hhText = (l: ReqLine) => (isHhLine(l) ? `${l.hhCount}세대${l.hhType ? `(${l.hhType})` : ''} × ${l.hhPer ?? 0}${l.hhUnit ?? ''}` : '');
