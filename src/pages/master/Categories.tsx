import { useMemo, useState } from 'react';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../../lib/hooks';
import { categoryKey, won } from '../../lib/normalize';
import { Empty, errMsg, PageHeader, useSelection, useToast } from '../../components/ui';
import type { SiteCategory, StandardCategory, Trade } from '../../types';

/** 분류 원래 이름에서 공종 꼬리표를 뗀 표시용 이름 */
function displayName(name: string): string {
  return name.replace(/\s*\((기계설비?|기계설|기계|소방설비?|소방설|소방)\)?\s*$/, '').trim();
}

export default function Categories() {
  const std = useStandardCategories();
  const cats = useSiteCategories();
  const sites = useSites();
  const toast = useToast();
  const { sel, toggle, setAll, clear } = useSelection();
  const [siteFilter, setSiteFilter] = useState('');
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [bulkStd, setBulkStd] = useState('');
  const [newName, setNewName] = useState('');
  const [newTrade, setNewTrade] = useState<Trade>('기계');
  const [busy, setBusy] = useState(false);

  const siteOf = (id: string) => sites.data.find((s) => s.id === id);
  const shown = useMemo(
    () =>
      cats.data
        .filter((c) => (!siteFilter || c.siteId === siteFilter) && (!onlyUnassigned || !c.standardCategoryId))
        .sort((a, b) => (siteOf(a.siteId)?.code ?? '').localeCompare(siteOf(b.siteId)?.code ?? '') || a.order - b.order),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cats.data, siteFilter, onlyUnassigned, sites.data],
  );
  const useCount = (stdId: string) => cats.data.filter((c) => c.standardCategoryId === stdId).length;
  const unassigned = cats.data.filter((c) => !c.standardCategoryId).length;

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** 현장 분류 이름을 모아 표준분류 초안을 만들고, 같은 이름은 바로 연결 */
  const buildDraft = () =>
    run(async () => {
      const groups = new Map<string, { names: Map<string, number>; trades: Map<string, number>; cats: SiteCategory[]; order: number }>();
      for (const c of cats.data) {
        const k = categoryKey(c.name);
        if (!k) continue;
        const g = groups.get(k) ?? { names: new Map<string, number>(), trades: new Map<string, number>(), cats: [] as SiteCategory[], order: c.order };
        const dn = displayName(c.name);
        g.names.set(dn, (g.names.get(dn) ?? 0) + 1);
        const t = siteOf(c.siteId)?.trade ?? '기계';
        g.trades.set(t, (g.trades.get(t) ?? 0) + 1);
        g.cats.push(c);
        g.order = Math.min(g.order, c.order);
        groups.set(k, g);
      }
      const ops: Parameters<typeof commitBatch>[0] = [];
      let created = 0;
      let linked = 0;
      let order = std.data.length;
      const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0][0];
      for (const [k, g] of [...groups].sort((a, b) => a[1].order - b[1].order)) {
        let target = std.data.find((s) => categoryKey(s.name) === k);
        if (!target) {
          target = { id: newId(C.standardCategories), name: top(g.names), trade: top(g.trades) as Trade, order: order++ };
          const { id, ...data } = target;
          ops.push({ type: 'set', col: C.standardCategories, id, data });
          created++;
        }
        for (const c of g.cats)
          if (!c.standardCategoryId) {
            ops.push({ type: 'set', col: C.siteCategories, id: c.id, data: { standardCategoryId: target.id } });
            linked++;
          }
      }
      await commitBatch(ops);
      await audit('표준분류 초안', `${created}개 생성, ${linked}개 연결`);
    }, '표준분류 초안을 만들고 같은 이름 분류를 연결했습니다. 목록을 보고 합치거나 이름을 고치세요.');

  const assign = (ids: string[], stdId: string) =>
    run(async () => {
      await commitBatch(ids.map((id) => ({ type: 'set' as const, col: C.siteCategories, id, data: { standardCategoryId: stdId || null } })));
    }, `${ids.length}개 분류를 연결했습니다.`);

  const saveStd = (s: StandardCategory, patch: Partial<StandardCategory>) =>
    commitBatch([{ type: 'set', col: C.standardCategories, id: s.id, data: patch }]).catch((e) => toast(errMsg(e), 'err'));

  /** 표준분류 합치기: from을 to로 옮기고 from 삭제 */
  const merge = (from: StandardCategory, toId: string) =>
    run(async () => {
      const moved = cats.data.filter((c) => c.standardCategoryId === from.id);
      await commitBatch([
        ...moved.map((c) => ({ type: 'set' as const, col: C.siteCategories, id: c.id, data: { standardCategoryId: toId } })),
        { type: 'delete', col: C.standardCategories, id: from.id },
      ]);
      await audit('표준분류 합치기', `${from.name} → ${toId}`);
    }, `${from.name}을(를) 합쳤습니다.`);

  return (
    <div>
      <PageHeader
        title="분류"
        desc="현장 투입집계 분류는 원래 이름 그대로 두고, 회사 전체 비교용 표준분류에 연결합니다."
        actions={
          <button className="btn-primary" disabled={busy || !cats.data.length} onClick={buildDraft}>
            표준분류 초안 만들기
          </button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        <div className="card overflow-hidden">
          <div className="border-b border-line px-4 py-2.5 font-semibold">표준분류 {std.data.length}개</div>
          <div className="flex gap-2 border-b border-line px-4 py-2">
            <input className="input flex-1" placeholder="새 표준분류 이름" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <select className="input w-20" value={newTrade} onChange={(e) => setNewTrade(e.target.value as Trade)}>
              <option>기계</option>
              <option>소방</option>
              <option>공통</option>
            </select>
            <button
              className="btn-dark"
              disabled={!newName.trim()}
              onClick={() =>
                run(async () => {
                  await commitBatch([
                    { type: 'set', col: C.standardCategories, id: newId(C.standardCategories), data: { name: newName.trim(), trade: newTrade, order: std.data.length } },
                  ]);
                  setNewName('');
                }, '추가했습니다.')
              }
            >
              추가
            </button>
          </div>
          {std.data.length === 0 ? (
            <Empty>"표준분류 초안 만들기"를 누르면 현장 분류 이름을 모아 초안을 만듭니다.</Empty>
          ) : (
            <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-12">순서</th>
                    <th>이름</th>
                    <th>공종</th>
                    <th className="num">연결</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {std.data.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <input className="input h-7 w-12 px-1 text-center" defaultValue={s.order} onBlur={(e) => saveStd(s, { order: Number(e.target.value) || 0 })} />
                      </td>
                      <td>
                        <input className="input h-7 w-full" defaultValue={s.name} onBlur={(e) => e.target.value.trim() !== s.name && saveStd(s, { name: e.target.value.trim() })} />
                      </td>
                      <td>
                        <select className="input h-7" value={s.trade} onChange={(e) => saveStd(s, { trade: e.target.value as Trade })}>
                          <option>기계</option>
                          <option>소방</option>
                          <option>공통</option>
                        </select>
                      </td>
                      <td className="num">{useCount(s.id)}</td>
                      <td>
                        <select
                          className="input h-7 w-20 text-[11.5px]"
                          value=""
                          onChange={(e) => {
                            const to = e.target.value;
                            if (to === '__del__') {
                              if (useCount(s.id)) return toast('연결된 분류가 있어 삭제할 수 없습니다. 다른 표준분류로 합치세요.', 'err');
                              run(() => commitBatch([{ type: 'delete', col: C.standardCategories, id: s.id }]), '삭제했습니다.');
                            } else if (to && confirm(`${s.name}을(를) ${std.data.find((x) => x.id === to)?.name}에 합칠까요?`)) merge(s, to);
                          }}
                        >
                          <option value="">관리</option>
                          <option value="__del__">삭제</option>
                          <optgroup label="다음으로 합치기">
                            {std.data
                              .filter((x) => x.id !== s.id)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                          </optgroup>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="font-semibold">현장 분류</span>
            <span className="text-muted">미지정 {unassigned}개</span>
            <select className="input ml-auto h-7 w-52" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[12px]">
              <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} /> 미지정만
            </label>
          </div>
          {sel.size > 0 && (
            <div className="flex items-center gap-2 border-b border-line bg-amber-soft px-4 py-2">
              <span>{sel.size}개 선택 →</span>
              <select className="input h-7 w-52" value={bulkStd} onChange={(e) => setBulkStd(e.target.value)}>
                <option value="">연결 해제</option>
                {std.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="btn-dark h-7 text-[12px]" disabled={busy} onClick={() => assign([...sel], bulkStd).then(clear)}>
                일괄 연결
              </button>
            </div>
          )}
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" checked={shown.length > 0 && shown.every((c) => sel.has(c.id))} onChange={(e) => setAll(shown.map((c) => c.id), e.target.checked)} />
                  </th>
                  <th>현장</th>
                  <th>분류(원래 이름)</th>
                  <th>계산서 표기</th>
                  <th className="num">실행</th>
                  <th>표준분류</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
                    </td>
                    <td className="whitespace-nowrap text-muted">{siteOf(c.siteId)?.name}</td>
                    <td className="font-medium">{c.name}</td>
                    <td className="text-[11.5px] text-muted">{(c.aliases ?? []).join(', ')}</td>
                    <td className="num">{won(c.execAmount)}</td>
                    <td>
                      <select
                        className={`input h-7 w-48 ${c.standardCategoryId ? '' : 'border-amber-brand bg-amber-soft'}`}
                        value={c.standardCategoryId ?? ''}
                        onChange={(e) => assign([c.id], e.target.value)}
                      >
                        <option value="">미지정</option>
                        {std.data.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty>{cats.loading ? '불러오는 중…' : '분류가 없습니다.'}</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}
