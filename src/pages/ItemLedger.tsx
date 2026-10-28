import { Fragment, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useCollection } from '../lib/db';
import { C } from '../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../lib/hooks';
import { NO_CAT, stdOfText } from '../lib/catMatch';
import { lineQty } from '../lib/matching';
import { nameKey, specKey, won } from '../lib/normalize';
import { Empty, Modal, PageHeader, Stat } from '../components/ui';
import type { Invoice } from '../types';

/** 계산서 한 줄을 평평하게 */
interface Row {
  month: string;
  siteId: string;
  site: string;
  vendor: string;
  cat: string;
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  amount: number;
  date?: string;
  process?: string;
  itemKey: string;
}

type Group = 'site-cat' | 'site-cat-vendor' | 'vendor' | 'cat' | 'item';
type Value = 'qty' | 'amount' | 'both' | 'price';
type Basis = 'site' | 'std' | 'raw';

const GROUP_LABEL: Record<Group, string> = {
  'site-cat': '현장 → 분류',
  'site-cat-vendor': '현장 → 분류 → 업체',
  cat: '분류 (전 현장)',
  vendor: '업체',
  item: '품목 통합',
};
const UNCAT = '미분류';
const fmtQty = (n: number) => (Math.round(n * 100) / 100).toLocaleString('ko-KR');

function exportBook(fileName: string, sheets: { name: string; aoa: (string | number | null)[][] }[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    ws['!cols'] = (s.aoa[0] ?? []).map((_, i) => ({ wch: i < 4 ? 18 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  }
  XLSX.writeFile(wb, fileName);
}

/** 계산서 월별 품목 관리: 저장된 계산서 줄을 품목·규격별 월 리스트로 */
export default function ItemLedger() {
  const invoices = useCollection<Invoice>(C.invoices, []);
  const sites = useSites();
  const cats = useSiteCategories();
  const std = useStandardCategories();
  const [tab, setTab] = useState<'items' | 'summary' | 'ledger'>('items');
  const [group, setGroup] = useState<Group>('site-cat');
  const [value, setValue] = useState<Value>('amount');
  const [basis, setBasis] = useState<Basis>('site');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fSite, setFSite] = useState('');
  const [fCat, setFCat] = useState('');
  const [fVendor, setFVendor] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<{ title: string; rows: Row[] } | null>(null);

  // 1) 전체 줄 펼치기 (업체가 포털로 제출만 하고 아직 반영 안 한 명세는 제외 — 엑셀 계산서와 중복 방지)
  const all = useMemo(() => {
    const siteName = new Map(sites.data.map((s) => [s.id, s.name]));
    const catById = new Map(cats.data.map((c) => [c.id, c]));
    const stdById = new Map(std.data.map((s) => [s.id, s.name]));
    const out: Row[] = [];
    for (const inv of invoices.data) {
      if (inv.submitted && !inv.appliedToLedger) continue;
      if (!siteName.has(inv.siteId)) continue; // 담당 현장 아님 / 삭제된 현장
      for (const l of inv.lines) {
        const raw = (l.categoryText || '').trim();
        const sc = l.siteCategoryId ? catById.get(l.siteCategoryId) : undefined;
        let cat: string;
        if (basis === 'raw') cat = raw && raw !== NO_CAT ? raw : UNCAT;
        else if (basis === 'site') cat = sc?.name ?? UNCAT;
        else cat = (sc?.standardCategoryId && stdById.get(sc.standardCategoryId)) || stdOfText(raw, std.data)?.name || UNCAT;
        out.push({
          month: inv.month,
          siteId: inv.siteId,
          site: siteName.get(inv.siteId)!,
          vendor: inv.vendorName,
          cat,
          itemName: l.itemName.trim(),
          spec: (l.spec || '').trim() === '0' ? '' : (l.spec || '').trim(),
          unit: l.unit,
          qty: lineQty(l),
          amount: l.finalAmount,
          date: l.receivedDate,
          process: l.process,
          itemKey: `${nameKey(l.itemName)}|${specKey(l.spec)}`,
        });
      }
    }
    return out;
  }, [invoices.data, sites.data, cats.data, std.data, basis]);

  const allMonths = useMemo(() => [...new Set(all.map((r) => r.month))].sort(), [all]);
  const fromM = from || allMonths[Math.max(0, allMonths.length - 12)] || '';
  const toM = to || allMonths[allMonths.length - 1] || '';
  const months = allMonths.filter((m) => m >= fromM && m <= toM);

  // 2) 필터
  const rows = useMemo(() => {
    const qk = nameKey(q);
    return all.filter(
      (r) =>
        r.month >= fromM &&
        r.month <= toM &&
        (!fSite || r.siteId === fSite) &&
        (!fCat || r.cat === fCat) &&
        (!fVendor || r.vendor === fVendor) &&
        (!qk || nameKey(r.itemName).includes(qk) || nameKey(r.spec).includes(qk)),
    );
  }, [all, fromM, toM, fSite, fCat, fVendor, q]);

  const catOptions = useMemo(() => [...new Set(all.filter((r) => !fSite || r.siteId === fSite).map((r) => r.cat))].sort((a, b) => a.localeCompare(b, 'ko')), [all, fSite]);
  const vendorOptions = useMemo(() => [...new Set(all.map((r) => r.vendor))].sort((a, b) => a.localeCompare(b, 'ko')), [all]);
  const total = rows.reduce((a, r) => a + r.amount, 0);

  // 3) 품목 리스트: 묶음 → 품목·규격 → 월
  const groupKeyOf = (r: Row): string[] =>
    group === 'site-cat' ? [r.site, r.cat] : group === 'site-cat-vendor' ? [r.site, r.cat, r.vendor] : group === 'vendor' ? [r.vendor] : group === 'cat' ? [r.cat] : [];
  const pivot = useMemo(() => {
    type Item = { name: string; spec: string; unit: string; key: string; byM: Map<string, { qty: number; amount: number }>; qty: number; amount: number; rows: Row[] };
    const groups = new Map<string, { path: string[]; items: Map<string, Item>; byM: Map<string, number>; amount: number }>();
    for (const r of rows) {
      const path = groupKeyOf(r);
      const gk = path.join(' › ');
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { path, items: new Map(), byM: new Map(), amount: 0 }));
      let it = g.items.get(r.itemKey);
      if (!it) g.items.set(r.itemKey, (it = { name: r.itemName, spec: r.spec, unit: r.unit, key: r.itemKey, byM: new Map(), qty: 0, amount: 0, rows: [] }));
      const c = it.byM.get(r.month) ?? { qty: 0, amount: 0 };
      c.qty += r.qty;
      c.amount += r.amount;
      it.byM.set(r.month, c);
      it.qty += r.qty;
      it.amount += r.amount;
      it.rows.push(r);
      g.byM.set(r.month, (g.byM.get(r.month) ?? 0) + r.amount);
      g.amount += r.amount;
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([key, g]) => ({ key, ...g, items: [...g.items.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.spec.localeCompare(b.spec, 'ko')) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, group]);

  const cell = (c: { qty: number; amount: number } | undefined, prev?: { qty: number; amount: number }) => {
    if (!c) return '';
    if (value === 'qty') return fmtQty(c.qty);
    if (value === 'amount') return won(c.amount);
    if (value === 'both') return `${fmtQty(c.qty)} / ${won(c.amount)}`;
    const p = c.qty ? c.amount / c.qty : 0;
    const pp = prev && prev.qty ? prev.amount / prev.qty : 0;
    const arrow = pp && Math.round(p) > Math.round(pp) ? ' ▲' : pp && Math.round(p) < Math.round(pp) ? ' ▼' : '';
    return won(p) + arrow;
  };
  const cellClass = (c?: { qty: number; amount: number }, prev?: { qty: number; amount: number }) => {
    if (value !== 'price' || !c || !prev || !prev.qty || !c.qty) return '';
    const p = Math.round(c.amount / c.qty);
    const pp = Math.round(prev.amount / prev.qty);
    return p > pp ? 'text-red-600' : p < pp ? 'text-blue-600' : '';
  };

  const exportItems = () => {
    const head = [...(group === 'item' ? [] : ['묶음']), '품명', '규격', '단위', ...months, '합계'];
    const aoa: (string | number | null)[][] = [head];
    for (const g of pivot)
      for (const it of g.items) {
        const vals = months.map((m) => {
          const c = it.byM.get(m);
          if (!c) return null;
          return value === 'qty' ? c.qty : value === 'price' ? (c.qty ? Math.round(c.amount / c.qty) : null) : c.amount;
        });
        const tot = value === 'qty' ? it.qty : value === 'price' ? (it.qty ? Math.round(it.amount / it.qty) : null) : it.amount;
        aoa.push([...(group === 'item' ? [] : [g.key]), it.name, it.spec, it.unit, ...vals, tot]);
      }
    exportBook(`월별품목_${fromM}~${toM}.xlsx`, [{ name: `월별품목(${value === 'qty' ? '수량' : value === 'price' ? '단가' : '금액'})`, aoa }]);
  };

  // 4) 요약
  const summary = useMemo(() => {
    const by = (f: (r: Row) => string) => {
      const m = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const k = f(r);
        const mm = m.get(k) ?? new Map<string, number>();
        mm.set(r.month, (mm.get(r.month) ?? 0) + r.amount);
        m.set(k, mm);
      }
      return [...m.entries()].map(([k, mm]) => ({ k, mm, total: [...mm.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
    };
    const siteList = [...new Set(rows.map((r) => r.site))].sort((a, b) => a.localeCompare(b, 'ko'));
    const cross = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const mm = cross.get(r.cat) ?? new Map<string, number>();
      mm.set(r.site, (mm.get(r.site) ?? 0) + r.amount);
      cross.set(r.cat, mm);
    }
    return { site: by((r) => r.site), cat: by((r) => r.cat), vendor: by((r) => r.vendor), siteList, cross: [...cross.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')) };
  }, [rows]);

  const sumAoa = (title: string, list: { k: string; mm: Map<string, number>; total: number }[]) => [
    [title, ...months, '합계'],
    ...list.map((x) => [x.k, ...months.map((m) => x.mm.get(m) ?? null), x.total]),
    ['합계', ...months.map((m) => list.reduce((a, x) => a + (x.mm.get(m) ?? 0), 0)), list.reduce((a, x) => a + x.total, 0)],
  ];
  const crossAoa = () => [
    ['분류', ...summary.siteList, '합계'],
    ...summary.cross.map(([c, mm]) => [c, ...summary.siteList.map((s) => mm.get(s) ?? null), [...mm.values()].reduce((a, b) => a + b, 0)]),
  ];
  const ledgerAoa = () => [
    ['월', '현장', '분류', '업체', '입고일', '품명', '규격', '단위', '수량', '단가', '금액', '공정'],
    ...rows.map((r) => [r.month, r.site, r.cat, r.vendor, r.date ?? '', r.itemName, r.spec, r.unit, r.qty, r.qty ? Math.round(r.amount / r.qty) : null, r.amount, r.process ?? '']),
  ];

  const SumTable = ({ title, list }: { title: string; list: { k: string; mm: Map<string, number>; total: number }[] }) => (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-2.5 font-semibold">{title}별 월 금액</div>
      <div className="max-h-[420px] overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>{title}</th>
              {months.map((m) => (
                <th key={m} className="num">
                  {m.slice(2).replace('-', '.')}
                </th>
              ))}
              <th className="num">합계</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.k}>
                <td className="whitespace-nowrap">{x.k}</td>
                {months.map((m) => (
                  <td key={m} className="num">
                    {x.mm.get(m) ? won(x.mm.get(m)!) : ''}
                  </td>
                ))}
                <td className="num font-semibold">{won(x.total)}</td>
              </tr>
            ))}
            <tr className="bg-[#f7f8fb] font-semibold">
              <td>합계</td>
              {months.map((m) => (
                <td key={m} className="num">
                  {won(list.reduce((a, x) => a + (x.mm.get(m) ?? 0), 0))}
                </td>
              ))}
              <td className="num">{won(list.reduce((a, x) => a + x.total, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  const itemCount = pivot.reduce((a, g) => a + g.items.length, 0);

  return (
    <div>
      <PageHeader
        title="월별 품목"
        desc="저장된 계산서(거래명세서) 줄을 현장·분류·업체별로 나누고, 같은 품목·규격을 월별로 쌓아 봅니다."
        actions={
          <button
            className="btn-ghost"
            disabled={!rows.length}
            onClick={() =>
              tab === 'items'
                ? exportItems()
                : tab === 'summary'
                  ? exportBook(`현장분류업체요약_${fromM}~${toM}.xlsx`, [
                      { name: '현장별', aoa: sumAoa('현장', summary.site) },
                      { name: '분류별', aoa: sumAoa('분류', summary.cat) },
                      { name: '업체별', aoa: sumAoa('업체', summary.vendor) },
                      { name: '분류×현장', aoa: crossAoa() },
                    ])
                  : exportBook(`계산서명세_${fromM}~${toM}.xlsx`, [{ name: '명세', aoa: ledgerAoa() }])
            }
          >
            엑셀 내보내기
          </button>
        }
      />

      <div className="mb-3 inline-flex rounded-lg border border-line bg-white p-0.5">
        {(
          [
            ['items', '월별 품목 리스트'],
            ['summary', '현장·분류·업체 요약'],
            ['ledger', '전체 명세'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`rounded-md px-3 py-1 text-[12.5px] ${tab === k ? 'bg-navy-950 text-white' : 'text-muted hover:text-ink'}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="card mb-3 flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className="text-muted">기간</span>
        <select className="input h-7" value={fromM} onChange={(e) => setFrom(e.target.value)}>
          {allMonths.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <span className="text-muted">~</span>
        <select className="input h-7" value={toM} onChange={(e) => setTo(e.target.value)}>
          {allMonths.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select className="input h-7 w-44" value={fSite} onChange={(e) => (setFSite(e.target.value), setFCat(''))}>
          <option value="">전체 현장</option>
          {sites.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} {s.name}
            </option>
          ))}
        </select>
        <select className="input h-7 w-40" value={fCat} onChange={(e) => setFCat(e.target.value)}>
          <option value="">전체 분류</option>
          {catOptions.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select className="input h-7 w-40" value={fVendor} onChange={(e) => setFVendor(e.target.value)}>
          <option value="">전체 업체</option>
          {vendorOptions.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <input className="input h-7 w-40" placeholder="품명·규격 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-muted">분류 기준</span>
        <select className="input h-7" value={basis} onChange={(e) => (setBasis(e.target.value as Basis), setFCat(''))} title="현장분류: 각 현장 투입집계 분류 / 표준분류: 회사 공통 분류 / 원문: 계산서에 적힌 그대로">
          <option value="site">현장분류</option>
          <option value="std">표준분류</option>
          <option value="raw">계산서 원문</option>
        </select>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="기간 금액" value={`${won(total)}원`} accent />
        <Stat label="명세 줄" value={rows.length.toLocaleString()} />
        <Stat label="품목·규격" value={itemCount.toLocaleString()} sub={GROUP_LABEL[group] + ' 기준'} />
        <Stat label="미분류 금액" value={`${won(rows.filter((r) => r.cat === UNCAT).reduce((a, r) => a + r.amount, 0))}원`} sub="기준정보 > 분류 > 분류 원문 사전에서 정리" />
      </div>

      {invoices.loading ? (
        <Empty>불러오는 중…</Empty>
      ) : !rows.length ? (
        <Empty>이 조건에 맞는 계산서 줄이 없습니다.</Empty>
      ) : tab === 'items' ? (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <span className="text-muted">묶음</span>
            <select className="input h-7" value={group} onChange={(e) => setGroup(e.target.value as Group)}>
              {Object.entries(GROUP_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <span className="ml-2 text-muted">표시</span>
            <div className="inline-flex rounded-md border border-line p-0.5">
              {(
                [
                  ['qty', '수량'],
                  ['amount', '금액'],
                  ['both', '수량+금액'],
                  ['price', '단가'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`rounded px-2 py-0.5 text-[12px] ${value === k ? 'bg-amber-brand text-navy-950' : 'text-muted'}`} onClick={() => setValue(k)}>
                  {l}
                </button>
              ))}
            </div>
            {value === 'price' && <span className="text-[11.5px] text-muted">전월보다 오르면 빨강 ▲, 내리면 파랑 ▼</span>}
            <span className="ml-auto text-[11.5px] text-muted">행을 누르면 거래 명세가 나옵니다</span>
          </div>
          <div className="max-h-[calc(100vh-380px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>품명</th>
                  <th>규격</th>
                  <th>단위</th>
                  {months.map((m) => (
                    <th key={m} className="num">
                      {m.slice(2).replace('-', '.')}
                    </th>
                  ))}
                  <th className="num">합계</th>
                </tr>
              </thead>
              <tbody>
                {pivot.map((g) => (
                  <Fragment key={g.key}>
                    {group !== 'item' && (
                      <tr className="bg-navy-950/[0.04]">
                        <td colSpan={3} className="font-semibold text-navy-950">
                          {g.key} <span className="ml-1 text-[11px] font-normal text-muted">{g.items.length}품목</span>
                        </td>
                        {months.map((m) => (
                          <td key={m} className="num text-[11.5px] font-semibold">
                            {g.byM.get(m) ? won(g.byM.get(m)!) : ''}
                          </td>
                        ))}
                        <td className="num font-semibold">{won(g.amount)}</td>
                      </tr>
                    )}
                    {g.items.map((it) => (
                      <tr key={it.key} className="cursor-pointer" onClick={() => setDetail({ title: `${it.name} ${it.spec}${group === 'item' ? '' : ` · ${g.key}`}`, rows: it.rows })}>
                        <td className="pl-5">{it.name}</td>
                        <td className="whitespace-nowrap">{it.spec}</td>
                        <td className="text-muted">{it.unit}</td>
                        {months.map((m, mi) => {
                          const c = it.byM.get(m);
                          const prev = mi > 0 ? it.byM.get(months[mi - 1]) : undefined;
                          return (
                            <td key={m} className={`num whitespace-nowrap ${cellClass(c, prev)}`}>
                              {cell(c, prev)}
                            </td>
                          );
                        })}
                        <td className="num whitespace-nowrap font-semibold">{cell({ qty: it.qty, amount: it.amount })}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'summary' ? (
        <div className="grid gap-3 xl:grid-cols-2">
          <SumTable title="현장" list={summary.site} />
          <SumTable title="분류" list={summary.cat} />
          <SumTable title="업체" list={summary.vendor} />
          <div className="card overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 font-semibold">분류 × 현장 (기간 합계)</div>
            <div className="max-h-[420px] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>분류</th>
                    {summary.siteList.map((s) => (
                      <th key={s} className="num">
                        {s}
                      </th>
                    ))}
                    <th className="num">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.cross.map(([c, mm]) => (
                    <tr key={c}>
                      <td className="whitespace-nowrap">{c}</td>
                      {summary.siteList.map((s) => (
                        <td key={s} className="num">
                          {mm.get(s) ? won(mm.get(s)!) : ''}
                        </td>
                      ))}
                      <td className="num font-semibold">{won([...mm.values()].reduce((a, b) => a + b, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-line px-4 py-2 text-[12px] text-muted">
            {rows.length.toLocaleString()}줄{rows.length > 1500 ? ' · 화면에는 1,500줄까지 보입니다. 전체는 엑셀로 받으세요.' : ''}
          </div>
          <div className="max-h-[calc(100vh-380px)] overflow-auto">
            <LedgerTable rows={rows.slice(0, 1500)} />
          </div>
        </div>
      )}

      <Modal open={!!detail} title={detail?.title ?? ''} onClose={() => setDetail(null)} wide>
        {detail && (
          <>
            <div className="mb-2 text-[12px] text-muted">
              {detail.rows.length}건 · 수량 {fmtQty(detail.rows.reduce((a, r) => a + r.qty, 0))} · 금액 {won(detail.rows.reduce((a, r) => a + r.amount, 0))}원
            </div>
            <LedgerTable rows={[...detail.rows].sort((a, b) => (a.date ?? a.month).localeCompare(b.date ?? b.month))} />
          </>
        )}
      </Modal>
    </div>
  );
}

function LedgerTable({ rows }: { rows: Row[] }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>월</th>
          <th>입고일</th>
          <th>현장</th>
          <th>분류</th>
          <th>업체</th>
          <th>품명</th>
          <th>규격</th>
          <th className="num">수량</th>
          <th className="num">단가</th>
          <th className="num">금액</th>
          <th>공정</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap">{r.month}</td>
            <td className="whitespace-nowrap text-muted">{r.date}</td>
            <td className="whitespace-nowrap">{r.site}</td>
            <td className={`whitespace-nowrap ${r.cat === UNCAT ? 'text-amber-700' : ''}`}>{r.cat}</td>
            <td className="whitespace-nowrap">{r.vendor}</td>
            <td>{r.itemName}</td>
            <td className="whitespace-nowrap">{r.spec}</td>
            <td className="num">
              {fmtQty(r.qty)} {r.unit}
            </td>
            <td className="num">{r.qty ? won(r.amount / r.qty) : ''}</td>
            <td className="num">{won(r.amount)}</td>
            <td className="max-w-[220px] truncate text-muted" title={r.process}>
              {r.process}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
