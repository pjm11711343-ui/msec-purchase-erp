import { Fragment, useEffect, useMemo, useState } from 'react';
import { rebuildCatalog, refreshCatalog, useItemCatalog } from '../lib/itemCatalog';
import { orderBy } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { useCollection } from '../lib/db';
import { C } from '../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../lib/hooks';
import { nameKey } from '../lib/normalize';
import {
  buildRows,
  canonNames,
  cmp,
  computePivot,
  fmtA,
  fmtQ,
  fmtW,
  GLBL,
  GROUPS,
  mL,
  mLong,
  saveItemAlias,
  UNCAT,
  useItemAlias,
  type Basis,
  type Cell,
  type LRow,
  type PItem,
} from '../lib/ledgerData';
import { exportPivotXlsx, exportTablesXlsx } from '../lib/ledgerExcel';
import { Empty, errMsg, Modal, PageHeader, useToast } from '../components/ui';
import GipyoCompare from './ledger/GipyoCompare';
import LedgerImport from './ledger/LedgerImport';
import type { Invoice } from '../types';

type Tab = 'dash' | 'pivot' | 'summary' | 'ledger' | 'gipyo' | 'import';
type VMode = 'both' | 'qty' | 'amt' | 'price';
const TABS: [Tab, string][] = [
  ['dash', '대시보드'],
  ['pivot', '월별 품목 리스트'],
  ['summary', '현장·분류·업체 요약'],
  ['ledger', '전체 명세'],
  ['gipyo', '집계표 대조'],
  ['import', '예전 자료 가져오기'],
];

/** 브라우저에 기억하는 화면 설정 */
const LS = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('erp-items:' + k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('erp-items:' + k, JSON.stringify(v));
    } catch {
      /* 저장 못 해도 동작에는 문제없음 */
    }
  },
};

const PAGE = 400;

/** 계산서 월별 품목 관리 (예전 오프라인 프로그램을 ERP 계산서 자료로) */
export default function ItemLedger() {
  const { can } = useAuth();
  const isOffice = can('admin', 'material');
  const toast = useToast();
  const invoices = useCollection<Invoice>(C.invoices, [orderBy('uploadedAt', 'desc')]);
  const sites = useSites();
  const cats = useSiteCategories();
  const std = useStandardCategories();
  const alias = useItemAlias();
  const catalog = useItemCatalog();
  const [catBusy, setCatBusy] = useState(false);
  // 계산서가 목록보다 새로우면 구매청구용 품명 목록을 뒤에서 다시 만든다
  const newestInv = useMemo(() => Math.max(0, ...invoices.data.map((i) => Math.max(i.uploadedAt ?? 0, i.appliedAt ?? 0))), [invoices.data]);
  useEffect(() => {
    if (isOffice && catalog.ready && !invoices.loading && newestInv > catalog.at && !catBusy) {
      setCatBusy(true);
      rebuildCatalog(invoices.data).catch(() => undefined).finally(() => setCatBusy(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOffice, invoices.loading, newestInv, catalog.at]);
  const remakeCatalog = async () => {
    setCatBusy(true);
    try {
      const n = await rebuildCatalog(invoices.data);
      toast(`구매청구 품명 목록을 새로 만들었습니다. (${n.toLocaleString()}개 품목·규격)`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setCatBusy(false);
    }
  };

  const [tab, setTabState] = useState<Tab>(LS.get('tab', 'dash'));
  const setTab = (t: Tab) => (setTabState(t), LS.set('tab', t));
  const [groupBy, setGroupBy] = useState<string>(LS.get('groupBy', 'site>cat'));
  const [vmode, setVmode] = useState<VMode>(LS.get('vmode', 'both'));
  const [showProc, setShowProc] = useState<boolean>(LS.get('showProc', true));
  const [basis, setBasis] = useState<Basis>(LS.get('basis', 'site'));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fSite, setFSite] = useState('');
  const [fCat, setFCat] = useState('');
  const [fVendor, setFVendor] = useState('');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [treeOpen, setTreeOpen] = useState<Set<string>>(new Set());
  const [merge, setMerge] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [detail, setDetail] = useState<PItem | null>(null);
  const [ledgerPage, setLedgerPage] = useState(0);
  const [dsort, setDsort] = useState<Record<string, 'amt' | 'name'>>(LS.get('dsort', {}));

  const all = useMemo(() => buildRows(invoices.data, sites.data, cats.data, std.data, basis, alias), [invoices.data, sites.data, cats.data, std.data, basis, alias]);
  const canon = useMemo(() => canonNames(all), [all]);
  const allMonths = useMemo(() => [...new Set(all.map((r) => r.m))].sort(), [all]);
  const fromM = from || allMonths[0] || '';
  const toM = to || allMonths[allMonths.length - 1] || '';

  /** 기간·검색만 적용 (왼쪽 나무용) */
  const base = useMemo(() => {
    const qk = nameKey(q);
    return all.filter((r) => r.m >= fromM && r.m <= toM && (!qk || nameKey(`${r.item} ${r.spec} ${r.vendor} ${r.cat} ${r.site} ${r.proc ?? ''} ${r.note ?? ''}`).includes(qk)));
  }, [all, fromM, toM, q]);
  const rows = useMemo(() => base.filter((r) => (!fSite || r.site === fSite) && (!fCat || r.cat === fCat) && (!fVendor || r.vendor === fVendor)), [base, fSite, fCat, fVendor]);

  const pv = useMemo(() => computePivot(rows, groupBy, canon), [rows, groupBy, canon]);
  useEffect(() => setShown(PAGE), [rows, groupBy]);

  const siteOpts = useMemo(() => [...new Set(base.map((r) => r.site))].sort(cmp), [base]);
  const catOpts = useMemo(() => [...new Set(base.filter((r) => !fSite || r.site === fSite).map((r) => r.cat))].sort(cmp), [base, fSite]);
  const vendorOpts = useMemo(() => [...new Set(base.map((r) => r.vendor))].sort(cmp), [base]);
  const condTxt = [fromM && `${mLong(fromM)}~${mLong(toM)}`, fSite, fCat, fVendor, q && `검색 "${q}"`].filter(Boolean).join(' · ');
  const goPivot = (k: 'site' | 'cat' | 'vendor', v: string) => {
    if (k === 'site') setFSite(v);
    if (k === 'cat') setFCat(v);
    if (k === 'vendor') setFVendor(v);
    setCollapsed(new Set());
    setTab('pivot');
  };

  /* ===== 품목 합치기 ===== */
  const doMerge = async () => {
    const keys = [...sel];
    if (keys.length < 2) return;
    const amt = new Map<string, number>();
    for (const r of all) amt.set(r.ik, (amt.get(r.ik) ?? 0) + r.amt);
    keys.sort((a, b) => (amt.get(b) ?? 0) - (amt.get(a) ?? 0));
    const target = keys[0];
    const nm = (k: string) => (canon.get(k) ?? k).replace('\u0001', ' ');
    if (!confirm(`아래 품목을 하나로 합칠까요?\n\n기준: ${nm(target)}\n${keys.slice(1).map((k) => '+ ' + nm(k)).join('\n')}\n\n합친 뒤에도 품목 상세에서 [분리]로 되돌릴 수 있습니다.`)) return;
    const next = { ...alias };
    for (const k of keys.slice(1)) {
      for (const a in next) if (next[a] === k) next[a] = target;
      next[k] = target;
    }
    delete next[target];
    try {
      await saveItemAlias(next);
      toast(`${keys.length}개 품목을 합쳤습니다. (회사 공용)`);
      refreshCatalog();
      setMerge(false);
      setSel(new Set());
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const split = async (bk: string) => {
    const next = { ...alias };
    delete next[bk];
    try {
      await saveItemAlias(next);
      toast('분리했습니다.');
      refreshCatalog();
      setDetail(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const showSite = !pv.gk.includes('site') && !fSite;
  const showCat = !pv.gk.includes('cat');
  const showVen = !pv.gk.includes('vendor');
  const extra = (showSite ? 1 : 0) + (showCat ? 1 : 0) + (showVen ? 1 : 0);

  const exportPivot = () =>
    exportPivotXlsx(pv, `${condTxt || '전체'} · 묶음 ${GROUPS.find((g) => g[0] === groupBy)?.[1]}`, `월별품목_${fromM}~${toM}.xlsx`, { showSite, showCat, showVen }).catch((e) => toast(errMsg(e), 'err'));

  return (
    <div>
      <PageHeader title="월별 품목" desc="계산서(거래명세서) 줄을 현장·분류·업체별로 나누고, 같은 품목·규격을 월별로 쌓아 봅니다. 계산서 메뉴에 올린 자료가 바로 반영됩니다."
        actions={
          isOffice && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span>구매청구 품명 목록 {catalog.items.length.toLocaleString()}개{catalog.at ? ` · ${new Date(catalog.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
              <button className="btn-ghost h-8 text-[12px]" disabled={catBusy} onClick={remakeCatalog}>
                {catBusy ? '만드는 중…' : '품명 목록 새로 만들기'}
              </button>
            </div>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
        {TABS.filter(([k]) => isOffice || (k !== 'import' && k !== 'gipyo')).map(([k, label]) => (
          <button key={k} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${tab === k ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas hover:text-ink'}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'gipyo' ? (
        <GipyoCompare invoices={invoices.data} />
      ) : tab === 'import' ? (
        <LedgerImport invoices={invoices.data} />
      ) : (
        <>
          {/* 공통 필터 */}
          <div className="card mb-3 flex flex-wrap items-center gap-2 px-4 py-2.5">
            <span className="text-muted">기간</span>
            <select className="input h-7" value={fromM} onChange={(e) => setFrom(e.target.value)}>
              {allMonths.map((m) => (
                <option key={m} value={m}>
                  {mLong(m)}
                </option>
              ))}
            </select>
            <span className="text-muted">~</span>
            <select className="input h-7" value={toM} onChange={(e) => setTo(e.target.value)}>
              {allMonths.map((m) => (
                <option key={m} value={m}>
                  {mLong(m)}
                </option>
              ))}
            </select>
            <select className="input h-7 w-40" value={fSite} onChange={(e) => (setFSite(e.target.value), setFCat(''))}>
              <option value="">전체 현장</option>
              {siteOpts.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select className="input h-7 w-40" value={fCat} onChange={(e) => setFCat(e.target.value)}>
              <option value="">전체 분류</option>
              {catOpts.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select className="input h-7 w-40" value={fVendor} onChange={(e) => setFVendor(e.target.value)}>
              <option value="">전체 업체</option>
              {vendorOpts.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <input className="input h-7 w-44" placeholder="품명·규격·공정 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="text-muted">분류 기준</span>
            <select
              className="input h-7"
              value={basis}
              onChange={(e) => (setBasis(e.target.value as Basis), LS.set('basis', e.target.value), setFCat(''))}
              title="현장분류: 각 현장 투입집계 분류 / 표준분류: 회사 공통 분류 / 원문: 계산서에 적힌 그대로"
            >
              <option value="site">현장분류</option>
              <option value="std">표준분류</option>
              <option value="raw">계산서 원문</option>
            </select>
            {(fSite || fCat || fVendor || q) && (
              <button className="text-[12px] text-muted hover:text-ink" onClick={() => (setFSite(''), setFCat(''), setFVendor(''), setQ(''))}>
                필터 지우기
              </button>
            )}
          </div>

          {invoices.loading ? (
            <Empty>불러오는 중…</Empty>
          ) : !all.length ? (
            <Empty>계산서 자료가 없습니다. 계산서 메뉴에서 계산서정리 파일을 올리거나, '예전 자료 가져오기'로 기존 프로그램 백업을 옮기세요.</Empty>
          ) : !rows.length ? (
            <Empty>조건에 맞는 명세가 없습니다.</Empty>
          ) : tab === 'dash' ? (
            <Dash rows={rows} invoices={invoices.data} dsort={dsort} setDsort={(v) => (setDsort(v), LS.set('dsort', v))} go={goPivot} />
          ) : tab === 'pivot' ? (
            <div className="grid gap-3 xl:grid-cols-[250px_1fr]">
              <Tree
                base={base}
                fSite={fSite}
                fCat={fCat}
                fVendor={fVendor}
                open={treeOpen}
                setOpen={setTreeOpen}
                pick={(s, c, v) => (setFSite(s), setFCat(c), setFVendor(v), setCollapsed(new Set()))}
              />
              <div className="card flex min-w-0 flex-col overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                  <span className="text-muted">묶음</span>
                  <select className="input h-7" value={groupBy} onChange={(e) => (setGroupBy(e.target.value), LS.set('groupBy', e.target.value), setCollapsed(new Set()))}>
                    {GROUPS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <div className="inline-flex rounded-md border border-line p-0.5">
                    {(
                      [
                        ['both', '수량+금액'],
                        ['qty', '수량'],
                        ['amt', '금액'],
                        ['price', '단가'],
                      ] as const
                    ).map(([k, l]) => (
                      <button key={k} className={`rounded px-2 py-0.5 text-[12px] ${vmode === k ? 'bg-amber-brand text-navy-950' : 'text-muted'}`} onClick={() => (setVmode(k), LS.set('vmode', k))}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1 text-[12px] text-muted" title="월 칸 아래에 거래명세서의 공정 내용을 표시합니다">
                    <input type="checkbox" checked={showProc} onChange={(e) => (setShowProc(e.target.checked), LS.set('showProc', e.target.checked))} /> 공정 표시
                  </label>
                  <span className="text-[12px] text-muted">
                    품목·규격 <b className="text-ink">{pv.nItems.toLocaleString()}</b>개 · 금액 <b className="text-ink">{fmtA(pv.ta)}</b>원
                  </span>
                  <span className="flex-1" />
                  {isOffice &&
                    (merge ? (
                      <>
                        <span className="text-[12px] font-semibold text-amber-700">합칠 품목을 눌러 선택 ({sel.size}개)</span>
                        <button className="btn-primary h-7 text-[12px]" disabled={sel.size < 2} onClick={doMerge}>
                          선택 품목 합치기
                        </button>
                        <button className="btn-ghost h-7 text-[12px]" onClick={() => (setMerge(false), setSel(new Set()))}>
                          취소
                        </button>
                      </>
                    ) : (
                      <button className="btn-ghost h-7 text-[12px]" title="이름·규격 표기는 다르지만 같은 품목을 하나로 합칩니다 (회사 공용)" onClick={() => setMerge(true)}>
                        품목 합치기
                      </button>
                    ))}
                  {pv.gk.length > 0 && (
                    <>
                      <button className="btn-ghost h-7 text-[12px]" onClick={() => setCollapsed(new Set())}>
                        모두 펼치기
                      </button>
                      <button className="btn-ghost h-7 text-[12px]" onClick={() => setCollapsed(new Set(pv.groups.map((g) => g.path[0])))}>
                        모두 접기
                      </button>
                    </>
                  )}
                  <button className="btn-dark h-7 text-[12px]" onClick={exportPivot}>
                    엑셀 내보내기
                  </button>
                </div>
                <PivotTable
                  pv={pv}
                  vmode={vmode}
                  showProc={showProc}
                  collapsed={collapsed}
                  toggle={(pk) =>
                    setCollapsed((s) => {
                      const n = new Set(s);
                      if (n.has(pk)) n.delete(pk);
                      else n.add(pk);
                      return n;
                    })
                  }
                  showSite={showSite}
                  showCat={showCat}
                  showVen={showVen}
                  extra={extra}
                  limit={shown}
                  more={() => setShown((n) => n + PAGE)}
                  merge={merge}
                  sel={sel}
                  onItem={(it) =>
                    merge
                      ? setSel((s) => {
                          const n = new Set(s);
                          if (n.has(it.key)) n.delete(it.key);
                          else n.add(it.key);
                          return n;
                        })
                      : setDetail(it)
                  }
                />
              </div>
            </div>
          ) : tab === 'summary' ? (
            <Summary rows={rows} go={goPivot} condTxt={condTxt} />
          ) : (
            <LedgerList rows={rows} page={ledgerPage} setPage={setLedgerPage} condTxt={condTxt} />
          )}
        </>
      )}

      <Detail it={detail} alias={alias} close={() => setDetail(null)} split={isOffice ? split : undefined} />
    </div>
  );
}

/* ================= 대시보드 ================= */
function Dash({ rows, invoices, dsort, setDsort, go }: { rows: LRow[]; invoices: Invoice[]; dsort: Record<string, 'amt' | 'name'>; setDsort: (v: Record<string, 'amt' | 'name'>) => void; go: (k: 'site' | 'cat' | 'vendor', v: string) => void }) {
  const ms = [...new Set(rows.map((r) => r.m))].sort();
  const mt: Record<string, number> = {};
  for (const r of rows) mt[r.m] = (mt[r.m] ?? 0) + r.amt;
  const tot = rows.reduce((s, r) => s + r.amt, 0);
  const lm = ms[ms.length - 1];
  const pm = ms[ms.length - 2];
  const chg = pm && mt[pm] ? ((mt[lm] - mt[pm]) / mt[pm]) * 100 : null;
  const lr = rows.filter((r) => r.m === lm);
  const mx = Math.max(1, ...ms.map((m) => mt[m]));
  const topBy = (k: 'site' | 'cat' | 'vendor') => {
    const o: Record<string, number> = {};
    for (const r of rows) o[r[k]] = (o[r[k]] ?? 0) + r.amt;
    const L = Object.entries(o);
    return dsort[k] === 'name' ? L.sort((a, b) => cmp(a[0], b[0])) : L.sort((a, b) => b[1] - a[1]);
  };
  const recent = invoices.filter((i) => !(i.submitted && !i.appliedToLedger)).slice(0, 6);
  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="col-span-12 rounded-2xl bg-navy-950 px-4 py-3 text-white md:col-span-3">
        <div className="text-[12px] text-white/60">기간 누적 금액</div>
        <div className="mt-1 text-[21px] font-extrabold tabular-nums text-amber-brand">{fmtA(tot)}</div>
        <div className="text-[11.5px] text-white/60">
          {ms.length}개월 · {mLong(ms[0])} ~ {mLong(lm)}
        </div>
      </div>
      <div className="card col-span-12 px-4 py-3 md:col-span-3">
        <div className="text-[12px] text-muted">최근 월 ({mLong(lm)})</div>
        <div className="mt-1 text-[21px] font-extrabold tabular-nums">{fmtA(mt[lm])}</div>
        <div className="text-[11.5px] text-muted">
          {chg == null ? '전월 자료 없음' : <>전월 대비 <b className={chg >= 0 ? 'text-red-600' : 'text-blue-600'}>{chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(1)}%</b></>}
        </div>
      </div>
      {(
        [
          ['현장', new Set(rows.map((r) => r.site)).size, `분류 ${new Set(rows.map((r) => r.cat)).size}개`],
          ['업체', new Set(rows.map((r) => r.vendor)).size, `최근 월 ${new Set(lr.map((r) => r.vendor)).size}곳`],
          ['품목·규격', new Set(rows.map((r) => r.ik)).size, `명세 ${rows.length.toLocaleString()}건`],
        ] as const
      ).map(([l, v, s]) => (
        <div key={l} className="card col-span-4 px-4 py-3 md:col-span-2">
          <div className="text-[12px] text-muted">{l}</div>
          <div className="mt-1 text-[21px] font-extrabold tabular-nums">{v.toLocaleString()}</div>
          <div className="text-[11.5px] text-muted">{s}</div>
        </div>
      ))}
      <div className="card col-span-12 overflow-hidden lg:col-span-8">
        <div className="border-b border-line px-4 py-2.5 font-semibold">월별 금액 추이</div>
        <div className="flex h-[230px] items-stretch gap-2 overflow-x-auto px-4 py-3">
          {ms.map((m) => (
            <div key={m} className="flex min-w-[44px] max-w-[90px] flex-1 flex-col items-center gap-1" title={`${mLong(m)} ${fmtA(mt[m])}원`}>
              <span className="whitespace-nowrap text-[11px] text-muted">{fmtW(mt[m])}</span>
              <span className="flex w-3/5 flex-1 items-end">
                <span className="block w-full rounded-t-md bg-amber-brand transition-colors hover:bg-[#d48a1f]" style={{ height: `${Math.max(1, (mt[m] / mx) * 100)}%` }} />
              </span>
              <span className="text-[11.5px] text-muted">{mL(m)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="card col-span-12 overflow-hidden lg:col-span-4">
        <div className="border-b border-line px-4 py-2.5 font-semibold">최근 올린 계산서</div>
        <div className="px-4 py-1.5">
          {recent.map((i) => (
            <div key={i.id} className="flex gap-2 border-b border-line py-1.5 text-[12px] last:border-0">
              <span className="chip bg-canvas text-muted">{mL(i.month)}</span>
              <span className="flex-1 truncate" title={i.fileName}>
                {i.vendorName}
              </span>
              <span className="tabular-nums text-muted">{fmtW(i.totalAmount)}</span>
            </div>
          ))}
        </div>
      </div>
      {(
        [
          ['site', '현장별'],
          ['cat', '분류별'],
          ['vendor', '업체별'],
        ] as const
      ).map(([k, t]) => {
        const L = topBy(k);
        const top = Math.max(1, ...L.map((x) => x[1]));
        return (
          <div key={k} className="card col-span-12 overflow-hidden lg:col-span-4">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="font-semibold">{t} 금액</span>
              <span className="text-[11.5px] text-muted">{L.length}</span>
              <span className="flex-1" />
              {(
                [
                  ['amt', '금액순'],
                  ['name', '이름순'],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={`rounded px-2 py-0.5 text-[11.5px] ${(dsort[k] ?? 'amt') === v ? 'bg-amber-soft font-semibold' : 'text-muted'}`} onClick={() => setDsort({ ...dsort, [k]: v })}>
                  {l}
                </button>
              ))}
            </div>
            <div className="max-h-[330px] overflow-auto px-4 py-2">
              {L.map(([n, v]) => (
                <button key={n} className="grid w-full grid-cols-[minmax(80px,150px)_1fr_minmax(64px,auto)] items-center gap-2 py-1 text-left hover:text-blue-700" title={`${n} ${fmtA(v)}원 (누르면 월별 품목 리스트로)`} onClick={() => go(k, n)}>
                  <span className="truncate text-[12px]">{n}</span>
                  <span className="h-2 overflow-hidden rounded bg-line">
                    <span className="block h-full rounded bg-amber-brand" style={{ width: `${Math.max(2, (v / top) * 100)}%` }} />
                  </span>
                  <span className="text-right text-[12px] tabular-nums">{fmtW(v)}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================= 왼쪽 나무 ================= */
function Tree({ base, fSite, fCat, fVendor, open, setOpen, pick }: { base: LRow[]; fSite: string; fCat: string; fVendor: string; open: Set<string>; setOpen: (s: Set<string>) => void; pick: (s: string, c: string, v: string) => void }) {
  const S = useMemo(() => {
    const m = new Map<string, { a: number; c: Map<string, { a: number; v: Map<string, number> }> }>();
    for (const r of base) {
      let s = m.get(r.site);
      if (!s) m.set(r.site, (s = { a: 0, c: new Map() }));
      s.a += r.amt;
      let c = s.c.get(r.cat);
      if (!c) s.c.set(r.cat, (c = { a: 0, v: new Map() }));
      c.a += r.amt;
      c.v.set(r.vendor, (c.v.get(r.vendor) ?? 0) + r.amt);
    }
    return [...m].sort((a, b) => cmp(a[0], b[0]));
  }, [base]);
  const all = base.reduce((s, r) => s + r.amt, 0);
  const tog = (k: string) => {
    const n = new Set(open);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setOpen(n);
  };
  const on = (s: string, c: string, v: string) => fSite === s && fCat === c && fVendor === v;
  const node = (key: string, label: string, amt: number, lv: number, active: boolean, click: () => void, togKey?: string, isOpen?: boolean) => (
    <div
      key={key}
      className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 leading-tight ${active ? 'bg-amber-soft shadow-[inset_3px_0_0_#e8a33d]' : 'hover:bg-canvas'} ${lv === 0 ? 'font-bold' : lv === 1 ? 'font-semibold' : lv === 3 ? 'pl-10 text-[#3c4658]' : 'pl-6'}`}
      onClick={click}
    >
      {togKey && (
        <span
          className={`inline-block w-3.5 text-amber-brand transition-transform ${isOpen ? '' : '-rotate-90'}`}
          onClick={(e) => {
            e.stopPropagation();
            tog(togKey);
          }}
        >
          ▾
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-muted">{fmtW(amt)}</span>
    </div>
  );
  return (
    <div className="card max-h-[calc(100vh-260px)] overflow-auto p-1.5">
      <div className="px-2 pb-1 pt-1 text-[12px] font-semibold">현장 · 분류 · 업체</div>
      {node('all', '전체 현장', all, 0, on('', '', ''), () => pick('', '', ''))}
      <div className="px-2 pb-1 pt-2 text-[11px] text-muted">현장 {S.length}곳</div>
      {S.map(([s, so]) => {
        const sk = 's|' + s;
        const o1 = open.has(sk) || fSite === s;
        return (
          <Fragment key={sk}>
            {node(sk, s, so.a, 1, on(s, '', ''), () => (setOpen(new Set(open).add(sk)), pick(s, '', '')), sk, o1)}
            {o1 &&
              [...so.c].sort((a, b) => cmp(a[0], b[0])).map(([c, co]) => {
                const ck = `c|${s}|${c}`;
                const o2 = open.has(ck) || (fSite === s && fCat === c);
                return (
                  <Fragment key={ck}>
                    {node(ck, c, co.a, 2, on(s, c, ''), () => (setOpen(new Set(open).add(ck)), pick(s, c, '')), ck, o2)}
                    {o2 && [...co.v].sort((a, b) => b[1] - a[1]).map(([v, va]) => node(`v|${s}|${c}|${v}`, v, va, 3, on(s, c, v), () => pick(s, c, v)))}
                  </Fragment>
                );
              })}
          </Fragment>
        );
      })}
    </div>
  );
}

/* ================= 월별 품목 표 ================= */
function PivotTable({
  pv,
  vmode,
  showProc,
  collapsed,
  toggle,
  showSite,
  showCat,
  showVen,
  extra,
  limit,
  more,
  merge,
  sel,
  onItem,
}: {
  pv: ReturnType<typeof computePivot>;
  vmode: VMode;
  showProc: boolean;
  collapsed: Set<string>;
  toggle: (pk: string) => void;
  showSite: boolean;
  showCat: boolean;
  showVen: boolean;
  extra: number;
  limit: number;
  more: () => void;
  merge: boolean;
  sel: Set<string>;
  onItem: (it: PItem) => void;
}) {
  // 화면에 그릴 줄 목록 (묶음 줄 + 품목 줄)
  const list: ({ t: 'g'; path: string[]; L: number } | { t: 'i'; it: PItem })[] = [];
  let prev: string[] = [];
  const hidden = (path: string[], L: number) => {
    for (let j = 0; j < L; j++) if (collapsed.has(path.slice(0, j + 1).join('\u0001'))) return true;
    return false;
  };
  for (const g of pv.groups) {
    let d = 0;
    while (d < g.path.length && g.path[d] === prev[d]) d++;
    for (let L = d; L < g.path.length; L++) {
      if (hidden(g.path, L)) break;
      list.push({ t: 'g', path: g.path, L });
    }
    prev = g.path;
    if (hidden(g.path, g.path.length)) continue;
    for (const it of g.list) list.push({ t: 'i', it });
  }
  const proc = (c: Cell) => {
    if (!showProc || !c.ps?.size) return null;
    const L = [...c.ps];
    const t = L.join(' · ');
    return (
      <div className="mt-0.5 max-w-[160px] truncate text-[10.5px] text-muted underline decoration-dotted" title={t}>
        {L.length > 2 ? `${L.slice(0, 2).join(' · ')} 외 ${L.length - 2}` : t}
      </div>
    );
  };
  const cell = (c: Cell | undefined, pp: number) => {
    if (!c) return null;
    if (!c.q && !c.a) return <span className="text-muted">0</span>;
    const p = c.q ? c.a / c.q : 0;
    if (vmode === 'qty')
      return (
        <>
          {fmtQ(c.q)} <span className="text-[11px] text-muted">({fmtA(p)})</span>
          {proc(c)}
        </>
      );
    if (vmode === 'amt')
      return (
        <>
          {fmtA(c.a)}
          {proc(c)}
        </>
      );
    if (vmode === 'price') {
      const up = pp && p && Math.abs(p - pp) / pp > 0.001 ? (p > pp ? 1 : -1) : 0;
      return (
        <span className={up > 0 ? 'text-red-600' : up < 0 ? 'text-blue-600' : ''}>
          {fmtA(p)}
          {up > 0 ? ' ▲' : up < 0 ? ' ▼' : ''}
        </span>
      );
    }
    return (
      <>
        <b className="font-semibold">
          {fmtQ(c.q)} <span className="text-[11px] font-normal text-muted">({fmtA(p)})</span>
        </b>
        <div className="text-[11.5px] text-muted">{fmtA(c.a)}</div>
        {proc(c)}
      </>
    );
  };
  const vis = list.slice(0, limit);
  return (
    <div className="max-h-[calc(100vh-300px)] overflow-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th className="left-0 z-20 min-w-[160px] bg-[#f7f8fb]">품목</th>
            <th>규격</th>
            <th>단위</th>
            {showSite && <th>현장</th>}
            {showCat && <th>분류</th>}
            {showVen && <th>업체</th>}
            <th className="num">합계</th>
            {pv.months.map((m) => (
              <th key={m} className="num">
                {mLong(m)}
                {(vmode === 'both' || vmode === 'qty') && <div className="text-[10.5px] font-normal">수량 (단가)</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="bg-navy-950 font-bold text-white hover:[&>td]:bg-navy-950">
            <td colSpan={3 + extra}>전체 합계 (금액)</td>
            <td className="num">{fmtA(pv.ta)}</td>
            {pv.months.map((m) => (
              <td key={m} className="num">
                {fmtA(pv.mt[m])}
              </td>
            ))}
          </tr>
          {vis.map((e, i) => {
            if (e.t === 'g') {
              const pk = e.path.slice(0, e.L + 1).join('\u0001');
              const p = pv.pre.get(pk)!;
              const c = collapsed.has(pk);
              return (
                <tr key={'g' + pk} className={`cursor-pointer font-semibold ${e.L === 0 ? 'bg-[#dce2ec]' : 'bg-[#edf0f5]'}`} onClick={() => toggle(pk)}>
                  <td colSpan={3 + extra} style={{ paddingLeft: 10 + e.L * 14 }}>
                    <span className={`mr-1 inline-block text-amber-brand transition-transform ${c ? '-rotate-90' : ''}`}>▾</span>
                    <span className="chip mr-1.5 bg-white/70 text-[10.5px] text-muted">{GLBL[pv.gk[e.L]]}</span>
                    {e.path[e.L]} <span className="ml-1 text-[11px] font-normal text-muted">{p.n}품목</span>
                  </td>
                  <td className="num">{fmtA(p.ta)}</td>
                  {pv.months.map((m) => (
                    <td key={m} className="num">
                      {vmode === 'qty' ? '' : fmtA(p.mt[m])}
                    </td>
                  ))}
                </tr>
              );
            }
            const it = e.it;
            const nv = it.names.size;
            let pp = 0;
            return (
              <tr key={'i' + i + it.key} className={`cursor-pointer align-top ${sel.has(it.key) ? 'bg-amber-soft' : ''} ${merge ? 'hover:outline hover:outline-1 hover:outline-amber-brand' : ''}`} onClick={() => onItem(it)}>
                <td className="pl-5">
                  {it.item || <span className="text-muted">-</span>}
                  {nv > 1 && (
                    <span className="chip ml-1 bg-canvas text-[10.5px] text-muted" title={'같은 품목으로 합친 표기:\n' + [...it.names.keys()].map((n) => n.replace('\u0001', ' / ')).join('\n')}>
                      +{nv - 1}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap">{it.spec}</td>
                <td className="text-muted">{it.unit}</td>
                {showSite && <td className="whitespace-nowrap">{it.sites.size > 1 ? <span className="chip bg-canvas">{it.sites.size}개 현장</span> : [...it.sites][0]}</td>}
                {showCat && <td className="whitespace-nowrap">{it.cat}</td>}
                {showVen && <td className="max-w-[160px] truncate">{[...it.vendors].join(', ')}</td>}
                <td className="num whitespace-nowrap font-semibold">
                  {vmode === 'qty' ? (
                    <>
                      {fmtQ(it.tq)} <span className="text-[11px] text-muted">{it.unit}</span>
                    </>
                  ) : vmode === 'both' ? (
                    <>
                      {fmtQ(it.tq)}
                      <div className="text-[11.5px] font-normal text-muted">{fmtA(it.ta)}</div>
                    </>
                  ) : (
                    fmtA(it.ta)
                  )}
                </td>
                {pv.months.map((m) => {
                  const c = it.cells[m];
                  const out = cell(c, pp);
                  if (c && c.q) pp = c.a / c.q;
                  return (
                    <td key={m} className="num whitespace-nowrap">
                      {out}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.length > limit && (
        <button className="w-full py-2.5 text-[12px] text-muted hover:bg-canvas" onClick={more}>
          나머지 {(list.length - limit).toLocaleString()}줄 더 보기
        </button>
      )}
    </div>
  );
}

/* ================= 품목 상세 ================= */
function Detail({ it, alias, close, split }: { it: PItem | null; alias: Record<string, string>; close: () => void; split?: (bk: string) => void }) {
  if (!it) return null;
  const recs = [...it.recs].sort((a, b) => cmp(a.m, b.m) || cmp(a.date, b.date) || cmp(a.site, b.site));
  const bm: Record<string, { q: number; a: number; n: number }> = {};
  for (const r of recs) {
    const o = bm[r.m] ?? (bm[r.m] = { q: 0, a: 0, n: 0 });
    o.q += r.qty;
    o.a += r.amt;
    o.n++;
  }
  const pr = recs.filter((r) => r.qty).map((r) => r.amt / r.qty);
  const xls = () =>
    exportTablesXlsx(
      [
        {
          name: '거래명세',
          title: `품목 상세 — ${it.item} ${it.spec}`,
          aoa: [['월', '일자', '현장', '분류', '업체', '품목', '규격', '단위', '수량', '단가', '금액', '공정', '비고'], ...recs.map((r) => [mLong(r.m), r.date ?? '', r.site, r.cat, r.vendor, r.item, r.spec, r.unit, r.qty, r.qty ? Math.round(r.amt / r.qty) : null, Math.round(r.amt), r.proc ?? '', r.note ?? ''])],
        },
      ],
      `품목상세_${it.item}_${it.spec}.xlsx`,
    );
  return (
    <Modal
      open
      wide
      title={`${it.item} ${it.spec}${it.unit ? ' · ' + it.unit : ''}`}
      onClose={close}
      footer={
        <button className="btn-dark" onClick={xls}>
          엑셀
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {(
          [
            ['총 수량', `${fmtQ(it.tq)} ${it.unit}`],
            ['총 금액', `${fmtA(it.ta)}원`],
            ['평균 단가', it.tq ? fmtA(it.ta / it.tq) : '-'],
            ['단가 범위', pr.length ? `${fmtA(Math.min(...pr))} ~ ${fmtA(Math.max(...pr))}` : '-'],
            ['거래 업체', `${it.vendors.size}곳`],
            ['명세 건수', `${recs.length}건`],
          ] as const
        ).map(([l, v]) => (
          <div key={l} className="rounded-lg bg-canvas px-3 py-2">
            <div className="text-[11.5px] text-muted">{l}</div>
            <b className="tabular-nums">{v}</b>
          </div>
        ))}
      </div>
      {it.names.size > 1 && (
        <div className="mb-3 rounded-xl border border-line">
          <div className="border-b border-line px-3 py-2 text-[12.5px] font-semibold">
            같은 품목으로 합친 표기 <span className="font-normal text-muted">자동 = 띄어쓰기·표기 차이로 자동 인식 / 직접 = [품목 합치기]로 합침</span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>품명</th>
                <th>규격</th>
                <th className="num">건수</th>
                <th>방식</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...it.names].sort((a, b) => b[1] - a[1]).map(([nm, c]) => {
                const [i, sp] = nm.split('\u0001');
                const bk = it.nameKey.get(nm)!;
                const man = !!alias[bk];
                return (
                  <tr key={nm}>
                    <td>{i}</td>
                    <td>{sp}</td>
                    <td className="num">{c}</td>
                    <td>{man ? '직접' : '자동'}</td>
                    <td className="text-right">
                      {man && split && (
                        <button className="btn-ghost h-6 text-[11.5px]" onClick={() => split(bk)}>
                          분리
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mb-3 rounded-xl border border-line">
        <div className="border-b border-line px-3 py-2 text-[12.5px] font-semibold">월별</div>
        <table className="tbl">
          <thead>
            <tr>
              <th>월</th>
              <th className="num">수량</th>
              <th className="num">금액</th>
              <th className="num">평균단가</th>
              <th className="num">건수</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(bm)
              .sort()
              .map((m) => (
                <tr key={m}>
                  <td>{mLong(m)}</td>
                  <td className="num">{fmtQ(bm[m].q)}</td>
                  <td className="num">{fmtA(bm[m].a)}</td>
                  <td className="num">{bm[m].q ? fmtA(bm[m].a / bm[m].q) : ''}</td>
                  <td className="num">{bm[m].n}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-line">
        <div className="border-b border-line px-3 py-2 text-[12.5px] font-semibold">거래 명세</div>
        <LedgerTable rows={recs} />
      </div>
    </Modal>
  );
}

/* ================= 요약 ================= */
function Summary({ rows, go, condTxt }: { rows: LRow[]; go: (k: 'site' | 'cat' | 'vendor', v: string) => void; condTxt: string }) {
  const ms = [...new Set(rows.map((r) => r.m))].sort();
  const matrix = (k: 'site' | 'cat' | 'vendor') => {
    const M = new Map<string, { k: string; mt: Record<string, number>; t: number }>();
    for (const r of rows) {
      let o = M.get(r[k]);
      if (!o) M.set(r[k], (o = { k: r[k], mt: {}, t: 0 }));
      o.mt[r.m] = (o.mt[r.m] ?? 0) + r.amt;
      o.t += r.amt;
    }
    return [...M.values()].sort((a, b) => b.t - a.t);
  };
  const S = matrix('site');
  const Cc = matrix('cat');
  const V = matrix('vendor');
  const catOrder = Cc.map((o) => o.k);
  const X = new Map<string, { k: string; mt: Record<string, number>; t: number }>();
  for (const r of rows) {
    let o = X.get(r.site);
    if (!o) X.set(r.site, (o = { k: r.site, mt: {}, t: 0 }));
    o.mt[r.cat] = (o.mt[r.cat] ?? 0) + r.amt;
    o.t += r.amt;
  }
  const XS = [...X.values()].sort((a, b) => b.t - a.t);
  const card = (title: string, k: 'site' | 'cat' | 'vendor', label: string, list: typeof S, cols: string[], colLabel: (c: string) => string) => (
    <div className="card flex max-h-[460px] flex-col overflow-hidden">
      <div className="flex items-center border-b border-line px-4 py-2.5">
        <span className="font-semibold">{title}</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted">행을 누르면 품목 리스트로 이동</span>
      </div>
      <div className="overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>{label}</th>
              {cols.map((c) => (
                <th key={c} className="num">
                  {colLabel(c)}
                </th>
              ))}
              <th className="num">합계</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.k} className="cursor-pointer" onClick={() => go(k, o.k)}>
                <td className="whitespace-nowrap font-semibold">{o.k}</td>
                {cols.map((c) => (
                  <td key={c} className="num">
                    {fmtA(o.mt[c] ?? 0)}
                  </td>
                ))}
                <td className="num font-semibold">{fmtA(o.t)}</td>
              </tr>
            ))}
            <tr className="bg-navy-950 font-bold text-white hover:[&>td]:bg-navy-950">
              <td>합계</td>
              {cols.map((c) => (
                <td key={c} className="num">
                  {fmtA(list.reduce((s, o) => s + (o.mt[c] ?? 0), 0))}
                </td>
              ))}
              <td className="num">{fmtA(list.reduce((s, o) => s + o.t, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
  const mk = (lbl: string, list: typeof S, keys: string[], hdr: string[]) => [
    [lbl, ...hdr, '합계'],
    ...list.map((o) => [o.k, ...keys.map((k) => Math.round(o.mt[k] ?? 0)), Math.round(o.t)]),
    ['합계', ...keys.map((k) => Math.round(list.reduce((s, o) => s + (o.mt[k] ?? 0), 0))), Math.round(list.reduce((s, o) => s + o.t, 0))],
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] text-muted">금액 기준(공급가액) · 현재 필터 적용</span>
        <span className="flex-1" />
        <button
          className="btn-dark h-7 text-[12px]"
          onClick={() =>
            exportTablesXlsx(
              [
                { name: '현장별', title: '현장별 월 금액', sub: condTxt, aoa: mk('현장', S, ms, ms.map(mLong)), boldFirstCol: true },
                { name: '분류별', title: '분류별 월 금액', sub: condTxt, aoa: mk('분류', Cc, ms, ms.map(mLong)), boldFirstCol: true },
                { name: '업체별', title: '업체별 월 금액', sub: condTxt, aoa: mk('업체', V, ms, ms.map(mLong)), boldFirstCol: true },
                { name: '현장x분류', title: '현장 × 분류 금액', sub: condTxt, aoa: mk('현장', XS, catOrder, catOrder), boldFirstCol: true },
              ],
              `현장분류업체_요약.xlsx`,
            )
          }
        >
          요약 엑셀 내보내기
        </button>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {card('현장별 월 금액', 'site', '현장', S, ms, mLong)}
        {card('분류별 월 금액', 'cat', '분류', Cc, ms, mLong)}
        {card('업체별 월 금액', 'vendor', '업체', V, ms, mLong)}
        {card('현장 × 분류 금액', 'site', '현장', XS, catOrder, (c) => c)}
      </div>
    </div>
  );
}

/* ================= 전체 명세 ================= */
function LedgerList({ rows, page, setPage, condTxt }: { rows: LRow[]; page: number; setPage: (n: number) => void; condTxt: string }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => cmp(a.m, b.m) || cmp(a.site, b.site) || cmp(a.cat, b.cat) || cmp(a.vendor, b.vendor) || cmp(a.date, b.date)), [rows]);
  const PS = 300;
  const pages = Math.max(1, Math.ceil(sorted.length / PS));
  const p = Math.min(page, pages - 1);
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <span className="font-semibold">전체 명세</span>
        <span className="text-[12px] text-muted">
          {sorted.length.toLocaleString()}건 · {fmtA(sorted.reduce((s, r) => s + r.amt, 0))}원
        </span>
        <span className="flex-1" />
        <button
          className="btn-dark h-7 text-[12px]"
          onClick={() =>
            exportTablesXlsx(
              [
                {
                  name: '전체 명세',
                  title: '계산서 전체 명세',
                  sub: condTxt,
                  aoa: [['월', '현장', '분류', '업체', '일자', '품목', '규격', '단위', '수량', '단가', '금액', '공정', '비고'], ...sorted.map((r) => [mLong(r.m), r.site, r.cat, r.vendor, r.date ?? '', r.item, r.spec, r.unit, r.qty, r.qty ? Math.round(r.amt / r.qty) : null, Math.round(r.amt), r.proc ?? '', r.note ?? ''])],
                },
              ],
              '계산서_전체명세.xlsx',
            )
          }
        >
          엑셀 내보내기
        </button>
      </div>
      <div className="max-h-[calc(100vh-330px)] overflow-auto">
        <LedgerTable rows={sorted.slice(p * PS, (p + 1) * PS)} />
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[12px]">
          <button className="btn-ghost h-7" disabled={p === 0} onClick={() => setPage(p - 1)}>
            이전
          </button>
          <span>
            {p + 1} / {pages}
          </span>
          <button className="btn-ghost h-7" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
            다음
          </button>
        </div>
      )}
    </div>
  );
}

function LedgerTable({ rows }: { rows: LRow[] }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>월</th>
          <th>일자</th>
          <th>현장</th>
          <th>분류</th>
          <th>업체</th>
          <th>품명</th>
          <th>규격</th>
          <th className="num">수량</th>
          <th className="num">단가</th>
          <th className="num">금액</th>
          <th>공정·비고</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap">{mL(r.m)}</td>
            <td className="whitespace-nowrap text-muted">{r.date}</td>
            <td className="whitespace-nowrap">{r.site}</td>
            <td className={`whitespace-nowrap ${r.cat === UNCAT ? 'text-amber-700' : ''}`}>{r.cat}</td>
            <td className="whitespace-nowrap">{r.vendor}</td>
            <td>{r.item}</td>
            <td className="whitespace-nowrap">{r.spec}</td>
            <td className="num">
              {fmtQ(r.qty)} {r.unit}
            </td>
            <td className="num">{r.qty ? fmtA(r.amt / r.qty) : ''}</td>
            <td className="num">{fmtA(r.amt)}</td>
            <td className="max-w-[240px] truncate text-muted" title={[r.proc, r.note].filter(Boolean).join(' · ')}>
              {[r.proc, r.note].filter(Boolean).join(' · ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
