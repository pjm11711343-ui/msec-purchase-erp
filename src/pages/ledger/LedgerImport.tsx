import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories, useVendors } from '../../lib/hooks';
import { resolveCat } from '../../lib/catMatch';
import { cmp, fmtA, mLong, saveItemAlias, useItemAlias } from '../../lib/ledgerData';
import { matchSite, matchVendor } from '../../lib/nameMatch';
import { toDateStr } from '../../lib/normalize';
import { Empty, errMsg, useToast } from '../../components/ui';
import { saveGipyo, type GipyoData } from './GipyoCompare';
import type { Invoice, InvoiceLine, SiteCategory } from '../../types';

/** 예전 '계산서 월별 품목 관리' 백업(.json)의 한 줄 */
interface OldRow {
  fid: string;
  m: string;
  site: string;
  cat: string;
  vendor: string;
  date?: string;
  item: string;
  spec: string;
  unit: string;
  qty: number;
  price: number;
  amt: number;
  note?: string;
  proc?: string;
  z?: number; // 0원 시트 표시용 빈 줄
}
interface OldBackup {
  files: { id: string; name: string; month: string }[];
  rows: OldRow[];
  alias?: Record<string, string>;
  gipyo?: GipyoData | null;
}

const NEW = '__new__';

/** 예전 프로그램 백업 → ERP 계산서(기록용)로 옮기기 */
export default function LedgerImport({ invoices }: { invoices: Invoice[] }) {
  const { profile } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const sites = useSites();
  const vendors = useVendors();
  const cats = useSiteCategories();
  const std = useStandardCategories();
  const alias = useItemAlias();
  const [data, setData] = useState<{ name: string; d: OldBackup } | null>(null);
  const [siteMap, setSiteMap] = useState<Record<string, string>>({});
  const [vendorMap, setVendorMap] = useState<Record<string, string>>({});
  const [withAlias, setWithAlias] = useState(true);
  const [withGipyo, setWithGipyo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const rows = useMemo(() => (data?.d.rows ?? []).filter((r) => !r.z && r.item), [data]);
  const stat = (k: 'site' | 'vendor') => {
    const m = new Map<string, { n: number; a: number }>();
    for (const r of rows) {
      const o = m.get(r[k]) ?? { n: 0, a: 0 };
      o.n++;
      o.a += r.amt;
      m.set(r[k], o);
    }
    return [...m].sort((a, b) => cmp(a[0], b[0]));
  };
  const siteStat = useMemo(() => stat('site'), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const vendorStat = useMemo(() => stat('vendor'), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const months = useMemo(() => [...new Set(rows.map((r) => r.m))].sort(), [rows]);

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const d = JSON.parse(await file.text()) as OldBackup;
      if (!Array.isArray(d.files) || !Array.isArray(d.rows)) throw new Error('예전 프로그램 백업 파일(.json) 형식이 아닙니다.');
      const sm: Record<string, string> = {};
      const vm: Record<string, string> = {};
      for (const r of d.rows) {
        if (!(r.site in sm)) sm[r.site] = matchSite(r.site, sites.data);
        if (!(r.vendor in vm)) vm[r.vendor] = r.vendor && r.vendor !== '미지정' ? (matchVendor(r.vendor, vendors.data)?.id ?? NEW) : '';
      }
      setSiteMap(sm);
      setVendorMap(vm);
      setData({ name: file.name, d });
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  // ERP에 이미 있는 계산서(엑셀·포털)와 겹치는 월·업체·현장은 건너뜀
  const existing = useMemo(() => {
    const m = new Map<string, Invoice>();
    for (const i of invoices) m.set(`${i.month}_${i.vendorId}_${i.siteId}`, i);
    return m;
  }, [invoices]);

  const plan = useMemo(() => {
    const groups = new Map<string, { month: string; vendorKey: string; siteId: string; rows: OldRow[] }>();
    let skipSite = 0;
    let skipVendor = 0;
    for (const r of rows) {
      const siteId = siteMap[r.site];
      if (!siteId) {
        skipSite++;
        continue;
      }
      const vk = vendorMap[r.vendor];
      if (!vk) {
        skipVendor++;
        continue;
      }
      const vendorKey = vk === NEW ? `${NEW}:${r.vendor}` : vk;
      const k = `${r.m}|${vendorKey}|${siteId}`;
      const g = groups.get(k) ?? { month: r.m, vendorKey, siteId, rows: [] };
      g.rows.push(r);
      groups.set(k, g);
    }
    const list = [...groups.values()];
    const clash = list.filter((g) => !g.vendorKey.startsWith(NEW) && existing.get(`${g.month}_${g.vendorKey}_${g.siteId}`)?.source !== undefined && existing.get(`${g.month}_${g.vendorKey}_${g.siteId}`)!.source !== 'import');
    return { list, clash, skipSite, skipVendor };
  }, [rows, siteMap, vendorMap, existing]);

  const run = async () => {
    if (!data) return;
    const go = plan.list.filter((g) => !plan.clash.includes(g));
    if (!confirm(`계산서 ${go.length}건 (${go.reduce((a, g) => a + g.rows.length, 0).toLocaleString()}줄)을 기록용으로 옮길까요?\n\nERP에 이미 올린 계산서와 겹치는 ${plan.clash.length}건은 건너뜁니다. 같은 백업을 다시 옮기면 이전에 옮긴 자료를 덮어씁니다.`)) return;
    setBusy(true);
    try {
      type Op = Parameters<typeof commitBatch>[0][number];
      const ops: Op[] = [];
      // 새 업체 등록
      const newVendor = new Map<string, { id: string; name: string }>();
      for (const g of go)
        if (g.vendorKey.startsWith(NEW)) {
          const name = g.vendorKey.slice(NEW.length + 1);
          if (!newVendor.has(name)) {
            const id = newId(C.vendors);
            newVendor.set(name, { id, name });
            ops.push({ type: 'set', col: C.vendors, id, data: { name, aliases: [], active: true } });
          }
        }
      const catsOf = (siteId: string): SiteCategory[] => cats.data.filter((c) => c.siteId === siteId);
      const now = Date.now();
      for (const g of go) {
        const v = g.vendorKey.startsWith(NEW) ? newVendor.get(g.vendorKey.slice(NEW.length + 1))! : { id: g.vendorKey, name: vendors.data.find((x) => x.id === g.vendorKey)?.name ?? '' };
        const year = Number(g.month.slice(0, 4));
        const lines: InvoiceLine[] = g.rows.map((r) => {
          const cid = resolveCat(r.cat, catsOf(g.siteId), std.data);
          const l: InvoiceLine = {
            receivedDate: toDateStr(r.date, year),
            itemName: r.item,
            spec: r.spec ?? '',
            unit: r.unit ?? '',
            qty: r.qty,
            unitPrice: r.price,
            amount: r.amt,
            finalAmount: r.amt,
            categoryText: r.cat,
            process: r.proc || undefined,
            note: r.note || undefined,
            siteCategoryId: cid || undefined,
            matchStatus: 'migrated',
          };
          return l;
        });
        const id = `${g.month}_${v.id}_${g.siteId}`;
        const inv: Omit<Invoice, 'id'> = {
          month: g.month,
          vendorId: v.id,
          vendorName: v.name,
          siteId: g.siteId,
          sheetName: '예전 프로그램',
          source: 'import',
          fileName: data.name,
          totalAmount: lines.reduce((a, l) => a + l.finalAmount, 0),
          lineCount: lines.length,
          appliedToLedger: false, // 기록용 (투입집계에는 더하지 않음)
          lines,
          uploadedBy: profile?.name ?? '',
          uploadedAt: now,
        };
        ops.push({ type: 'set', col: C.invoices, id, data: inv, merge: false });
      }
      // 계산서 문서가 커서 한 번에 40건씩 나눠 저장
      for (let i = 0; i < ops.length; i += 40) {
        await commitBatch(ops.slice(i, i + 40));
        setProgress(`${Math.min(i + 40, ops.length)}/${ops.length}`);
      }
      if (withAlias && data.d.alias && Object.keys(data.d.alias).length) await saveItemAlias({ ...data.d.alias, ...alias });
      if (withGipyo && data.d.gipyo?.list?.length) await saveGipyo(data.d.gipyo);
      await audit('예전 품목관리 자료 가져오기', data.name, { invoices: go.length, rows: go.reduce((a, g) => a + g.rows.length, 0) });
      toast(`계산서 ${go.length}건을 옮겼습니다.`);
      setData(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  if (!data)
    return (
      <div className="card p-6">
        <h2 className="text-[15px] font-semibold">예전 '계산서 월별 품목 관리' 자료 가져오기</h2>
        <ol className="mt-2 list-decimal pl-5 leading-7 text-[13px] text-ink">
          <li>
            예전 프로그램에서 <b>백업·복원 → 백업 파일 받기</b>로 .json 파일을 받습니다. (공유 폴더의 <b>계산서_월별품목관리_데이터.json</b>도 됩니다)
          </li>
          <li>아래에서 그 파일을 고르면 현장·업체를 ERP 현장·업체에 자동으로 맞춥니다. 틀린 곳만 고치세요.</li>
          <li>
            [옮기기]를 누르면 <b>기록용 계산서</b>로 들어갑니다. 월별 품목·집계표 대조에는 보이고, 투입집계 금액에는 더하지 않습니다.
          </li>
          <li>ERP에 이미 올린 계산서(같은 월·업체·현장)는 건너뜁니다.</li>
        </ol>
        <label className="btn-primary mt-4 cursor-pointer">
          백업 파일(.json) 선택
          <input type="file" accept=".json,application/json" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ''))} />
        </label>
        <p className="mt-3 text-[12px] text-muted">기준월({settings.cutoffMonth}) 이후 자료도 기록용으로만 들어갑니다. 투입집계에 넣을 달은 계산서 메뉴에서 원본 파일을 올려 주세요.</p>
      </div>
    );

  const total = rows.reduce((a, r) => a + r.amt, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="card flex flex-wrap items-center gap-3 px-4 py-3">
        <b>{data.name}</b>
        <span className="text-muted">
          {months.length}개월 ({mLong(months[0])} ~ {mLong(months[months.length - 1])}) · 파일 {data.d.files.length}개 · {rows.length.toLocaleString()}줄 · {fmtA(total)}원
        </span>
        <span className="flex-1" />
        {data.d.alias && Object.keys(data.d.alias).length > 0 && (
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={withAlias} onChange={(e) => setWithAlias(e.target.checked)} /> 직접 합친 품목 {Object.keys(data.d.alias).length}개도 옮기기
          </label>
        )}
        {data.d.gipyo?.list?.length ? (
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={withGipyo} onChange={(e) => setWithGipyo(e.target.checked)} /> 집계표 금액도 옮기기
          </label>
        ) : null}
        <button className="btn-ghost" onClick={() => setData(null)}>
          취소
        </button>
        <button className="btn-primary" disabled={busy || !plan.list.length} onClick={run}>
          {busy ? `옮기는 중… ${progress}` : '옮기기'}
        </button>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <MapCard title="현장 맞추기" stat={siteStat} value={siteMap} set={(k, v) => setSiteMap({ ...siteMap, [k]: v })} options={sites.data.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} />
        <MapCard
          title="업체 맞추기"
          stat={vendorStat}
          value={vendorMap}
          set={(k, v) => setVendorMap({ ...vendorMap, [k]: v })}
          options={[{ id: NEW, label: '+ 새 업체로 등록' }, ...vendors.data.map((v) => ({ id: v.id, label: v.name }))]}
        />
      </div>
      <div className="card px-4 py-3 text-[12.5px]">
        옮길 계산서 <b>{(plan.list.length - plan.clash.length).toLocaleString()}</b>건
        {plan.clash.length > 0 && (
          <span className="ml-2 text-amber-700">
            · ERP에 이미 있는 {plan.clash.length}건 건너뜀 ({[...new Set(plan.clash.map((g) => mLong(g.month)))].join(', ')})
          </span>
        )}
        {(plan.skipSite > 0 || plan.skipVendor > 0) && (
          <span className="ml-2 text-muted">
            · 현장 안 고른 줄 {plan.skipSite.toLocaleString()} · 업체 안 고른 줄 {plan.skipVendor.toLocaleString()} (가져오지 않음)
          </span>
        )}
      </div>
    </div>
  );
}

function MapCard({ title, stat, value, set, options }: { title: string; stat: [string, { n: number; a: number }][]; value: Record<string, string>; set: (k: string, v: string) => void; options: { id: string; label: string }[] }) {
  const missing = stat.filter(([k]) => !value[k]).length;
  return (
    <div className="card flex max-h-[520px] flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-semibold">{title}</span>
        <span className="text-[12px] text-muted">{stat.length}개</span>
        {missing > 0 && <span className="chip bg-amber-soft text-amber-800">안 고른 곳 {missing}</span>}
      </div>
      {!stat.length ? (
        <Empty>없음</Empty>
      ) : (
        <div className="overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>예전 표기</th>
                <th className="num">줄</th>
                <th className="num">금액</th>
                <th>ERP</th>
              </tr>
            </thead>
            <tbody>
              {stat.map(([k, o]) => (
                <tr key={k}>
                  <td className="font-medium">{k || '(빈칸)'}</td>
                  <td className="num">{o.n.toLocaleString()}</td>
                  <td className="num">{fmtA(o.a)}</td>
                  <td>
                    <select className={`input h-7 w-52 ${value[k] ? '' : 'border-amber-brand bg-amber-soft'}`} value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
                      <option value="">가져오지 않음</option>
                      {options.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
