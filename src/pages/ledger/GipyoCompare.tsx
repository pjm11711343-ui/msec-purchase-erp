import { Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { doc, onSnapshot } from 'firebase/firestore';
import { audit, commitBatch } from '../../lib/db';
import { C, db } from '../../lib/firebase';
import { useSites, useVendors } from '../../lib/hooks';
import { cmp, fmtA, fmtW, mLong } from '../../lib/ledgerData';
import { exportTablesXlsx } from '../../lib/ledgerExcel';
import { matchSite, matchVendor } from '../../lib/nameMatch';
import { Empty, errMsg, useToast } from '../../components/ui';
import type { Invoice } from '../../types';

/** 집계표 한 칸: 업체·현장·월 금액 (sub = '안전'이면 '본사 안전' 줄) */
export interface GItem {
  v: string;
  s: string;
  m: string;
  a: number;
  sub?: string;
  si?: number; // 시트 순서 (겹치면 뒤 시트 값)
}
export interface GipyoData {
  name: string;
  at: string;
  list: GItem[] | [string, string, string, number, string?, number?][];
  sheets?: string[];
  months: string[];
  vendors: number;
  vendorMap?: Record<string, string>; // 집계표 업체명 → ERP 업체 id
  siteMap?: Record<string, string>; // 집계표 현장명 → ERP 현장 id
}

const DOC = 'gipyo';
const pad = (n: number) => String(n).padStart(2, '0');
const clean = (v: unknown) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').replace(/[,\s원₩]/g, '');
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : 0;
};

/** '집계표(00~00년)' 시트: 업체명 블록 아래 현장별 행, 열은 2024년01월… */
export function parseGipyo(wb: XLSX.WorkBook): Omit<GipyoData, 'name' | 'at'> | null {
  const list: GItem[] = [];
  const seen: Record<string, number> = {};
  const sheets: string[] = [];
  const mset = new Set<string>();
  for (const sn of wb.SheetNames) {
    if (!sn.replace(/\s/g, '').includes('집계표')) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, raw: true, blankrows: true });
    let hr = -1;
    let mcol: Record<string, number> = {};
    let vc = -1;
    let sc = -1;
    for (let r = 0; r < Math.min(aoa.length, 20); r++) {
      const row = aoa[r] ?? [];
      const mm: Record<string, number> = {};
      let v = -1;
      let st = -1;
      row.forEach((c, i) => {
        if (typeof c !== 'string') return;
        const t = c.replace(/\s/g, '');
        if (t === '업체명') v = i;
        if (t === '현장명') st = i;
        const m = t.match(/^(\d{4})년(\d{1,2})월$/);
        if (m) mm[`${m[1]}-${pad(+m[2])}`] = i;
      });
      if (v >= 0 && st >= 0 && Object.keys(mm).length >= 6) {
        hr = r;
        mcol = mm;
        vc = v;
        sc = st;
        break;
      }
    }
    if (hr < 0) continue;
    sheets.push(sn);
    const si = sheets.length - 1;
    Object.keys(mcol).forEach((k) => mset.add(k));
    let cur = '';
    let sub = '';
    for (let r = hr + 1; r < aoa.length; r++) {
      const row = aoa[r] ?? [];
      const vv = typeof row[vc] === 'string' ? clean((row[vc] as string).replace(/[\r\n]+/g, ' ')) : '';
      if (vv) {
        cur = clean(vv.replace(/\s*본사\s*안전\s*$/, ''));
        sub = cur === vv ? '' : '안전';
        if (/^(자재비|본사안전|자재비\+본사안전|업체명)/.test(cur.replace(/\s/g, ''))) cur = '';
        continue;
      }
      if (!cur) continue;
      const ss = typeof row[sc] === 'string' ? clean((row[sc] as string).replace(/[\r\n]+/g, ' ')) : '';
      if (!ss) continue;
      const site = clean(ss.replace(/^\d+\s*[.)]\s*/, ''));
      if (!site) continue;
      for (const k in mcol) {
        const a = num(row[mcol[k]]);
        if (!a) continue;
        const key = `${cur}\u0001${site}\u0001${k}\u0001${sub}`;
        if (seen[key] != null) {
          list[seen[key]].a = a;
          list[seen[key]].si = si;
        } else {
          seen[key] = list.length;
          list.push({ v: cur, s: site, m: k, a, ...(sub ? { sub } : {}), si });
        }
      }
    }
  }
  if (!list.length) return null;
  return { list, sheets, months: [...mset].sort(), vendors: new Set(list.map((x) => x.v)).size };
}

const toItems = (list: GipyoData['list']): GItem[] => list.map((x) => (Array.isArray(x) ? { v: x[0], s: x[1], m: x[2], a: x[3], ...(x[4] ? { sub: x[4] } : {}), si: x[5] ?? 0 } : x));

export async function saveGipyo(g: GipyoData) {
  await commitBatch([{ type: 'set', col: C.ledgerMeta, id: DOC, data: { ...g, list: toItems(g.list) }, merge: false }]);
}

/** 업로드(ERP 계산서) 금액 ↔ 자재비 집계표 금액 */
export default function GipyoCompare({ invoices }: { invoices: Invoice[] }) {
  const toast = useToast();
  const sites = useSites();
  const vendors = useVendors();
  const [G, setG] = useState<GipyoData | null | undefined>(undefined);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);

  useEffect(
    () =>
      onSnapshot(
        doc(db, C.ledgerMeta, DOC),
        (d) => setG(d.exists() ? (d.data() as GipyoData) : null),
        () => setG(null),
      ),
    [],
  );

  const pick = () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = '.xlsx,.xlsm,.xls,.xlsb';
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f) return;
      setBusy(true);
      try {
        const g = parseGipyo(XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false }));
        if (!g) throw new Error("'집계표' 시트를 찾지 못했습니다 (업체명·현장명·0000년00월 열이 있어야 합니다)");
        await saveGipyo({ ...g, name: f.name, at: new Date().toISOString(), vendorMap: G?.vendorMap ?? {}, siteMap: G?.siteMap ?? {} });
        await audit('집계표 반영', f.name, { rows: g.list.length });
        toast(`집계표 반영 — 업체 ${g.vendors}곳 · ${g.list.length.toLocaleString()}건`);
      } catch (e) {
        toast(errMsg(e), 'err');
      } finally {
        setBusy(false);
      }
    };
    i.click();
  };

  const items = useMemo(() => (G ? toItems(G.list) : []), [G]);

  // 집계표 이름 → ERP (직접 맞춘 것 우선, 없으면 자동)
  const vOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of items)
      if (!m.has(x.v)) {
        const id = G?.vendorMap?.[x.v] ?? matchVendor(x.v, vendors.data)?.id ?? '';
        m.set(x.v, id);
      }
    return m;
  }, [items, G?.vendorMap, vendors.data]);
  const sOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of items) if (!m.has(x.s)) m.set(x.s, G?.siteMap?.[x.s] ?? matchSite(x.s, sites.data));
    return m;
  }, [items, G?.siteMap, sites.data]);

  const calc = useMemo(() => {
    if (!G) return null;
    const vName = (id: string) => vendors.data.find((v) => v.id === id)?.name ?? id;
    const sName = (id: string) => sites.data.find((s) => s.id === id)?.name ?? id;
    // 시트가 겹치면 뒤 시트 값 하나만
    const best = new Map<string, GItem & { V: string; S: string }>();
    for (const x of items) {
      const V = vOf.get(x.v) || `?${x.v}`;
      const S = sOf.get(x.s) || `?${x.s}`;
      const k = `${V}\u0001${S}\u0001${x.m}\u0001${x.sub ?? ''}`;
      const b = best.get(k);
      if (!b) best.set(k, { ...x, V, S });
      else if ((x.si ?? 0) > (b.si ?? 0)) {
        b.a = x.a;
        b.si = x.si;
      } else if ((x.si ?? 0) === (b.si ?? 0)) b.a += x.a;
    }
    const gvm = new Map<string, Map<string, number>>();
    const gv = new Map<string, number>();
    const gvv = new Set<string>();
    const skip = new Map<string, number>();
    for (const b of best.values()) {
      if (b.S.startsWith('?')) {
        skip.set(b.S.slice(1), (skip.get(b.S.slice(1)) ?? 0) + b.a);
        continue;
      }
      const k = `${b.V}\u0001${b.m}`;
      const o = gvm.get(k) ?? new Map<string, number>();
      o.set(b.S, (o.get(b.S) ?? 0) + b.a);
      gvm.set(k, o);
      gv.set(k, (gv.get(k) ?? 0) + b.a);
      gvv.add(b.V);
    }
    // ERP 계산서: 업체·월로 묶음
    const grp = new Map<string, { V: string; m: string; amt: number; files: Set<string>; sites: Map<string, number> }>();
    for (const inv of invoices) {
      if (inv.submitted && !inv.appliedToLedger) continue;
      const k = `${inv.vendorId}\u0001${inv.month}`;
      const o = grp.get(k) ?? { V: inv.vendorId, m: inv.month, amt: 0, files: new Set(), sites: new Map() };
      o.amt += inv.totalAmount;
      o.files.add(inv.fileName);
      o.sites.set(inv.siteId, (o.sites.get(inv.siteId) ?? 0) + inv.totalAmount);
      grp.set(k, o);
    }
    const mmin = G.months[0];
    const mmax = G.months[G.months.length - 1];
    const rows = [...grp.values()]
      .map((o) => {
        let g = gv.get(`${o.V}\u0001${o.m}`);
        if (g == null && gvv.has(o.V) && o.m >= mmin && o.m <= mmax) g = 0; // 집계표에 있는 업체 = 그 달 0원
        const gsm = gvm.get(`${o.V}\u0001${o.m}`) ?? new Map<string, number>();
        const sk = [...new Set([...o.sites.keys(), ...gsm.keys()])];
        const ss = sk
          .map((s) => ({ site: sName(s), a: Math.round(o.sites.get(s) ?? 0), g: Math.round(gsm.get(s) ?? 0) }))
          .map((x) => ({ ...x, d: x.a - x.g }))
          .sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || cmp(x.site, y.site));
        return { key: `${o.V}|${o.m}`, vendor: vName(o.V), m: o.m, amt: Math.round(o.amt), files: [...o.files], g: g == null ? null : Math.round(g), d: g == null ? null : Math.round(o.amt - g), sites: ss, sdiff: ss.filter((x) => x.d).length };
      })
      .sort((a, b) => cmp(b.m, a.m) || cmp(a.vendor, b.vendor));
    // 집계표에는 있는데 ERP에 없는 업체·월 (계산서가 있는 달만)
    const have = new Set([...grp.keys()]);
    const ms = new Set(invoices.map((i) => i.month));
    const miss = new Map<string, [string, number][]>();
    for (const [k, a] of gv) {
      const [V, m] = k.split('\u0001');
      if (!ms.has(m) || have.has(k) || !a) continue;
      miss.set(m, [...(miss.get(m) ?? []), [V.startsWith('?') ? V.slice(1) : vName(V), Math.round(a)]]);
    }
    for (const L of miss.values()) L.sort((a, b) => b[1] - a[1]);
    return { rows, miss, skip: [...skip].sort((a, b) => b[1] - a[1]) };
  }, [G, items, vOf, sOf, invoices, vendors.data, sites.data]);

  const unV = [...vOf].filter(([, id]) => !id).map(([n]) => n);
  const unS = [...sOf].filter(([, id]) => !id).map(([n]) => n);
  const setMap = async (kind: 'vendorMap' | 'siteMap', k: string, v: string) => {
    if (!G) return;
    try {
      await commitBatch([{ type: 'set', col: C.ledgerMeta, id: DOC, data: { [kind]: { ...(G[kind] ?? {}), [k]: v } } }]);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const badge = (d: number | null, sd: number) =>
    d === null ? (
      <span className="chip bg-line text-muted">집계표 없음</span>
    ) : d === 0 ? (
      sd ? (
        <span className="chip bg-amber-soft text-amber-800">합계 일치 · 현장 {sd}곳 다름</span>
      ) : (
        <span className="chip bg-emerald-50 text-emerald-700">일치</span>
      )
    ) : (
      <span className="chip bg-red-50 text-red-600">
        차이 {fmtA(Math.abs(d))} {d > 0 ? '많음' : '적음'}
      </span>
    );

  if (G === undefined) return <Empty>불러오는 중…</Empty>;
  const head = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      <span className="font-semibold">🧾 자재비 집계표 대조</span>
      <span className="text-[12px] text-muted">{G ? `${G.name} · ${new Date(G.at).toLocaleString('ko-KR')} · 업체 ${G.vendors}곳 · ${mLong(G.months[0])}~${mLong(G.months[G.months.length - 1])}` : "구매결의서 엑셀의 '집계표' 시트와 ERP 계산서 금액을 맞춰봅니다"}</span>
      <span className="flex-1" />
      {G ? (
        <>
          <button className="btn-ghost h-7 text-[12px]" onClick={() => setShowMap((x) => !x)}>
            이름 맞추기{unV.length + unS.length ? ` (${unV.length + unS.length})` : ''}
          </button>
          <button
            className="btn-dark h-7 text-[12px]"
            disabled={!calc}
            onClick={() =>
              calc &&
              exportTablesXlsx(
                [
                  {
                    name: '집계표 대조',
                    title: '자재비 집계표 대조',
                    sub: G.name,
                    aoa: [['반영 월', '업체', '현장', 'ERP 계산서 금액', '집계표 금액', '차이', '파일'], ...calc.rows.flatMap((r) => [[mLong(r.m), r.vendor, '(업체 합계)', r.amt, r.g ?? '', r.d ?? '', r.files.join(', ')], ...r.sites.map((x) => [mLong(r.m), r.vendor, x.site, x.a, x.g, x.d, ''])])],
                  },
                  { name: '미반영 업체', title: '집계표에만 있는 업체·월', aoa: [['반영 월', '업체', '집계표 금액'], ...[...calc.miss.keys()].sort().reverse().flatMap((m) => calc.miss.get(m)!.map(([v, a]) => [mLong(m), v, a]))] },
                ],
                '집계표_대조.xlsx',
              )
            }
          >
            대조표 엑셀
          </button>
          <button className="btn-ghost h-7 text-[12px]" disabled={busy} onClick={pick}>
            집계표 다시 읽기
          </button>
          <button
            className="btn-ghost h-7 text-[12px]"
            onClick={async () => {
              if (!confirm('저장된 집계표 금액을 지울까요? (계산서는 그대로입니다)')) return;
              await commitBatch([{ type: 'delete', col: C.ledgerMeta, id: DOC }]);
            }}
          >
            지우기
          </button>
        </>
      ) : (
        <button className="btn-primary h-7 text-[12px]" disabled={busy} onClick={pick}>
          {busy ? '읽는 중…' : '집계표 파일 선택'}
        </button>
      )}
    </div>
  );
  if (!G || !calc)
    return (
      <div className="card overflow-hidden">
        {head}
        <div className="px-4 py-4 text-[12.5px] leading-7 text-[#46526a]">
          · <b>자재비 집계표·구매결의서</b> 엑셀을 고르면 '집계표' 시트를 읽어 <b>업체·현장·월별 금액</b>만 저장합니다. (회사 공용)
          <br />· ERP에 올린 계산서 금액과 비교해서 <b>다른 곳만</b> 바로 찾을 수 있습니다. 이름이 달라도 업체·현장의 '다른 표기'로 맞춰 비교합니다.
        </div>
      </div>
    );

  const st = calc.rows.filter((r) => r.d === 0).length;
  const ng = calc.rows.filter((r) => r.d).length;
  const un = calc.rows.filter((r) => r.g == null).length;
  return (
    <div className="card overflow-hidden">
      {head}
      {showMap && (
        <div className="grid gap-3 border-b border-line bg-[#fafbfc] p-3 xl:grid-cols-2">
          {(
            [
              ['vendorMap', '업체', [...vOf], vendors.data.map((v) => ({ id: v.id, label: v.name }))],
              ['siteMap', '현장', [...sOf], sites.data.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))],
            ] as const
          ).map(([kind, label, list, opts]) => (
            <div key={kind} className="rounded-xl border border-line bg-white">
              <div className="border-b border-line px-3 py-2 text-[12.5px] font-semibold">
                집계표 {label}명 → ERP {label} <span className="font-normal text-muted">(못 찾은 곳이 위에)</span>
              </div>
              <div className="max-h-[300px] overflow-auto">
                <table className="tbl">
                  <tbody>
                    {[...list]
                      .sort((a, b) => Number(!!a[1]) - Number(!!b[1]) || cmp(a[0], b[0]))
                      .map(([n, id]) => (
                        <tr key={n}>
                          <td className="font-medium">{n}</td>
                          <td>
                            <select className={`input h-7 w-52 ${id ? '' : 'border-amber-brand bg-amber-soft'}`} value={id} onChange={(e) => setMap(kind, n, e.target.value)}>
                              <option value="">{label === '현장' ? '비교에서 뺌' : '못 찾음'}</option>
                              {opts.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="px-4 pt-2 text-[12.5px] text-[#46526a]">
        ERP 계산서를 <b>업체·월</b>로 묶어 집계표 금액과 비교합니다. 집계표의 <b>본사 안전</b> 줄은 같은 업체 금액에 합쳐서 맞춰봅니다. {st}건 일치
        {ng > 0 && <b className="text-red-600"> · {ng}건 차이</b>}
        {un > 0 && ` · ${un}건 집계표에 없음`}
        {calc.skip.length > 0 && <div className="mt-1 text-muted">ERP 현장에 없는 집계표 현장은 빼고 비교합니다 — {calc.skip.map(([s, a]) => `${s} ${fmtW(a)}`).join(', ')}</div>}
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>반영 월</th>
              <th>업체 (파일)</th>
              <th className="num">ERP 계산서 금액</th>
              <th className="num">집계표 금액</th>
              <th className="num">결과</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {calc.rows.map((r) => {
              const op = open.has(r.key);
              const L = op ? r.sites : r.sites.filter((x) => x.d);
              return (
                <Fragment key={r.key}>
                  <tr className={r.d ? 'bg-amber-soft/40' : ''}>
                    <td className="whitespace-nowrap">{mLong(r.m)}</td>
                    <td>
                      <b>{r.vendor}</b>
                      <div className="max-w-[360px] truncate text-[11px] text-muted">{r.files.join(', ')}</div>
                    </td>
                    <td className="num">{fmtA(r.amt)}</td>
                    <td className="num">{r.g == null ? '-' : fmtA(r.g)}</td>
                    <td className="num">{badge(r.d, r.sdiff)}</td>
                    <td>
                      <button
                        className="btn-ghost h-6 text-[11.5px]"
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (n.has(r.key)) n.delete(r.key);
                            else n.add(r.key);
                            return n;
                          })
                        }
                      >
                        현장별 {op ? '접기' : '보기'}
                        {r.sdiff ? <span className="text-red-600"> ({r.sdiff})</span> : null}
                      </button>
                    </td>
                  </tr>
                  {(op || r.sdiff > 0) && L.length > 0 && (
                    <tr>
                      <td colSpan={6} className="bg-[#fafbfe] p-0">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th className="w-[240px]">현장{op ? '' : ' (차이 나는 곳만)'}</th>
                              <th className="num">ERP 계산서</th>
                              <th className="num">집계표</th>
                              <th className="num">차이</th>
                            </tr>
                          </thead>
                          <tbody>
                            {L.map((x) => (
                              <tr key={x.site} className={x.d ? 'bg-amber-soft/40' : ''}>
                                <td>{x.site}</td>
                                <td className="num">{fmtA(x.a)}</td>
                                <td className="num">{fmtA(x.g)}</td>
                                <td className={`num ${x.d ? 'font-semibold text-red-600' : 'text-muted'}`}>{x.d ? fmtA(x.d) : '0'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!calc.rows.length && <Empty>ERP 계산서가 없습니다.</Empty>}
      </div>
      {calc.miss.size > 0 && (
        <div className="border-t border-line px-4 py-3 text-[12.5px]">
          <b>집계표에는 있는데 ERP에 계산서가 없는 업체</b> <span className="text-muted">(계산서가 있는 달만)</span>
          {[...calc.miss.keys()]
            .sort()
            .reverse()
            .map((m) => (
              <div key={m} className="mt-1.5">
                <b>{mLong(m)}</b>{' '}
                <span className="text-muted">
                  {calc.miss.get(m)!.length}곳 · {fmtA(calc.miss.get(m)!.reduce((s, x) => s + x[1], 0))}원
                </span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {calc.miss.get(m)!.map(([v, a]) => (
                    <span key={v} className="chip bg-canvas text-muted">
                      {v} {fmtW(a)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
