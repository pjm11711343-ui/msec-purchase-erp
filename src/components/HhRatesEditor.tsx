// 현장별 세대당 수량 설정 (자재부·관리자)
//  - 세대 타입 목록 (예: 59A, 84B)
//  - 품목마다: 단위(M·롤), 타입별 세대당 수량 또는 현장 하나의 값
import { useState } from 'react';
import { audit, commitBatch, newId } from '../lib/db';
import { C } from '../lib/firebase';
import { withPresets } from '../lib/hh';
import { normItem, normSpec } from '../lib/itemNorm';
import type { HhRates, HhRule } from '../types';
import { errMsg, Modal, NumInput, useToast } from './ui';

const rid = () => Math.random().toString(36).slice(2, 9);

export default function HhRatesEditor({
  siteId,
  siteName,
  rates,
  canEdit,
  itemOptions,
  hasItem,
  who,
  onClose,
}: {
  siteId: string;
  siteName: string;
  rates?: HhRates;
  canEdit: boolean;
  itemOptions: string[];
  /** 품명·규격이 청구서 품목 목록에 있는지 */
  hasItem: (item: string, spec: string) => boolean;
  who: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [types, setTypes] = useState<string[]>(rates?.types ?? []);
  const [typeIn, setTypeIn] = useState('');
  const [rules, setRules] = useState<HhRule[]>(() => withPresets(rates?.rules ?? [], rid));
  const [busy, setBusy] = useState(false);
  const upd = (id: string, patch: Partial<HhRule>) => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addType = () => {
    const t = typeIn.trim();
    if (!t) return;
    const add = t.split(/[,\s]+/).filter((x) => x && !types.includes(x));
    setTypes([...types, ...add]);
    setTypeIn('');
  };
  const save = async () => {
    const bad = rules.find((r) => !r.itemName.trim());
    if (bad) return toast('품명이 빈 줄이 있습니다.', 'err');
    setBusy(true);
    try {
      const clean = rules.map((r) => ({
        id: r.id,
        itemName: r.itemName.trim(),
        ...(r.spec?.trim() ? { spec: r.spec.trim() } : {}),
        unit: r.unit.trim() || 'M',
        byType: r.byType,
        ...(r.byType ? { perType: Object.fromEntries(Object.entries(r.perType ?? {}).filter(([t, v]) => types.includes(t) && v > 0)) } : { qty: r.qty || 0 }),
      }));
      // 품목 목록에 없는 품명·규격(예: 난방코일 16A 롤)은 품목으로 같이 등록해서 청구서에서 고를 수 있게
      const seen = new Set<string>();
      const newItems = clean.filter((r) => r.spec && !hasItem(r.itemName, r.spec) && !seen.has(`${normItem(r.itemName)}|${normSpec(r.spec)}`) && seen.add(`${normItem(r.itemName)}|${normSpec(r.spec)}`));
      await commitBatch([
        { type: 'set', col: C.hhRates, id: siteId, data: { siteId, types, rules: clean, updatedAt: Date.now(), updatedBy: who }, merge: false },
        ...newItems.map((r) => ({
          type: 'set' as const,
          col: C.items,
          id: newId(C.items),
          data: { itemName: r.itemName, spec: r.spec!, unit: r.unit, status: 'active', note: '세대당 수량 설정에서 등록', requestedByName: who, requestSiteName: siteName, createdAt: Date.now() },
        })),
      ]);
      if (newItems.length) toast(`품목 목록에 없던 ${newItems.map((r) => `${r.itemName} ${r.spec}`).join(', ')}을(를) 품목으로 등록했습니다.`);
      await audit('세대당 수량 설정', siteName, { rules: clean.length });
      toast('저장했습니다. 청구서에서 세대수만 넣으면 수량이 계산됩니다.');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={`세대당 수량 · ${siteName}`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-[12px] text-muted">청구서에서 이 품명을 고르면 금회청구 칸이 '세대수' 입력으로 바뀝니다. 금회청구 = 세대수 × 세대당 수량.</span>
          <button className="btn-ghost" onClick={onClose}>
            닫기
          </button>
          {canEdit && (
            <button className="btn-primary" disabled={busy} onClick={save}>
              저장
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <div>
          <div className="mb-1 font-semibold">세대 타입</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {types.map((t) => (
              <span key={t} className="chip bg-navy-950/5 text-navy-900">
                {t}
                {canEdit && (
                  <button className="ml-1 text-muted hover:text-red-600" onClick={() => setTypes(types.filter((x) => x !== t))}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <>
                <input className="input h-7 w-40" placeholder="예: 59A, 84B" value={typeIn} onChange={(e) => setTypeIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addType()} />
                <button className="btn-ghost h-7 text-[12px]" onClick={addType}>
                  + 타입 추가
                </button>
              </>
            )}
            {!types.length && <span className="text-[12px] text-muted">타입별 수량을 쓰려면 타입을 먼저 추가하세요.</span>}
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold">품목별 세대당 수량</span>
            {canEdit && (
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setRules([...rules, { id: rid(), itemName: '', unit: 'M', byType: false, qty: 0 }])}>
                + 품목 추가
              </button>
            )}
          </div>
          <datalist id="hh-items">
            {itemOptions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="tbl text-[12.5px]">
              <thead>
                <tr>
                  <th>품명</th>
                  <th>규격 (비우면 전체)</th>
                  <th>단위</th>
                  <th>방식</th>
                  <th>세대당 수량</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td>
                      <input className="input h-7 w-52" list="hh-items" disabled={!canEdit} value={r.itemName} onChange={(e) => upd(r.id, { itemName: e.target.value })} />
                    </td>
                    <td>
                      <input className="input h-7 w-28" disabled={!canEdit} value={r.spec ?? ''} onChange={(e) => upd(r.id, { spec: e.target.value })} />
                    </td>
                    <td>
                      <input className="input h-7 w-14 text-center" disabled={!canEdit} value={r.unit} onChange={(e) => upd(r.id, { unit: e.target.value })} />
                    </td>
                    <td>
                      <select className="input h-7" disabled={!canEdit} value={r.byType ? 'type' : 'one'} onChange={(e) => upd(r.id, { byType: e.target.value === 'type' })}>
                        <option value="type">타입별</option>
                        <option value="one">현장 하나</option>
                      </select>
                    </td>
                    <td>
                      {r.byType ? (
                        types.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {types.map((t) => (
                              <label key={t} className="flex items-center gap-1">
                                <span className="text-[11.5px] text-muted">{t}</span>
                                <NumInput className="input h-7 w-16 text-right" value={r.perType?.[t] ?? 0} onChange={(n) => upd(r.id, { perType: { ...(r.perType ?? {}), [t]: n } })} />
                              </label>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-amber-700">위에서 세대 타입을 추가하세요</span>
                        )
                      ) : (
                        <span className="flex items-center gap-1">
                          <NumInput className="input h-7 w-20 text-right" value={r.qty ?? 0} onChange={(n) => upd(r.id, { qty: n })} />
                          <span className="text-muted">{r.unit}/세대</span>
                        </span>
                      )}
                    </td>
                    <td>
                      {canEdit && (
                        <button className="text-[12px] text-muted hover:text-red-600" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
                          삭제
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 text-[11.5px] text-muted">
            예: 동관/멀티튜브(거실) 타입별 59A 38M · 84B 45M / PB난방 롤관-주문제작 현장 하나 2롤. 단위를 '롤'로 하면 청구·발주가 롤 개수로 나갑니다.
          </div>
        </div>
      </div>
    </Modal>
  );
}
