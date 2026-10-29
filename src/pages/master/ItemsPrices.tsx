// 기준정보 › 품목·단가
//  - 품목 목록: 계산서(월별 품목명세) 품목 + 직접 등록 품목. 청구서 품명·규격 목록의 기준
//  - 단가표: 품목 × 업체 (현장 예외 단가), 바뀔 때마다 이력 보관, 엑셀 올리기·내려받기
//  - 등록 요청: 현장에서 요청한 새 품목 승인·거절
import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories, useVendors } from '../../lib/hooks';
import { rebuildCatalog, useItemCatalog } from '../../lib/itemCatalog';
import { stdOfText } from '../../lib/catMatch';
import type { StandardCategory } from '../../types';
import { buyPrice, itemCatId, itemKey, makeItemStd, priceValid, useItemCats, useItemEntries, usePriceList, type CatFrom, type ItemEntry, type PriceEntry } from '../../lib/itemMaster';
import { matchVendor } from '../../lib/nameMatch';
import { nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { loadPrices, type PriceRow } from '../../lib/prices';
import PickInput from '../../components/PickInput';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';

type Tab = 'items' | 'prices' | 'requests';

interface Row {
  key: string;
  itemName: string;
  spec: string;
  unit: string;
  source: '계산서' | '직접 등록';
  entry?: ItemEntry; // 직접 등록 또는 숨김 표시
  hidden: boolean;
  lastPrice?: number;
  lastMonth?: string;
  lastVendor?: string;
  stdCatId: string; // 표준 자재분류
  catFrom: CatFrom; // 지정 · 등록 · 계산서(자동)
}

const stdOfRow = (x: { stdCatId: string; from: CatFrom }) => ({ stdCatId: x.stdCatId, catFrom: x.from });

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export default function ItemsPrices() {
  const { profile, can } = useAuth();
  const office = can('admin', 'material');
  const toast = useToast();
  const catalog = useItemCatalog();
  const entries = useItemEntries();
  const prices = usePriceList();
  const vendors = useVendors();
  const sites = useSites();
  const std = useStandardCategories();
  const siteCats = useSiteCategories();
  const itemCats = useItemCats();
  const [tab, setTab] = useState<Tab>('items');
  const [compare, setCompare] = useState<{ item: string; spec: string } | null>(null);
  const who = profile?.name ?? '';

  // 품목 목록 = 계산서 품목 + 직접 등록 (같은 품목은 한 줄)
  const rows = useMemo(() => {
    const stdOf = makeItemStd({ itemCats: itemCats.data, entries: entries.data, catalog: catalog.items, siteCats: siteCats.data, std: std.data });
    const m = new Map<string, Row>();
    const hiddenKeys = new Set(entries.data.filter((e) => e.status === 'hidden').map((e) => itemKey(e.itemName, e.spec)));
    for (const c of catalog.items) {
      const k = itemKey(c.i, c.s);
      if (m.has(k)) continue;
      m.set(k, { key: k, itemName: c.i, spec: c.s, unit: c.u, source: '계산서', hidden: hiddenKeys.has(k), lastPrice: c.last.p, lastMonth: c.last.m, lastVendor: c.last.v, entry: entries.data.find((e) => e.status === 'hidden' && itemKey(e.itemName, e.spec) === k), ...stdOfRow(stdOf(c.i, c.s)) });
    }
    for (const e of entries.data) {
      if (e.status !== 'active') continue;
      const k = itemKey(e.itemName, e.spec);
      if (m.has(k)) continue;
      m.set(k, { key: k, itemName: e.itemName, spec: e.spec, unit: e.unit, source: '직접 등록', entry: e, hidden: false, ...stdOfRow(stdOf(e.itemName, e.spec)) });
    }
    return [...m.values()].sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko') || a.spec.localeCompare(b.spec, 'ko'));
  }, [catalog.items, entries.data, itemCats.data, siteCats.data, std.data]);
  const requests = entries.data.filter((e) => e.status === 'requested');

  return (
    <div>
      <PageHeader
        title="품목·단가"
        desc="청구서 품명·규격은 이 품목 목록(계산서 품목 + 직접 등록)에서 고릅니다. 단가표는 업체별 단가(현장 예외 가능)이고, 청구서 단가 자동 채우기에 씁니다 (최신 계산서 → 이 단가표 → 단가관리 단가표 → 직전 발주)."
      />
      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
        {(
          [
            ['items', `품목 목록 ${rows.filter((r) => !r.hidden).length.toLocaleString()}`],
            ['prices', `단가표 ${prices.data.length.toLocaleString()}`],
            ['requests', `등록 요청${requests.length ? ` ${requests.length}` : ''}`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${tab === k ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas hover:text-ink'} ${k === 'requests' && requests.length && tab !== k ? 'text-amber-700' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'items' && <ItemsTab rows={rows} office={office} who={who} std={std.data} catalogAt={catalog.at} onCompare={setCompare} toast={toast} />}
      {tab === 'prices' && <PricesTab list={prices.data} rows={rows} vendors={vendors.data} sites={sites.data} office={office} who={who} onCompare={setCompare} toast={toast} />}
      {tab === 'requests' && <RequestsTab requests={requests} rows={rows} office={office} who={who} toast={toast} />}
      {compare && <PriceCompare item={compare.item} spec={compare.spec} list={prices.data} catalog={catalog.items} sites={sites.data} onClose={() => setCompare(null)} />}
    </div>
  );
}

type Toast = ReturnType<typeof useToast>;

/* ───────── 품목 목록 ───────── */
function ItemsTab({ rows, office, who, std, catalogAt, onCompare, toast }: { rows: Row[]; office: boolean; who: string; std: StandardCategory[]; catalogAt: number; onCompare: (x: { item: string; spec: string }) => void; toast: Toast }) {
  const [q, setQ] = useState('');
  const [src, setSrc] = useState<'' | '계산서' | '직접 등록' | '숨김'>('');
  const [catF, setCatF] = useState(''); // '' 전체 · '-' 미분류 · 표준분류 id
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkCat, setBulkCat] = useState('');
  const [catBusy, setCatBusy] = useState(false);
  const [form, setForm] = useState<{ id?: string; itemName: string; spec: string; unit: string; stdCatId: string; note: string } | null>(null);
  const shown = useMemo(() => {
    const k = nameKey(q);
    return rows
      .filter((r) => (src === '숨김' ? r.hidden : src ? r.source === src && !r.hidden : true))
      .filter((r) => (catF === '-' ? !r.stdCatId : catF ? r.stdCatId === catF : true))
      .filter((r) => !k || nameKey(`${r.itemName} ${r.spec}`).includes(k));
  }, [rows, q, src, catF]);
  const noCat = rows.filter((r) => !r.hidden && !r.stdCatId).length;
  const trades = [...new Set(std.map((s) => s.trade || '기타'))];
  const stdOptions = (
    <>
      {trades.map((t) => (
        <optgroup key={t} label={t}>
          {std
            .filter((s) => (s.trade || '기타') === t)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
  /** 자재분류 지정 ('' = 지정 해제 → 계산서 자동 분류로) */
  const setCats = async (targets: Row[], stdCatId: string) => {
    if (!targets.length) return;
    try {
      await commitBatch(
        targets.map((r) =>
          stdCatId
            ? { type: 'set' as const, col: C.itemCats, id: itemCatId(r.itemName, r.spec), data: { itemName: r.itemName, spec: r.spec, stdCatId, byName: who, at: Date.now() }, merge: false }
            : { type: 'delete' as const, col: C.itemCats, id: itemCatId(r.itemName, r.spec) },
        ),
      );
      if (targets.length > 1) {
        await audit('품목 자재분류 지정', stdName(stdCatId) || '지정 해제', { n: targets.length });
        toast(`${targets.length}건의 자재분류를 ${stdCatId ? `"${stdName(stdCatId)}"(으)로 정했습니다` : '자동(계산서)으로 되돌렸습니다'}.`);
        setSel(new Set());
      }
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const reloadCats = async () => {
    if (!confirm('계산서 전체를 다시 읽어 품목별 분류(자동)를 새로 계산할까요? 계산서가 많으면 1~2분 걸릴 수 있습니다.')) return;
    setCatBusy(true);
    try {
      const n = await rebuildCatalog();
      toast(`계산서 품목 ${n.toLocaleString()}건을 다시 읽었습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setCatBusy(false);
    }
  };
  const stdName = (id?: string) => std.find((s) => s.id === id)?.name ?? '';

  const save = async () => {
    if (!form) return;
    if (!form.itemName.trim()) return toast('품명을 입력하세요.', 'err');
    const k = itemKey(form.itemName, form.spec);
    const dup = rows.find((r) => r.key === k && r.entry?.id !== form.id);
    if (dup) return toast(`이미 있는 품목입니다: ${dup.itemName} ${dup.spec} (${dup.source})`, 'err');
    const now = Date.now();
    const data: Partial<ItemEntry> = { itemName: form.itemName.trim(), spec: form.spec.trim(), unit: form.unit.trim(), ...(form.stdCatId ? { stdCatId: form.stdCatId } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}), status: 'active', updatedAt: now, ...(form.id ? {} : { createdAt: now, requestedByName: who }) };
    try {
      await commitBatch([
        { type: 'set', col: C.items, id: form.id ?? newId(C.items), data, merge: !!form.id },
        form.stdCatId
          ? { type: 'set', col: C.itemCats, id: itemCatId(data.itemName!, data.spec!), data: { itemName: data.itemName, spec: data.spec, stdCatId: form.stdCatId, byName: who, at: now }, merge: false }
          : { type: 'delete', col: C.itemCats, id: itemCatId(data.itemName!, data.spec!) },
      ]);
      await audit(form.id ? '품목 수정' : '품목 등록', `${data.itemName} ${data.spec}`);
      toast(form.id ? '수정했습니다.' : '품목을 등록했습니다. 청구서 품명 목록에 바로 나옵니다.');
      setForm(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const toggleHide = async (r: Row) => {
    try {
      if (r.hidden && r.entry) await commitBatch([{ type: 'delete', col: C.items, id: r.entry.id }]);
      else await commitBatch([{ type: 'set', col: C.items, id: newId(C.items), data: { itemName: r.itemName, spec: r.spec, unit: r.unit, status: 'hidden', createdAt: Date.now(), requestedByName: who } }]);
      toast(r.hidden ? '청구서 목록에 다시 보입니다.' : '청구서 품명 목록에서 숨겼습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const remove = async (e: ItemEntry) => {
    if (!confirm(`${e.itemName} ${e.spec} 품목을 지울까요? (이미 쓴 청구서에는 영향 없음)`)) return;
    try {
      await commitBatch([{ type: 'delete', col: C.items, id: e.id }]);
      toast('지웠습니다.');
    } catch (err) {
      toast(errMsg(err), 'err');
    }
  };
  /** 엑셀로 여러 품목 등록: 품명·규격·단위 열을 찾아 읽는다 */
  const importExcel = async (file?: File) => {
    if (!file) return;
    try {
      const wb = readWorkbook(await file.arrayBuffer());
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const hi = aoa.findIndex((r) => r.some((c) => /품\s*명|품목/.test(String(c))));
      if (hi < 0) return toast('첫 시트에서 "품명" 머리글을 찾지 못했습니다.', 'err');
      const h = aoa[hi].map((c) => String(c).replace(/\s/g, ''));
      const ci = h.findIndex((c) => /^품명|^품목/.test(c));
      const cs = h.findIndex((c) => /^규격/.test(c));
      const cu = h.findIndex((c) => /^단위/.test(c));
      const cc = h.findIndex((c) => /분류/.test(c));
      const have = new Map(rows.map((r) => [r.key, r]));
      const ops: Parameters<typeof commitBatch>[0] = [];
      let dup = 0;
      let catSet = 0;
      const badCat = new Set<string>();
      const now = Date.now();
      for (const r of aoa.slice(hi + 1)) {
        const item = String(r[ci] ?? '').trim();
        if (!item) continue;
        const spec = cs >= 0 ? String(r[cs] ?? '').trim() : '';
        const k = itemKey(item, spec);
        const catText = cc >= 0 ? String(r[cc] ?? '').trim() : '';
        const st = catText ? std.find((x) => nameKey(x.name) === nameKey(catText)) ?? stdOfText(catText, std) : undefined;
        if (catText && !st) badCat.add(catText);
        const ex = have.get(k);
        if (st && (!ex || ex.stdCatId !== st.id)) {
          ops.push({ type: 'set', col: C.itemCats, id: itemCatId(item, spec), data: { itemName: ex?.itemName ?? item, spec: ex?.spec ?? spec, stdCatId: st.id, byName: who, at: now }, merge: false });
          catSet++;
        }
        if (ex) {
          dup++;
          continue;
        }
        have.set(k, { key: k, itemName: item, spec, unit: '', source: '직접 등록', hidden: false, stdCatId: st?.id ?? '', catFrom: st ? '지정' : '' });
        ops.push({ type: 'set', col: C.items, id: newId(C.items), data: { itemName: item, spec, unit: cu >= 0 ? String(r[cu] ?? '').trim() : '', ...(st ? { stdCatId: st.id } : {}), status: 'active', createdAt: now, requestedByName: who } });
      }
      const added = ops.filter((o) => o.col === C.items).length;
      if (!ops.length) return toast(`새로 등록하거나 바꿀 품목이 없습니다. (이미 있는 품목 ${dup}건)${badCat.size ? ` · 모르는 분류: ${[...badCat].slice(0, 5).join(', ')}` : ''}`, 'err');
      if (!confirm(`새 품목 ${added}건 등록, 자재분류 지정 ${catSet}건을 반영할까요?\n(이미 있는 품목 ${dup}건은 등록 건너뜀)${badCat.size ? `\n표준분류에 없는 분류 ${badCat.size}개는 비워 둡니다: ${[...badCat].slice(0, 8).join(', ')}` : ''}`)) return;
      await commitBatch(ops);
      await audit('품목 엑셀 등록', file.name, { added, catSet });
      toast(`등록 ${added}건 · 분류 지정 ${catSet}건을 반영했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select className="input h-7" value={src} onChange={(e) => setSrc(e.target.value as typeof src)}>
          <option value="">전체</option>
          <option value="계산서">계산서 품목</option>
          <option value="직접 등록">직접 등록</option>
          <option value="숨김">숨긴 품목</option>
        </select>
        <select className="input h-7" value={catF} onChange={(e) => setCatF(e.target.value)}>
          <option value="">전체 분류</option>
          <option value="-">미분류만 ({noCat.toLocaleString()})</option>
          {stdOptions}
        </select>
        <input className="input h-7 w-56" placeholder="품명·규격 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-[12px] text-muted">{shown.length.toLocaleString()}건</span>
        {office && (
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost h-7 text-[12px]" disabled={catBusy} title={catalogAt ? `마지막: ${new Date(catalogAt).toLocaleString('ko-KR')}` : ''} onClick={reloadCats}>
              {catBusy ? '읽는 중…' : '계산서 분류 다시 읽기'}
            </button>
            <label className="btn-ghost h-7 cursor-pointer text-[12px]" title="품명·규격·단위·자재분류 열. 이미 있는 품목은 자재분류만 반영">
              엑셀로 등록
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => (importExcel(e.target.files?.[0]), (e.target.value = ''))} />
            </label>
            <button className="btn-primary h-7 text-[12px]" onClick={() => setForm({ itemName: '', spec: '', unit: '', stdCatId: '', note: '' })}>
              + 품목 등록
            </button>
          </div>
        )}
      </div>
      {office && sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-soft/60 px-4 py-2 text-[12.5px]">
          <b>{sel.size}건 선택</b>
          <select className="input h-7" value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
            <option value="">자동(계산서)으로 되돌리기</option>
            {stdOptions}
          </select>
          <button className="btn-primary h-7 text-[12px]" onClick={() => setCats(rows.filter((r) => sel.has(r.key)), bulkCat)}>
            자재분류 지정
          </button>
          <button className="text-[12px] text-muted hover:text-ink" onClick={() => setSel(new Set())}>
            선택 해제
          </button>
        </div>
      )}
      {!shown.length ? (
        <Empty>품목이 없습니다.</Empty>
      ) : (
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                {office && (
                  <th className="w-8">
                    <input type="checkbox" checked={shown.length > 0 && shown.slice(0, 600).every((r) => sel.has(r.key))} onChange={(e) => setSel(e.target.checked ? new Set(shown.slice(0, 600).map((r) => r.key)) : new Set())} />
                  </th>
                )}
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th>출처</th>
                <th>자재분류</th>
                <th className="num">최근 계산서 단가</th>
                <th>최근 업체·월</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 600).map((r) => (
                <tr key={r.key} className={r.hidden ? 'text-muted line-through' : ''}>
                  {office && (
                    <td>
                      <input
                        type="checkbox"
                        checked={sel.has(r.key)}
                        onChange={() =>
                          setSel((x) => {
                            const n = new Set(x);
                            if (n.has(r.key)) n.delete(r.key);
                            else n.add(r.key);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="font-medium">{r.itemName}</td>
                  <td>{r.spec}</td>
                  <td>{r.unit}</td>
                  <td>{r.source === '계산서' ? <span className="chip bg-navy-950/5 text-navy-900">계산서</span> : <span className="chip bg-emerald-50 text-emerald-700">직접 등록</span>}</td>
                  <td className="whitespace-nowrap">
                    {office ? (
                      <select
                        className={`input h-7 max-w-[150px] px-1.5 text-[12px] ${!r.stdCatId ? 'border-amber-400 text-amber-700' : r.catFrom === '계산서' ? 'text-muted' : ''}`}
                        value={r.stdCatId}
                        onChange={(e) => setCats([r], e.target.value)}
                      >
                        <option value="">{r.catFrom === '지정' ? '자동으로 되돌리기' : '미분류'}</option>
                        {stdOptions}
                      </select>
                    ) : (
                      <span className={r.stdCatId ? '' : 'text-amber-700'}>{stdName(r.stdCatId) || '미분류'}</span>
                    )}
                    {r.catFrom === '계산서' && <span className="ml-1 text-[10.5px] text-muted" title="계산서에서 가장 많이 쓰인 분류 (지정하면 바뀜)">자동</span>}
                  </td>
                  <td className="num">{r.lastPrice ? won(r.lastPrice) : ''}</td>
                  <td className="text-[12px] text-muted">{r.lastVendor ? `${r.lastVendor} · ${r.lastMonth}` : ''}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost h-7 text-[12px]" onClick={() => onCompare({ item: r.itemName, spec: r.spec })}>
                      단가 보기
                    </button>
                    {office && r.source === '직접 등록' && r.entry && (
                      <>
                        <button className="btn-ghost ml-1 h-7 text-[12px]" onClick={() => setForm({ id: r.entry!.id, itemName: r.itemName, spec: r.spec, unit: r.unit, stdCatId: r.catFrom === '계산서' ? '' : r.stdCatId, note: r.entry!.note ?? '' })}>
                          수정
                        </button>
                        <button className="ml-1 text-[12px] text-muted hover:text-red-600" onClick={() => remove(r.entry!)}>
                          지우기
                        </button>
                      </>
                    )}
                    {office && r.source === '계산서' && (
                      <button className="ml-1 text-[12px] text-muted hover:text-ink" title="청구서 품명 목록에서 숨기기/다시 보이기" onClick={() => toggleHide(r)}>
                        {r.hidden ? '다시 보이기' : '숨기기'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 600 && <div className="px-4 py-2 text-[12px] text-muted">{shown.length.toLocaleString()}건 중 600건 표시 — 검색으로 좁히세요</div>}
        </div>
      )}
      <Modal
        open={!!form}
        title={form?.id ? '품목 수정' : '품목 등록'}
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>
              취소
            </button>
            <button className="btn-primary" onClick={save}>
              저장
            </button>
          </>
        }
      >
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="품명 *">
                <input className="input" value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} />
              </Field>
            </div>
            <Field label="규격">
              <input className="input" value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} />
            </Field>
            <Field label="단위">
              <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="자재분류 (표준)">
                <select className="input" value={form.stdCatId} onChange={(e) => setForm({ ...form, stdCatId: e.target.value })}>
                  <option value="">-</option>
                  {stdOptions}
                </select>
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="메모">
                <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ───────── 단가표 ───────── */
interface PForm {
  id?: string;
  itemName: string;
  spec: string;
  unit: string;
  vendorId: string;
  siteId: string;
  listPrice: number;
  negoRate: number;
  price: number;
  validFrom: string;
  validTo: string;
  note: string;
}
type V = { id: string; name: string; aliases?: string[]; active?: boolean };
type S = { id: string; name: string };

function PricesTab({ list, rows, vendors, sites, office, who, onCompare, toast }: { list: PriceEntry[]; rows: Row[]; vendors: V[]; sites: S[]; office: boolean; who: string; onCompare: (x: { item: string; spec: string }) => void; toast: Toast }) {
  const [q, setQ] = useState('');
  const [vf, setVf] = useState('');
  const [sf, setSf] = useState<'' | 'common' | string>('');
  const [form, setForm] = useState<PForm | null>(null);
  const [hist, setHist] = useState<PriceEntry | null>(null);
  const [preview, setPreview] = useState<{ ops: Parameters<typeof commitBatch>[0]; added: number; changed: number; same: number; noVendor: string[] } | null>(null);
  const itemNames = useMemo(() => [...new Set(rows.map((r) => r.itemName))], [rows]);
  const specsOf = (item: string) => rows.filter((r) => nameKey(r.itemName) === nameKey(item)).map((r) => r.spec);
  const vLabel = (v: V) => v.name;

  const shown = useMemo(() => {
    const k = nameKey(q);
    return list
      .filter((p) => !vf || p.vendorId === vf)
      .filter((p) => (sf === 'common' ? !p.siteId : sf ? p.siteId === sf : true))
      .filter((p) => !k || nameKey(`${p.itemName} ${p.spec} ${p.vendorName}`).includes(k))
      .sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko') || a.spec.localeCompare(b.spec, 'ko') || a.price - b.price);
  }, [list, q, vf, sf]);

  const keyOf = (item: string, spec: string, vendorId: string, siteId?: string) => `${itemKey(item, spec)}|${vendorId}|${siteId ?? ''}`;

  const save = async () => {
    if (!form) return;
    if (!form.itemName.trim() || !form.vendorId) return toast('품명과 업체를 고르세요.', 'err');
    const price = form.price || buyPrice(form.listPrice, form.negoRate);
    if (!(price > 0)) return toast('구매단가(또는 협가)를 입력하세요.', 'err');
    const v = vendors.find((x) => x.id === form.vendorId);
    const s = sites.find((x) => x.id === form.siteId);
    const k = keyOf(form.itemName, form.spec, form.vendorId, form.siteId || undefined);
    const ex = list.find((p) => (form.id ? p.id === form.id : keyOf(p.itemName, p.spec, p.vendorId, p.siteId) === k));
    const now = Date.now();
    const data = {
      itemName: form.itemName.trim(),
      spec: form.spec.trim(),
      unit: form.unit.trim(),
      vendorId: form.vendorId,
      vendorName: v?.name ?? '',
      ...(s ? { siteId: s.id, siteName: s.name } : {}),
      listPrice: form.listPrice || 0,
      negoRate: form.negoRate || 0,
      price,
      ...(form.validFrom ? { validFrom: form.validFrom } : {}),
      ...(form.validTo ? { validTo: form.validTo } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
      updatedAt: now,
      updatedByName: who,
      history: ex ? (ex.price !== price ? [...(ex.history ?? []), { at: ex.updatedAt, by: ex.updatedByName, price: ex.price, listPrice: ex.listPrice, negoRate: ex.negoRate }] : ex.history ?? []) : [],
    };
    try {
      await commitBatch([{ type: 'set', col: C.priceList, id: ex?.id ?? newId(C.priceList), data, merge: false }]);
      await audit(ex ? '단가 수정' : '단가 등록', `${data.itemName} ${data.spec} ${data.vendorName}`, { price });
      toast(ex ? (ex.price !== price ? `단가를 ${won(ex.price)} → ${won(price)}원으로 바꿨습니다. (이전 단가는 이력에)` : '저장했습니다.') : '단가를 등록했습니다.');
      setForm(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const remove = async (p: PriceEntry) => {
    if (!confirm(`${p.itemName} ${p.spec} · ${p.vendorName} 단가를 지울까요?`)) return;
    try {
      await commitBatch([{ type: 'delete', col: C.priceList, id: p.id }]);
      toast('지웠습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  /** 엑셀 단가표 올리기: 업체·품명·규격·단위·협가·네고율·구매단가(단가)·현장 열을 찾아 읽는다 */
  const importExcel = async (file?: File) => {
    if (!file) return;
    try {
      const wb = readWorkbook(await file.arrayBuffer());
      const ops: Parameters<typeof commitBatch>[0] = [];
      let added = 0;
      let changed = 0;
      let same = 0;
      const noVendor = new Set<string>();
      const seen = new Map(list.map((p) => [keyOf(p.itemName, p.spec, p.vendorId, p.siteId), p]));
      const now = Date.now();
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '' });
        const hi = aoa.findIndex((r) => r.some((c) => /품\s*명|품목/.test(String(c))));
        if (hi < 0) continue;
        const h = aoa[hi].map((c) => String(c).replace(/\s/g, ''));
        const col = (re: RegExp) => h.findIndex((c) => re.test(c));
        const cv = col(/^(업체|거래처|거래선|공급사)/);
        const ci = col(/^(품명|품목)/);
        const cs = col(/^규격/);
        const cu = col(/^단위/);
        const cl = col(/^(협가|정가|기준가)/);
        const cn = col(/네고/);
        const cp = col(/^(구매단가|매입단가|단가|계약단가)/);
        const cst = col(/^현장/);
        for (const r of aoa.slice(hi + 1)) {
          const item = String(r[ci] ?? '').trim();
          if (!item) continue;
          // 업체 열이 없으면 시트 이름을 업체로 본다 (협가표처럼 업체별 시트)
          const vName = cv >= 0 ? String(r[cv] ?? '').trim() : sn;
          const v = matchVendor(vName, vendors as never);
          if (!v) {
            if (vName) noVendor.add(vName);
            continue;
          }
          const spec = cs >= 0 ? String(r[cs] ?? '').trim() : '';
          const lp = cl >= 0 ? num(r[cl]) : 0;
          const ngRaw = cn >= 0 ? num(r[cn]) : 0;
          const ng = Math.abs(ngRaw) <= 1 && ngRaw !== 0 ? Math.abs(ngRaw) * 100 : Math.abs(ngRaw);
          const price = (cp >= 0 ? num(r[cp]) : 0) || (lp ? buyPrice(lp, ng) : 0);
          if (!(price > 0)) continue;
          const siteName = cst >= 0 ? String(r[cst] ?? '').trim() : '';
          const st = siteName ? sites.find((s) => nameKey(s.name) === nameKey(siteName)) : undefined;
          const k = keyOf(item, spec, v.id, st?.id);
          const ex = seen.get(k);
          if (ex && ex.price === price) {
            same++;
            continue;
          }
          const data = {
            itemName: item,
            spec,
            unit: cu >= 0 ? String(r[cu] ?? '').trim() : ex?.unit ?? '',
            vendorId: v.id,
            vendorName: v.name,
            ...(st ? { siteId: st.id, siteName: st.name } : {}),
            listPrice: lp,
            negoRate: ng,
            price,
            updatedAt: now,
            updatedByName: who,
            note: `엑셀 ${file.name}`,
            history: ex ? [...(ex.history ?? []), { at: ex.updatedAt, by: ex.updatedByName, price: ex.price, listPrice: ex.listPrice, negoRate: ex.negoRate }] : [],
          };
          const id = ex?.id ?? newId(C.priceList);
          ops.push({ type: 'set', col: C.priceList, id, data, merge: false });
          seen.set(k, { ...(data as Omit<PriceEntry, 'id'>), id });
          if (ex) changed++;
          else added++;
        }
      }
      if (!ops.length && !noVendor.size) return toast(`바뀐 단가가 없습니다. (같은 단가 ${same}건)`, 'err');
      setPreview({ ops, added, changed, same, noVendor: [...noVendor] });
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const applyPreview = async () => {
    if (!preview) return;
    try {
      await commitBatch(preview.ops);
      await audit('단가표 엑셀 올리기', '', { added: preview.added, changed: preview.changed });
      toast(`신규 ${preview.added}건, 변경 ${preview.changed}건을 반영했습니다.`);
      setPreview(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const exportExcel = () => {
    const aoa = [
      ['업체', '품명', '규격', '단위', '현장', '협가', '네고율(%)', '구매단가', '적용 시작', '적용 끝', '메모', '수정일', '수정자'],
      ...shown.map((p) => [p.vendorName, p.itemName, p.spec, p.unit, p.siteName ?? '(공통)', p.listPrice || '', p.negoRate || '', p.price, p.validFrom ?? '', p.validTo ?? '', p.note ?? '', new Date(p.updatedAt).toLocaleDateString('ko-KR'), p.updatedByName]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [16, 24, 14, 6, 14, 10, 8, 10, 10, 10, 20, 10, 8].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '단가표');
    XLSX.writeFile(wb, `ERP단가표_${today()}.xlsx`);
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select className="input h-7" value={vf} onChange={(e) => setVf(e.target.value)}>
          <option value="">전체 업체</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <select className="input h-7" value={sf} onChange={(e) => setSf(e.target.value)}>
          <option value="">전체 (공통+현장)</option>
          <option value="common">공통 단가만</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} 예외
            </option>
          ))}
        </select>
        <input className="input h-7 w-56" placeholder="품명·규격·업체 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-[12px] text-muted">{shown.length.toLocaleString()}건</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost h-7 text-[12px]" onClick={exportExcel}>
            엑셀 내려받기
          </button>
          {office && (
            <>
              <label className="btn-ghost h-7 cursor-pointer text-[12px]" title="업체·품명·규격·단위·협가·네고율·구매단가(·현장) 열. 업체 열이 없으면 시트 이름을 업체로">
                엑셀 올리기
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => (importExcel(e.target.files?.[0]), (e.target.value = ''))} />
              </label>
              <button className="btn-primary h-7 text-[12px]" onClick={() => setForm({ itemName: '', spec: '', unit: '', vendorId: '', siteId: '', listPrice: 0, negoRate: 0, price: 0, validFrom: '', validTo: '', note: '' })}>
                + 단가 등록
              </button>
            </>
          )}
        </div>
      </div>
      {!shown.length ? (
        <Empty>{list.length ? '조건에 맞는 단가가 없습니다.' : '아직 ERP 단가표가 없습니다. "+ 단가 등록" 또는 "엑셀 올리기"로 시작하세요. (단가관리 시스템 단가는 지금처럼 같이 씁니다)'}</Empty>
      ) : (
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th>업체</th>
                <th>현장</th>
                <th className="num">협가</th>
                <th className="num">네고율</th>
                <th className="num">구매단가</th>
                <th>적용 기간</th>
                <th>수정</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 800).map((p) => (
                <tr key={p.id} className={priceValid(p) ? '' : 'text-muted'}>
                  <td className="font-medium">
                    <button className="hover:underline" onClick={() => onCompare({ item: p.itemName, spec: p.spec })}>
                      {p.itemName}
                    </button>
                  </td>
                  <td>{p.spec}</td>
                  <td>{p.unit}</td>
                  <td>{p.vendorName}</td>
                  <td>{p.siteName ? <span className="chip bg-amber-soft text-amber-800">{p.siteName}</span> : <span className="text-[12px] text-muted">공통</span>}</td>
                  <td className="num">{p.listPrice ? won(p.listPrice) : ''}</td>
                  <td className="num">{p.negoRate ? `${p.negoRate}%` : ''}</td>
                  <td className="num font-semibold">
                    {won(p.price)}
                    {p.history?.length ? (
                      <button className="ml-1 text-[10.5px] font-normal text-sky-700 hover:underline" onClick={() => setHist(p)}>
                        이력 {p.history.length}
                      </button>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-muted">
                    {p.validFrom || p.validTo ? `${p.validFrom ?? ''} ~ ${p.validTo ?? ''}` : ''}
                    {!priceValid(p) && <span className="ml-1 text-red-600">기간 밖</span>}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-muted">
                    {new Date(p.updatedAt).toLocaleDateString('ko-KR')} {p.updatedByName}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {office && (
                      <>
                        <button
                          className="btn-ghost h-7 text-[12px]"
                          onClick={() => setForm({ id: p.id, itemName: p.itemName, spec: p.spec, unit: p.unit, vendorId: p.vendorId, siteId: p.siteId ?? '', listPrice: p.listPrice, negoRate: p.negoRate, price: p.price, validFrom: p.validFrom ?? '', validTo: p.validTo ?? '', note: p.note ?? '' })}
                        >
                          수정
                        </button>
                        <button className="ml-1 text-[12px] text-muted hover:text-red-600" onClick={() => remove(p)}>
                          지우기
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!form}
        title={form?.id ? '단가 수정' : '단가 등록'}
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>
              취소
            </button>
            <button className="btn-primary" onClick={save}>
              저장
            </button>
          </>
        }
      >
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="품명 * (품목 목록에서)">
                <PickInput value={form.itemName} options={itemNames} placeholder="품명 ▾" onPick={(v) => setForm({ ...form, itemName: v, spec: specsOf(v)[0] ?? '', unit: rows.find((r) => r.itemName === v)?.unit ?? form.unit })} />
              </Field>
            </div>
            <Field label="규격">
              <PickInput value={form.spec} options={specsOf(form.itemName)} placeholder={form.itemName ? '규격 ▾' : '품명 먼저'} onPick={(v) => setForm({ ...form, spec: v, unit: rows.find((r) => r.itemName === form.itemName && r.spec === v)?.unit ?? form.unit })} />
            </Field>
            <Field label="단위">
              <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </Field>
            <Field label="업체 *">
              <PickInput value={vendors.find((v) => v.id === form.vendorId)?.name ?? ''} options={vendors.map(vLabel)} placeholder="업체 ▾" onPick={(name) => setForm({ ...form, vendorId: vendors.find((v) => v.name === name)?.id ?? '' })} />
            </Field>
            <Field label="현장 (예외 단가일 때만)">
              <select className="input" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
                <option value="">공통 (모든 현장)</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="협가">
              <NumInput className="input" value={form.listPrice} onChange={(n) => setForm({ ...form, listPrice: n, price: n ? buyPrice(n, form.negoRate) : form.price })} />
            </Field>
            <Field label="네고율 (%)">
              <NumInput className="input" value={form.negoRate} onChange={(n) => setForm({ ...form, negoRate: n, price: form.listPrice ? buyPrice(form.listPrice, n) : form.price })} />
            </Field>
            <div className="col-span-2">
              <Field label="구매단가 *" hint="협가·네고율을 넣으면 자동 계산. 직접 고쳐도 됩니다.">
                <NumInput className="input font-semibold" value={form.price} onChange={(n) => setForm({ ...form, price: n })} />
              </Field>
            </div>
            <Field label="적용 시작일">
              <input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </Field>
            <Field label="적용 끝">
              <input type="date" className="input" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="메모">
                <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!hist} title={hist ? `단가 이력 · ${hist.itemName} ${hist.spec} · ${hist.vendorName}` : ''} onClose={() => setHist(null)}>
        {hist && (
          <table className="tbl">
            <thead>
              <tr>
                <th>기간 끝</th>
                <th>수정자</th>
                <th className="num">협가</th>
                <th className="num">네고율</th>
                <th className="num">구매단가</th>
              </tr>
            </thead>
            <tbody>
              <tr className="font-semibold">
                <td>지금 ({new Date(hist.updatedAt).toLocaleDateString('ko-KR')}부터)</td>
                <td>{hist.updatedByName}</td>
                <td className="num">{hist.listPrice ? won(hist.listPrice) : ''}</td>
                <td className="num">{hist.negoRate ? `${hist.negoRate}%` : ''}</td>
                <td className="num">{won(hist.price)}</td>
              </tr>
              {[...(hist.history ?? [])].reverse().map((h, i) => (
                <tr key={i} className="text-muted">
                  <td>{new Date(h.at).toLocaleDateString('ko-KR')}부터</td>
                  <td>{h.by}</td>
                  <td className="num">{h.listPrice ? won(h.listPrice) : ''}</td>
                  <td className="num">{h.negoRate ? `${h.negoRate}%` : ''}</td>
                  <td className="num">{won(h.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        open={!!preview}
        title="엑셀 단가표 올리기"
        onClose={() => setPreview(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPreview(null)}>
              취소
            </button>
            <button className="btn-primary" disabled={!preview?.ops.length} onClick={applyPreview}>
              반영하기
            </button>
          </>
        }
      >
        {preview && (
          <div className="space-y-2 text-[13px]">
            <div>
              신규 <b>{preview.added}</b>건 · 단가 변경 <b>{preview.changed}</b>건 (이전 단가는 이력으로) · 같은 단가 {preview.same}건은 그대로
            </div>
            {preview.noVendor.length > 0 && (
              <div className="rounded-md bg-amber-soft px-3 py-2 text-amber-800">
                ERP 업체를 찾지 못해 건너뛴 업체 {preview.noVendor.length}곳: {preview.noVendor.slice(0, 10).join(', ')}
                {preview.noVendor.length > 10 ? ' …' : ''}
                <br />
                기준정보 › 업체에 등록하거나 "다른 표기"를 넣은 뒤 다시 올리세요.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ───────── 등록 요청 ───────── */
function RequestsTab({ requests, rows, office, who, toast }: { requests: ItemEntry[]; rows: Row[]; office: boolean; who: string; toast: Toast }) {
  const [edit, setEdit] = useState<Record<string, { itemName: string; spec: string; unit: string; note: string }>>({});
  const decide = async (e: ItemEntry, ok: boolean) => {
    const v = edit[e.id] ?? { itemName: e.itemName, spec: e.spec, unit: e.unit, note: '' };
    if (!ok && !v.note.trim()) return toast('거절 사유를 적어 주세요. (예: 기존 품목 "○○" 사용)', 'err');
    if (ok) {
      const dup = rows.find((r) => r.key === itemKey(v.itemName, v.spec));
      if (dup && !confirm(`이미 있는 품목과 같습니다: ${dup.itemName} ${dup.spec}. 그래도 승인할까요?`)) return;
    }
    try {
      await commitBatch([
        {
          type: 'set',
          col: C.items,
          id: e.id,
          data: ok ? { itemName: v.itemName.trim(), spec: v.spec.trim(), unit: v.unit.trim(), status: 'active', decidedByName: who, updatedAt: Date.now() } : { status: 'rejected', decidedByName: who, decideNote: v.note.trim(), updatedAt: Date.now() },
        },
      ]);
      toast(ok ? '승인했습니다. 청구서 품명 목록에 등록됐습니다.' : '거절했습니다.');
    } catch (err) {
      toast(errMsg(err), 'err');
    }
  };
  if (!requests.length) return <div className="card"><Empty>대기 중인 품목 등록 요청이 없습니다. 현장에서 청구서 작성 중 "새 품목 요청"을 하면 여기에 나타납니다.</Empty></div>;
  return (
    <div className="card overflow-hidden">
      <table className="tbl">
        <thead>
          <tr>
            <th>요청일</th>
            <th>요청자</th>
            <th>현장</th>
            <th>품명</th>
            <th>규격</th>
            <th>단위</th>
            <th>메모</th>
            {office && <th className="w-[260px]"></th>}
          </tr>
        </thead>
        <tbody>
          {requests.map((e) => {
            const v = edit[e.id] ?? { itemName: e.itemName, spec: e.spec, unit: e.unit, note: '' };
            const set = (p: Partial<typeof v>) => setEdit((m) => ({ ...m, [e.id]: { ...v, ...p } }));
            return (
              <tr key={e.id}>
                <td className="whitespace-nowrap">{new Date(e.createdAt).toLocaleDateString('ko-KR')}</td>
                <td>{e.requestedByName}</td>
                <td>{e.requestSiteName}</td>
                <td>{office ? <input className="input h-7 w-40 px-1.5" value={v.itemName} onChange={(x) => set({ itemName: x.target.value })} /> : e.itemName}</td>
                <td>{office ? <input className="input h-7 w-28 px-1.5" value={v.spec} onChange={(x) => set({ spec: x.target.value })} /> : e.spec}</td>
                <td>{office ? <input className="input h-7 w-14 px-1.5" value={v.unit} onChange={(x) => set({ unit: x.target.value })} /> : e.unit}</td>
                <td className="text-muted">{e.note}</td>
                {office && (
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      <input className="input h-7 w-28 px-1.5 text-[12px]" placeholder="거절 사유" value={v.note} onChange={(x) => set({ note: x.target.value })} />
                      <button className="btn-ghost h-7 text-[12px]" onClick={() => decide(e, false)}>
                        거절
                      </button>
                      <button className="btn-primary h-7 text-[12px]" onClick={() => decide(e, true)}>
                        승인
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {office && <div className="border-t border-line px-4 py-2 text-[12px] text-muted">승인 전에 품명·규격·단위를 회사 표기로 고칠 수 있습니다.</div>}
    </div>
  );
}

/* ───────── 단가 비교 ───────── */
function PriceCompare({ item, spec, list, catalog, sites, onClose }: { item: string; spec: string; list: PriceEntry[]; catalog: ReturnType<typeof useItemCatalog>['items']; sites: S[]; onClose: () => void }) {
  const k = itemKey(item, spec);
  const erp = list.filter((p) => itemKey(p.itemName, p.spec) === k).sort((a, b) => a.price - b.price);
  const cat = catalog.find((c) => itemKey(c.i, c.s) === k);
  const [old, setOld] = useState<PriceRow[] | null>(null);
  useEffect(() => {
    loadPrices({ canRebuild: false })
      .then((rows) => setOld(rows.filter((r) => itemKey(r.itemName, r.spec) === k)))
      .catch(() => setOld([]));
  }, [k]);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  return (
    <Modal open title={`단가 비교 · ${item} ${spec}`} onClose={onClose} wide>
      <div className="space-y-4">
        <section>
          <div className="mb-1 font-semibold">ERP 단가표</div>
          {erp.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>업체</th>
                  <th>현장</th>
                  <th className="num">구매단가</th>
                  <th>적용 기간</th>
                  <th>수정</th>
                </tr>
              </thead>
              <tbody>
                {erp.map((p) => (
                  <tr key={p.id} className={priceValid(p) ? '' : 'text-muted'}>
                    <td>{p.vendorName}</td>
                    <td>{p.siteName ?? '공통'}</td>
                    <td className="num font-semibold">{won(p.price)}</td>
                    <td className="text-[12px] text-muted">{p.validFrom || p.validTo ? `${p.validFrom ?? ''} ~ ${p.validTo ?? ''}` : ''}</td>
                    <td className="text-[12px] text-muted">{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-[12.5px] text-muted">등록된 단가가 없습니다.</div>
          )}
        </section>
        <section>
          <div className="mb-1 font-semibold">최근 계산서 실제 단가</div>
          {cat ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>업체</th>
                  <th>월</th>
                  <th className="num">단가</th>
                </tr>
              </thead>
              <tbody>
                <tr className="font-semibold">
                  <td>회사 전체 최신</td>
                  <td>{cat.last.v}</td>
                  <td>{cat.last.m}</td>
                  <td className="num">{won(cat.last.p)}</td>
                </tr>
                {Object.entries(cat.site).map(([sid, lp]) => (
                  <tr key={sid}>
                    <td>{siteName(sid)} 최신</td>
                    <td>{lp.v}</td>
                    <td>{lp.m}</td>
                    <td className="num">{won(lp.p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-[12.5px] text-muted">계산서 기록이 없습니다.</div>
          )}
        </section>
        <section>
          <div className="mb-1 font-semibold">단가관리 시스템 단가</div>
          {old === null ? (
            <div className="text-[12.5px] text-muted">불러오는 중…</div>
          ) : old.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>업체</th>
                  <th className="num">협가</th>
                  <th className="num">네고율</th>
                  <th className="num">구매단가</th>
                </tr>
              </thead>
              <tbody>
                {old.map((r, i) => (
                  <tr key={i}>
                    <td>{r.vendorName}</td>
                    <td className="num">{r.listPrice ? won(r.listPrice) : ''}</td>
                    <td className="num">{r.negoRate ? `${r.negoRate}%` : ''}</td>
                    <td className="num">{won(r.buyPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-[12.5px] text-muted">없습니다.</div>
          )}
        </section>
      </div>
    </Modal>
  );
}
