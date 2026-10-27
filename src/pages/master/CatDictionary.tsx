import { useMemo, useState } from 'react';
import { audit, commitBatch, newId, useCollection } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../../lib/hooks';
import { NO_CAT, resolveCat, stdOfText, suggestStd } from '../../lib/catMatch';
import { rebuildLedger } from '../../lib/matching';
import { nameKey, won } from '../../lib/normalize';
import { Empty, errMsg, useSelection, useToast } from '../../components/ui';
import type { Invoice, StandardCategory } from '../../types';

interface Row {
  text: string;
  lines: number;
  amount: number;
  unmapped: number;
  unmappedAmount: number;
  sites: Set<string>;
}

/** 분류 원문 사전: 계산서 '분류' 칸 표기 여러 개를 같은 표준분류로 묶는다 */
export default function CatDictionary() {
  const std = useStandardCategories();
  const cats = useSiteCategories();
  const sites = useSites();
  const invoices = useCollection<Invoice>(C.invoices, []);
  const toast = useToast();
  const { sel, toggle, setAll, clear } = useSelection();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'unmapped' | 'unlinked'>('unmapped');
  const [target, setTarget] = useState('');
  const [newStd, setNewStd] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    const add = (text: string) => {
      const key = nameKey(text);
      let r = m.get(key);
      if (!r) {
        r = { text, lines: 0, amount: 0, unmapped: 0, unmappedAmount: 0, sites: new Set() };
        m.set(key, r);
      }
      return r;
    };
    for (const inv of invoices.data)
      for (const l of inv.lines) {
        const t = (l.categoryText ?? '').trim();
        if (!t || t === NO_CAT) continue;
        const r = add(t);
        r.lines++;
        r.amount += l.finalAmount;
        r.sites.add(inv.siteId);
        if (!l.siteCategoryId) {
          r.unmapped++;
          r.unmappedAmount += l.finalAmount;
        }
      }
    for (const s of std.data) for (const a of s.aliases ?? []) add(a);
    return [...m.values()].sort((a, b) => b.unmapped - a.unmapped || a.text.localeCompare(b.text, 'ko'));
  }, [invoices.data, std.data]);

  const shown = rows.filter((r) => {
    if (q && !nameKey(r.text).includes(nameKey(q))) return false;
    if (filter === 'unmapped') return r.unmapped > 0;
    if (filter === 'unlinked') return !stdOfText(r.text, std.data);
    return true;
  });
  const totalUnmapped = rows.reduce((a, r) => a + r.unmapped, 0);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast(await fn());
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** texts를 to 표준분류로 묶는다 (다른 표준분류에 있던 같은 원문은 뺀다). to 가 없으면 묶음만 푼다 */
  const bind = (texts: string[], to?: StandardCategory) => {
    const keys = new Set(texts.map(nameKey));
    const ops: Parameters<typeof commitBatch>[0] = [];
    for (const s of std.data) {
      if (s.id === to?.id) continue;
      const left = (s.aliases ?? []).filter((a) => !keys.has(nameKey(a)));
      if (left.length !== (s.aliases ?? []).length) ops.push({ type: 'set', col: C.standardCategories, id: s.id, data: { aliases: left } });
    }
    if (to) {
      const have = new Set((to.aliases ?? []).map(nameKey));
      const next = [...(to.aliases ?? []), ...texts.filter((t) => !have.has(nameKey(t)) && nameKey(t) !== nameKey(to.name))];
      ops.push({ type: 'set', col: C.standardCategories, id: to.id, data: { aliases: next } });
    }
    return ops;
  };

  const doBind = (texts: string[], stdId: string) =>
    run(async () => {
      let to = std.data.find((s) => s.id === stdId);
      const ops: Parameters<typeof commitBatch>[0] = [];
      if (stdId === '__new__') {
        const name = newStd.trim();
        if (!name) throw new Error('새 표준분류 이름을 입력하세요.');
        to = { id: newId(C.standardCategories), name, trade: /소방/.test(texts.join()) ? '소방' : '기계', order: std.data.length, aliases: [] };
        const { id, ...data } = to;
        ops.push({ type: 'set', col: C.standardCategories, id, data });
      }
      ops.push(...bind(texts, to));
      await commitBatch(ops);
      await audit('분류 원문 묶기', to?.name ?? '묶음 해제', { texts });
      clear();
      setNewStd('');
      return to ? `${texts.length}개 원문을 "${to.name}"(으)로 묶었습니다. '미분류 줄 다시 맞추기'를 누르면 저장된 계산서에도 적용됩니다.` : `${texts.length}개 원문의 묶음을 풀었습니다.`;
    });

  /** 저장된 계산서의 미분류 줄을 지금 사전으로 다시 맞춘다 */
  const remap = () =>
    run(async () => {
      let fixed = 0;
      let invCount = 0;
      const noSiteCat = new Set<string>();
      for (const inv of invoices.data) {
        const siteCats = cats.data.filter((c) => c.siteId === inv.siteId);
        let changed = false;
        const lines = inv.lines.map((l) => {
          if (l.siteCategoryId || !l.categoryText || l.categoryText === NO_CAT) return l;
          const cid = resolveCat(l.categoryText, siteCats, std.data);
          if (!cid) {
            if (stdOfText(l.categoryText, std.data)) noSiteCat.add(`${sites.data.find((s) => s.id === inv.siteId)?.name ?? ''}: ${l.categoryText}`);
            return l;
          }
          changed = true;
          fixed++;
          return { ...l, siteCategoryId: cid };
        });
        if (!changed) continue;
        invCount++;
        const next = { ...inv, lines };
        const { id, ...data } = next;
        await rebuildLedger(next, [{ type: 'set', col: C.invoices, id, data, merge: false }]);
      }
      await audit('미분류 줄 다시 맞추기', `${invCount}건`, { lines: fixed });
      const extra = noSiteCat.size ? ` (표준분류는 있지만 그 현장에 연결된 현장분류가 없는 원문 ${noSiteCat.size}개: ${[...noSiteCat].slice(0, 3).join(', ')}${noSiteCat.size > 3 ? ' …' : ''})` : '';
      return fixed ? `계산서 ${invCount}건, ${fixed}줄을 분류했습니다. 투입원장도 다시 계산했습니다.${extra}` : `새로 분류된 줄이 없습니다.${extra}`;
    });

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-semibold">분류 원문 사전</span>
        <span className="text-muted">계산서 '분류' 칸 표기 {rows.length}개 · 미분류 줄 {totalUnmapped}개</span>
        <input className="input ml-auto h-7 w-44" placeholder="원문 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input h-7" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="unmapped">미분류 줄 있는 원문</option>
          <option value="unlinked">표준분류에 안 묶인 원문</option>
          <option value="all">전체</option>
        </select>
        <button className="btn-primary h-7 text-[12px]" disabled={busy || invoices.loading} onClick={remap}>
          미분류 줄 다시 맞추기
        </button>
      </div>
      <div className="border-b border-line bg-[#fafbfc] px-4 py-2 text-[12px] text-muted">
        표기가 달라도 같은 분류인 원문을 체크하고 표준분류를 골라 묶으세요. 묶인 원문은 모든 현장에서 그 표준분류에 연결된 현장분류로 자동 지정됩니다.
      </div>
      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-soft px-4 py-2">
          <span>체크한 원문 {sel.size}개는 같은 분류 →</span>
          <select className="input h-7 w-56" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">표준분류 선택</option>
            <option value="__new__">+ 새 표준분류 만들기</option>
            {std.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {target === '__new__' && <input className="input h-7 w-40" placeholder="새 표준분류 이름" value={newStd} onChange={(e) => setNewStd(e.target.value)} />}
          <button className="btn-dark h-7 text-[12px]" disabled={busy || !target} onClick={() => doBind(shown.filter((r) => sel.has(r.text)).map((r) => r.text), target)}>
            묶기
          </button>
          <button className="btn-ghost h-7 text-[12px]" disabled={busy} onClick={() => doBind(shown.filter((r) => sel.has(r.text)).map((r) => r.text), '')}>
            묶음 풀기
          </button>
          <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={clear}>
            선택 해제
          </button>
        </div>
      )}
      {!shown.length ? (
        <Empty>{invoices.loading ? '불러오는 중…' : filter === 'unmapped' ? '미분류 줄이 있는 원문이 없습니다.' : '원문이 없습니다.'}</Empty>
      ) : (
        <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" checked={shown.length > 0 && shown.every((r) => sel.has(r.text))} onChange={(e) => setAll(shown.map((r) => r.text), e.target.checked)} />
                </th>
                <th>분류 원문</th>
                <th className="num">현장</th>
                <th className="num">줄</th>
                <th className="num">미분류 줄</th>
                <th className="num">미분류 금액</th>
                <th>묶인 표준분류</th>
                <th>비슷한 표준분류</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const st = stdOfText(r.text, std.data);
                const explicit = st && (st.aliases ?? []).some((a) => nameKey(a) === nameKey(r.text));
                const sug = st ? [] : suggestStd(r.text, std.data);
                return (
                  <tr key={r.text}>
                    <td>
                      <input type="checkbox" checked={sel.has(r.text)} onChange={() => toggle(r.text)} />
                    </td>
                    <td className="font-medium">{r.text}</td>
                    <td className="num text-muted">{r.sites.size}</td>
                    <td className="num">{r.lines}</td>
                    <td className={`num ${r.unmapped ? 'font-semibold text-red-600' : 'text-muted'}`}>{r.unmapped || ''}</td>
                    <td className="num">{r.unmappedAmount ? won(r.unmappedAmount) : ''}</td>
                    <td>
                      {st ? (
                        <span className={`chip ${explicit ? 'bg-emerald-50 text-emerald-700' : 'bg-line text-muted'}`} title={explicit ? '사전에 묶음' : '표준분류 이름과 같아 자동 연결'}>
                          {st.name}
                          {!explicit && ' (이름 같음)'}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-amber-700">없음</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {sug.map((x) => (
                          <button
                            key={x.std.id}
                            className="chip border border-amber-brand/60 bg-white text-[11px] hover:bg-amber-soft"
                            title={`비슷한 정도 ${Math.round(x.score * 100)}% · 누르면 이 표준분류로 묶음`}
                            disabled={busy}
                            onClick={() => doBind([r.text], x.std.id)}
                          >
                            {x.std.name}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
