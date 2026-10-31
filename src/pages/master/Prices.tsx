import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { loadPrices, priceCacheAt, type PriceRow } from '../../lib/prices';
import { nameKey, won } from '../../lib/normalize';
import { useSiteCategories, useSites, useStandardCategories } from '../../lib/hooks';
import { useItemCatalog, type LastPrice } from '../../lib/itemCatalog';
import { itemKey, makeItemStd, useItemCats, useItemEntries } from '../../lib/itemMaster';
import { stdOfText } from '../../lib/catMatch';
import { Empty, errMsg, PageHeader, useToast } from '../../components/ui';

type View = 'all' | 'vendor' | 'cat' | 'site';
const NO_CAT = '(미분류)';

/** 단가 조회: ERP에 둔 단가관리시스템 단가표 사본 — 전체 / 업체별 / 분류별 / 현장별 */
export default function Prices() {
  const toast = useToast();
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState(''); // 업체별·분류별에서 고른 묶음
  const [siteId, setSiteId] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);

  const std = useStandardCategories();
  const siteCats = useSiteCategories();
  const itemCats = useItemCats();
  const entries = useItemEntries();
  const catalog = useItemCatalog();
  const sites = useSites();

  useEffect(() => {
    loadPrices({ canRebuild: true })
      .then((r) => (setRows(r), setAt(priceCacheAt())))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const refresh = async () => {
    if (!confirm('단가관리시스템 원본에서 단가표를 다시 불러올까요? (단가 수만큼 Firebase 읽기를 씁니다)')) return;
    setBusy(true);
    try {
      const r = await loadPrices({ force: true, canRebuild: true });
      setRows(r);
      setAt(priceCacheAt());
      toast(`단가 ${r.length.toLocaleString()}건을 새로 불러왔습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  // 분류: 품목·단가에서 정한 표준 자재분류 → 단가관리시스템 분류 → 미분류
  const stdOf = useMemo(
    () => makeItemStd({ itemCats: itemCats.data, entries: entries.data, catalog: catalog.items, siteCats: siteCats.data, std: std.data }),
    [itemCats.data, entries.data, catalog.items, siteCats.data, std.data],
  );
  const catOf = useMemo(() => {
    const names = new Map(std.data.map((s) => [s.id, s.name]));
    const memo = new Map<string, string>();
    return (r: PriceRow) => {
      const k = `${itemKey(r.itemName, r.spec)}|${r.category ?? ''}`;
      if (!memo.has(k)) {
        const sid = stdOf(r.itemName, r.spec).stdCatId;
        const fromSrc = r.category ? (stdOfText(r.category, std.data)?.name ?? r.category) : '';
        memo.set(k, (sid && names.get(sid)) || fromSrc || NO_CAT);
      }
      return memo.get(k)!;
    };
  }, [stdOf, std.data]);

  // 현장별: 그 현장이 계산서로 산 품목 (현장 최근 단가와 비교)
  const siteBuy = useMemo(() => {
    const m = new Map<string, LastPrice>();
    if (!siteId) return m;
    for (const c of catalog.items) {
      const lp = c.site[siteId];
      if (lp) m.set(itemKey(c.i, c.s), lp);
    }
    return m;
  }, [catalog.items, siteId]);

  const k = nameKey(q);
  const searched = useMemo(() => (k ? rows.filter((r) => nameKey([r.vendorName, r.itemName, r.spec, r.maker].join(' ')).includes(k)) : rows), [rows, k]);

  // 묶음 목록 (업체별·분류별)
  const groups = useMemo(() => {
    if (view !== 'vendor' && view !== 'cat') return [];
    const m = new Map<string, { name: string; n: number; nego: number; negoN: number }>();
    for (const r of searched) {
      const name = view === 'vendor' ? r.vendorName : catOf(r);
      const g = m.get(name) ?? { name, n: 0, nego: 0, negoN: 0 };
      g.n++;
      if (r.negoRate) (g.nego += r.negoRate), g.negoN++;
      m.set(name, g);
    }
    return [...m.values()].sort((a, b) => (a.name === NO_CAT ? 1 : b.name === NO_CAT ? -1 : a.name.localeCompare(b.name, 'ko')));
  }, [searched, view, catOf]);

  const filtered = useMemo(() => {
    let l = searched;
    if (view === 'vendor' && group) l = l.filter((r) => r.vendorName === group);
    if (view === 'cat' && group) l = l.filter((r) => catOf(r) === group);
    if (view === 'site') {
      l = l.filter((r) => siteBuy.has(itemKey(r.itemName, r.spec)));
      if (onlyDiff) l = l.filter((r) => siteBuy.get(itemKey(r.itemName, r.spec))!.p !== r.buyPrice);
    }
    return [...l].sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko') || a.spec.localeCompare(b.spec, 'ko') || a.buyPrice - b.buyPrice);
  }, [searched, view, group, catOf, siteBuy, onlyDiff]);
  const shown = filtered.slice(0, 1000);
  // 같은 품목 중 최저 구매단가
  const minOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filtered) {
      const kk = itemKey(r.itemName, r.spec);
      m.set(kk, Math.min(m.get(kk) ?? Infinity, r.buyPrice));
    }
    return m;
  }, [filtered]);

  const exportExcel = () => {
    const siteName = sites.data.find((s) => s.id === siteId)?.name ?? '';
    const aoa = [
      ['업체', '분류', '품명', '규격', '단위', '협가', '네고율(%)', '구매단가', '메이커', ...(view === 'site' ? [`${siteName} 최근 단가`, '최근 업체', '최근 월', '차이'] : [])],
      ...filtered.map((r) => {
        const lp = siteBuy.get(itemKey(r.itemName, r.spec));
        return [r.vendorName, catOf(r), r.itemName, r.spec, r.unit, r.listPrice || '', r.negoRate || '', r.buyPrice, r.maker ?? '', ...(view === 'site' && lp ? [lp.p, lp.v, lp.m, lp.p - r.buyPrice] : [])];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [16, 14, 24, 14, 6, 10, 8, 10, 12, 12, 14, 8, 10].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '단가관리 단가');
    XLSX.writeFile(wb, `단가관리단가_${view === 'vendor' ? group || '업체별' : view === 'cat' ? group || '분류별' : view === 'site' ? siteName : '전체'}.xlsx`);
  };

  const tabs: [View, string][] = [
    ['all', '전체'],
    ['vendor', '업체별'],
    ['cat', '분류별'],
    ['site', '현장별'],
  ];

  return (
    <div>
      <PageHeader
        title="단가관리 단가 조회"
        desc={`단가관리시스템 단가표의 ERP 사본입니다${at ? ` (${new Date(at).toLocaleString('ko-KR')} 기준, 하루 한 번 자동 갱신)` : ''}. 단가 수정은 단가관리시스템에서 하세요. 분류는 품목·단가에서 정한 자재분류를 씁니다.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <input className="input w-56" placeholder="업체·품명·규격·메이커 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-ghost" onClick={exportExcel} disabled={!filtered.length}>
              엑셀 내려받기
            </button>
            <button className="btn-ghost" disabled={busy} onClick={refresh}>
              {busy ? '불러오는 중…' : '원본에서 새로 불러오기'}
            </button>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-1 rounded-xl border border-line bg-white p-1">
        {tabs.map(([v, label]) => (
          <button key={v} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${view === v ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas hover:text-ink'}`} onClick={() => (setView(v), setGroup(''))}>
            {label}
          </button>
        ))}
        {view === 'site' && (
          <div className="ml-auto flex flex-wrap items-center gap-2 pr-1">
            <select className="input h-8" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">현장 선택</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[12px] text-muted">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> 단가 다른 것만
            </label>
          </div>
        )}
      </div>

      <div className={view === 'vendor' || view === 'cat' ? 'grid gap-3 lg:grid-cols-[260px_1fr]' : ''}>
        {(view === 'vendor' || view === 'cat') && (
          <div className="card self-start overflow-hidden">
            <div className="border-b border-line px-3 py-2 text-[12px] font-semibold text-muted">
              {view === 'vendor' ? `업체 ${groups.length}` : `분류 ${groups.length}`}
            </div>
            <div className="flex max-h-[calc(100vh-260px)] gap-1 overflow-auto p-1 lg:flex-col">
              <button className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${!group ? 'bg-amber-brand font-semibold text-navy-950' : 'hover:bg-canvas'}`} onClick={() => setGroup('')}>
                전체 <span className="text-[11px]">{searched.length.toLocaleString()}</span>
              </button>
              {groups.map((g) => (
                <button key={g.name} className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${group === g.name ? 'bg-amber-brand font-semibold text-navy-950' : 'hover:bg-canvas'} ${g.name === NO_CAT ? 'text-muted' : ''}`} onClick={() => setGroup(g.name)}>
                  <span className="truncate">{g.name}</span>
                  <span className="shrink-0 text-[11px] text-muted">
                    {g.n.toLocaleString()}
                    {view === 'vendor' && g.negoN ? ` · 네고 ${Math.round((g.nego / g.negoN) * 10) / 10}%` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          {error ? (
            <Empty>단가를 읽지 못했습니다: {error}</Empty>
          ) : view === 'site' && !siteId ? (
            <Empty>현장을 고르면 그 현장이 계산서로 산 품목의 단가관리 단가와 현장 최근 단가를 나란히 보여줍니다.</Empty>
          ) : !shown.length ? (
            <Empty>{loading ? '불러오는 중…' : view === 'site' ? '이 현장 계산서 품목과 맞는 단가관리 단가가 없습니다.' : '단가 데이터가 없습니다.'}</Empty>
          ) : (
            <div className="max-h-[calc(100vh-240px)] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>업체</th>
                    <th>분류</th>
                    <th>품명</th>
                    <th>규격</th>
                    <th>단위</th>
                    <th className="num">협가</th>
                    <th className="num">네고율</th>
                    <th className="num">구매단가</th>
                    <th>메이커</th>
                    {view === 'site' && (
                      <>
                        <th className="num">현장 최근 단가</th>
                        <th>최근 업체 · 월</th>
                        <th className="num">차이</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => {
                    const kk = itemKey(r.itemName, r.spec);
                    const lp = siteBuy.get(kk);
                    const diff = lp ? lp.p - r.buyPrice : 0;
                    const cheapest = minOf.get(kk) === r.buyPrice;
                    return (
                      <tr key={i}>
                        <td>{r.vendorName}</td>
                        <td className={`text-[12px] ${catOf(r) === NO_CAT ? 'text-muted' : ''}`}>{catOf(r)}</td>
                        <td>{r.itemName}</td>
                        <td>{r.spec}</td>
                        <td>{r.unit}</td>
                        <td className="num">{r.listPrice ? won(r.listPrice) : ''}</td>
                        <td className="num">{r.negoRate ? `${r.negoRate}%` : ''}</td>
                        <td className={`num font-semibold ${cheapest && view !== 'all' ? 'text-emerald-700' : ''}`}>{won(r.buyPrice)}</td>
                        <td className="text-muted">{r.maker}</td>
                        {view === 'site' && (
                          <>
                            <td className="num">{lp ? won(lp.p) : ''}</td>
                            <td className="text-[12px] text-muted">{lp ? `${lp.v} · ${lp.m}` : ''}</td>
                            <td className={`num ${diff > 0 ? 'text-red-600' : diff < 0 ? 'text-sky-700' : 'text-muted'}`} title="현장 최근 단가 − 단가관리 구매단가">
                              {lp ? (diff ? `${diff > 0 ? '+' : ''}${won(diff)}` : '같음') : ''}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[12px] text-muted">
                {filtered.length.toLocaleString()}건{filtered.length > shown.length ? ` 중 ${shown.length.toLocaleString()}건 표시 — 검색으로 좁히세요` : ''}
                {view !== 'all' && ' · 같은 품목 중 가장 싼 구매단가는 초록색'}
                {view === 'site' && ' · 차이: 현장이 더 비싸게 산 경우 빨강(+), 싸게 산 경우 파랑(−)'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
