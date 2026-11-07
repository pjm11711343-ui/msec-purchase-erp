// 품목·단가 › 현장 지정단가
//  - 현장을 고르면 그 현장이 계산서로 산 품목 + 지정단가가 한 표에 나온다
//  - 품목 × 업체마다 지정단가 · 적용 기간 · 변경 이력
//  - 청구서 단가 자동 채우기에서 맨 먼저 (지정단가 → 계산서 → 단가표 → …)
//  - 엑셀 내려받기·올리기, 다른 현장 지정단가 복사(비율 조정)
//  - 현장 최근 계산서 단가와 다르면 빨간색
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import type { CatItem } from '../../lib/itemCatalog';
import { itemKey, offFixed, priceValid, type PriceEntry } from '../../lib/itemMaster';
import { matchVendor } from '../../lib/nameMatch';
import { nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import PickInput from '../../components/PickInput';
import { Empty, errMsg, Field, Modal, NumInput, type useToast } from '../../components/ui';

type V = { id: string; name: string; aliases?: string[]; active?: boolean };
type S = { id: string; name: string };
type R = { itemName: string; spec: string; unit: string };
type Toast = ReturnType<typeof useToast>;
interface Form {
  id?: string;
  itemName: string;
  spec: string;
  unit: string;
  vendorId: string;
  price: number;
  validFrom: string;
  validTo: string;
  note: string;
}
type Op = Parameters<typeof commitBatch>[0][number];

const keyOf = (item: string, spec: string, vendorId: string) => `${itemKey(item, spec)}|${vendorId}`;

export default function SiteFixedPrices({ list, rows, catalog, vendors, sites, office, who, toast }: { list: PriceEntry[]; rows: R[]; catalog: CatItem[]; vendors: V[]; sites: S[]; office: boolean; who: string; toast: Toast }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'fixed' | 'all'>('fixed');
  const [form, setForm] = useState<Form | null>(null);
  const [hist, setHist] = useState<PriceEntry | null>(null);
  const [copy, setCopy] = useState<{ from: string; rate: number; overwrite: boolean } | null>(null);
  const [preview, setPreview] = useState<{ title: string; ops: Op[]; added: number; changed: number; same: number; skipped: string[] } | null>(null);
  const site = sites.find((s) => s.id === siteId);
  const activeVendors = vendors.filter((v) => v.active !== false);
  const itemNames = useMemo(() => [...new Set(rows.map((r) => r.itemName))], [rows]);
  const specsOf = (item: string) => rows.filter((r) => nameKey(r.itemName) === nameKey(item)).map((r) => r.spec);
  const unitOf = (item: string, spec: string) => rows.find((r) => itemKey(r.itemName, r.spec) === itemKey(item, spec))?.unit ?? '';
  const catOf = useMemo(() => new Map(catalog.map((c) => [itemKey(c.i, c.s), c])), [catalog]);

  const fixed = useMemo(() => list.filter((p) => p.fixed && p.siteId === siteId), [list, siteId]);
  /** 표: 지정단가 줄 + (전체 보기면) 이 현장이 계산서로 산 품목 중 지정단가 없는 것 */
  const table = useMemo(() => {
    const k = nameKey(q);
    const out: { key: string; itemName: string; spec: string; unit: string; p?: PriceEntry; inv?: { p: number; m: string; v: string; vid: string } }[] = [];
    const has = new Set<string>();
    for (const p of fixed) {
      const ik = itemKey(p.itemName, p.spec);
      has.add(ik);
      out.push({ key: p.id, itemName: p.itemName, spec: p.spec, unit: p.unit, p, inv: catOf.get(ik)?.site[siteId] });
    }
    if (mode === 'all')
      for (const c of catalog) {
        const lp = c.site[siteId];
        const ik = itemKey(c.i, c.s);
        if (!lp || has.has(ik)) continue;
        out.push({ key: `c_${ik}`, itemName: c.i, spec: c.s, unit: c.u, inv: lp });
      }
    return out
      .filter((r) => !k || nameKey(`${r.itemName} ${r.spec} ${r.p?.vendorName ?? ''} ${r.inv?.v ?? ''}`).includes(k))
      .sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko') || a.spec.localeCompare(b.spec, 'ko') || (a.p?.vendorName ?? '').localeCompare(b.p?.vendorName ?? '', 'ko'));
  }, [fixed, catalog, catOf, siteId, mode, q]);
  const diffCount = table.filter((r) => r.p && r.inv && offFixed(r.p.price, r.inv.p)).length;

  const entry = (f: { itemName: string; spec: string; unit: string; vendorId: string; price: number; validFrom?: string; validTo?: string; note?: string }, ex: PriceEntry | undefined, s: S) => {
    const v = vendors.find((x) => x.id === f.vendorId);
    const now = Date.now();
    return {
      itemName: f.itemName.trim(),
      spec: f.spec.trim(),
      unit: f.unit.trim(),
      vendorId: f.vendorId,
      vendorName: v?.name ?? '',
      siteId: s.id,
      siteName: s.name,
      fixed: true,
      listPrice: 0,
      negoRate: 0,
      price: f.price,
      ...(f.validFrom ? { validFrom: f.validFrom } : {}),
      ...(f.validTo ? { validTo: f.validTo } : {}),
      ...(f.note?.trim() ? { note: f.note.trim() } : {}),
      updatedAt: now,
      updatedByName: who,
      history: ex ? (ex.price !== f.price ? [...(ex.history ?? []), { at: ex.updatedAt, by: ex.updatedByName, price: ex.price }] : ex.history ?? []) : [],
    };
  };
  const findFixed = (s: string, item: string, spec: string, vendorId: string) => list.find((p) => p.fixed && p.siteId === s && keyOf(p.itemName, p.spec, p.vendorId) === keyOf(item, spec, vendorId));

  const save = async () => {
    if (!form || !site) return;
    if (!form.itemName.trim() || !form.vendorId) return toast('품명과 업체를 고르세요.', 'err');
    if (!(form.price > 0)) return toast('지정단가를 입력하세요.', 'err');
    if (form.validFrom && form.validTo && form.validFrom > form.validTo) return toast('적용 기간이 거꾸로입니다.', 'err');
    const ex = form.id ? list.find((p) => p.id === form.id) : findFixed(siteId, form.itemName, form.spec, form.vendorId);
    const data = entry(form, ex, site);
    try {
      await commitBatch([{ type: 'set', col: C.priceList, id: ex?.id ?? newId(C.priceList), data, merge: false }]);
      await audit(ex ? '현장 지정단가 수정' : '현장 지정단가 등록', `${site.name} ${data.itemName} ${data.spec} ${data.vendorName}`, { price: data.price });
      toast(ex && ex.price !== data.price ? `지정단가를 ${won(ex.price)} → ${won(data.price)}원으로 바꿨습니다. (이전 단가는 이력에)` : '저장했습니다.');
      setForm(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const remove = async (p: PriceEntry) => {
    if (!confirm(`${p.itemName} ${p.spec} · ${p.vendorName} 지정단가를 지울까요?`)) return;
    try {
      await commitBatch([{ type: 'delete', col: C.priceList, id: p.id }]);
      await audit('현장 지정단가 삭제', `${p.siteName} ${p.itemName} ${p.spec} ${p.vendorName}`);
      toast('지웠습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const exportXlsx = () => {
    const aoa: (string | number)[][] = [['품명', '규격', '단위', '업체', '지정단가', '적용시작', '적용끝', '비고', '현장 최근 계산서 단가', '계산서 월', '계산서 업체']];
    for (const r of table) aoa.push([r.itemName, r.spec, r.unit, r.p?.vendorName ?? r.inv?.v ?? '', r.p?.price ?? '', r.p?.validFrom ?? '', r.p?.validTo ?? '', r.p?.note ?? '', r.inv?.p ?? '', r.inv?.m ?? '', r.inv?.v ?? '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 6 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 16 }, { wch: 12 }, { wch: 9 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '현장지정단가');
    XLSX.writeFile(wb, `현장지정단가_${site?.name ?? ''}.xlsx`);
  };
  const importXlsx = async (file: File) => {
    if (!site) return;
    try {
      const wb = readWorkbook(new Uint8Array(await file.arrayBuffer()));
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const head = (aoa[0] ?? []).map((h) => String(h).replace(/\s/g, ''));
      const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
      const ci = { item: col('품명'), spec: col('규격'), unit: col('단위'), vendor: col('업체', '거래선'), price: col('지정단가', '단가'), from: col('적용시작', '시작'), to: col('적용끝', '끝'), note: col('비고') };
      if (ci.item < 0 || ci.vendor < 0 || ci.price < 0) return toast('첫 줄에 품명·업체·지정단가 제목이 있어야 합니다. 엑셀 내려받기 양식을 쓰세요.', 'err');
      const ops: Op[] = [];
      const skipped: string[] = [];
      let added = 0;
      let changed = 0;
      let same = 0;
      const seen = new Set<string>();
      for (const r of aoa.slice(1)) {
        const item = String(r[ci.item] ?? '').trim();
        const price = num(r[ci.price]);
        if (!item || !(price > 0)) continue;
        const spec = ci.spec >= 0 ? String(r[ci.spec] ?? '').trim() : '';
        const vname = String(r[ci.vendor] ?? '').trim();
        const v = matchVendor(vname, vendors as never);
        if (!v) {
          skipped.push(`${item} ${spec} (업체 '${vname || '빈칸'}' 없음)`);
          continue;
        }
        const k = keyOf(item, spec, v.id);
        if (seen.has(k)) continue;
        seen.add(k);
        const ex = findFixed(siteId, item, spec, v.id);
        const f = { itemName: item, spec, unit: (ci.unit >= 0 ? String(r[ci.unit] ?? '').trim() : '') || unitOf(item, spec), vendorId: v.id, price, validFrom: ci.from >= 0 ? String(r[ci.from] ?? '').trim() : '', validTo: ci.to >= 0 ? String(r[ci.to] ?? '').trim() : '', note: ci.note >= 0 ? String(r[ci.note] ?? '') : '' };
        if (ex && ex.price === price && (ex.validFrom ?? '') === f.validFrom && (ex.validTo ?? '') === f.validTo) {
          same++;
          continue;
        }
        ex ? changed++ : added++;
        ops.push({ type: 'set', col: C.priceList, id: ex?.id ?? newId(C.priceList), data: entry(f, ex, site), merge: false });
      }
      setPreview({ title: `엑셀 올리기 · ${site.name}`, ops, added, changed, same, skipped });
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const buildCopy = () => {
    if (!copy || !site) return;
    const from = sites.find((s) => s.id === copy.from);
    if (!from || from.id === siteId) return toast('복사해 올 다른 현장을 고르세요.', 'err');
    const src = list.filter((p) => p.fixed && p.siteId === from.id);
    if (!src.length) return toast(`${from.name}에는 지정단가가 없습니다.`, 'err');
    const ops: Op[] = [];
    let added = 0;
    let changed = 0;
    let same = 0;
    for (const p of src) {
      const price = Math.round(p.price * (1 + (copy.rate || 0) / 100));
      const ex = findFixed(siteId, p.itemName, p.spec, p.vendorId);
      if (ex && (!copy.overwrite || ex.price === price)) {
        same++;
        continue;
      }
      ex ? changed++ : added++;
      ops.push({ type: 'set', col: C.priceList, id: ex?.id ?? newId(C.priceList), data: entry({ itemName: p.itemName, spec: p.spec, unit: p.unit, vendorId: p.vendorId, price, note: `${from.name}에서 복사${copy.rate ? ` (${copy.rate > 0 ? '+' : ''}${copy.rate}%)` : ''}` }, ex, site), merge: false });
    }
    setCopy(null);
    setPreview({ title: `${from.name} → ${site.name} 지정단가 복사`, ops, added, changed, same, skipped: [] });
  };
  const runPreview = async () => {
    if (!preview) return;
    try {
      for (let i = 0; i < preview.ops.length; i += 400) await commitBatch(preview.ops.slice(i, i + 400));
      await audit('현장 지정단가 일괄', preview.title, { added: preview.added, changed: preview.changed });
      toast(`${preview.added}건 추가 · ${preview.changed}건 변경했습니다.`);
      setPreview(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const newForm = (r?: { itemName: string; spec: string; unit: string; inv?: { p: number; vid: string } }): Form => ({ itemName: r?.itemName ?? '', spec: r?.spec ?? '', unit: r?.unit ?? '', vendorId: r?.inv?.vid && vendors.some((v) => v.id === r.inv!.vid) ? r.inv.vid : '', price: r?.inv?.p ?? 0, validFrom: '', validTo: '', note: '' });

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select className="input h-8 w-52" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({list.filter((p) => p.fixed && p.siteId === s.id).length})
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-md bg-canvas p-0.5">
          {(['fixed', 'all'] as const).map((k) => (
            <button key={k} className={`rounded px-2.5 py-1 text-[12px] ${mode === k ? 'bg-white font-semibold shadow-sm' : 'text-muted'}`} onClick={() => setMode(k)}>
              {k === 'fixed' ? `지정단가 ${fixed.length}` : '이 현장 품목 전체'}
            </button>
          ))}
        </div>
        <input className="input h-8 w-48" placeholder="품명·규격·업체 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        {diffCount > 0 && <span className="chip bg-red-50 text-red-700">계산서 단가와 다름 {diffCount}</span>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <button className="btn-ghost h-8 text-[12px]" disabled={!table.length} onClick={exportXlsx}>
            엑셀 내려받기
          </button>
          {office && (
            <>
              <label className="btn-ghost h-8 cursor-pointer text-[12px]">
                엑셀 올리기
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => (e.target.files?.[0] && importXlsx(e.target.files[0]), (e.target.value = ''))} />
              </label>
              <button className="btn-ghost h-8 text-[12px]" onClick={() => setCopy({ from: '', rate: 0, overwrite: false })}>
                다른 현장에서 복사
              </button>
              <button className="btn-primary h-8 text-[12px]" onClick={() => setForm(newForm())}>
                + 지정단가
              </button>
            </>
          )}
        </div>
      </div>
      <div className="border-b border-line bg-violet-50/60 px-4 py-1.5 text-[11.5px] text-violet-900">
        지정단가는 이 현장 청구서 단가 자동 채우기에서 <b>맨 먼저</b> 씁니다 (지정단가 → 최신 계산서 → 단가표 → 직전 발주). 같은 품목이라도 업체마다 따로 정하고, 청구서에 거래선이 있으면 그 업체 지정단가를 씁니다.
      </div>
      {!table.length ? (
        <Empty>{mode === 'fixed' ? "지정단가가 없습니다. '이 현장 품목 전체'에서 품목을 골라 지정하거나 '+ 지정단가'를 누르세요." : '이 현장 계산서 품목이 없습니다.'}</Empty>
      ) : (
        <div className="max-h-[640px] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th>업체</th>
                <th className="num">지정단가</th>
                <th>적용 기간</th>
                <th className="num">현장 최근 계산서</th>
                <th className="num">차이</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => {
                const p = r.p;
                const off = p && r.inv ? offFixed(p.price, r.inv.p) : false;
                const diff = p && r.inv ? r.inv.p - p.price : 0;
                return (
                  <tr key={r.key} className={p && !priceValid(p) ? 'text-muted' : ''}>
                    <td className="text-center">{r.itemName}</td>
                    <td className="text-[12px] text-center">{r.spec}</td>
                    <td>{r.unit}</td>
                    <td>{p ? p.vendorName : <span className="text-[12px] text-muted">-</span>}</td>
                    <td className="num font-semibold text-violet-800">
                      {p ? won(p.price) : ''}
                      {p && (p.history?.length ?? 0) > 0 && (
                        <button className="ml-1 text-[10.5px] font-normal text-sky-700 hover:underline" onClick={() => setHist(p)}>
                          이력 {p.history.length}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[11.5px]">
                      {p ? (p.validFrom || p.validTo ? `${p.validFrom ?? ''} ~ ${p.validTo ?? ''}` : '계속') : ''}
                      {p && !priceValid(p) && <span className="ml-1 text-red-600">기간 밖</span>}
                    </td>
                    <td className={`num ${off ? 'font-semibold text-red-600' : ''}`} title={r.inv ? `${r.inv.m} · ${r.inv.v}` : undefined}>
                      {r.inv ? won(r.inv.p) : ''}
                      {r.inv && <div className="text-[10.5px] font-normal text-muted">{r.inv.m} · {r.inv.v}</div>}
                    </td>
                    <td className={`num text-[12px] ${off ? 'font-semibold text-red-600' : 'text-muted'}`}>{p && r.inv ? (off ? `${diff > 0 ? '+' : ''}${won(diff)} (${((diff / p.price) * 100).toFixed(1)}%)` : '같음') : ''}</td>
                    <td className="whitespace-nowrap text-right">
                      {office &&
                        (p ? (
                          <>
                            <button className="btn-ghost h-7 text-[12px]" onClick={() => setForm({ id: p.id, itemName: p.itemName, spec: p.spec, unit: p.unit, vendorId: p.vendorId, price: p.price, validFrom: p.validFrom ?? '', validTo: p.validTo ?? '', note: p.note ?? '' })}>
                              수정
                            </button>
                            <button className="btn-ghost h-7 text-[12px] hover:text-red-600" onClick={() => remove(p)}>
                              삭제
                            </button>
                          </>
                        ) : (
                          <button className="btn-dark h-7 text-[12px]" onClick={() => setForm(newForm(r))}>
                            지정
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <Modal
          open
          title={`${form.id ? '지정단가 수정' : '지정단가 등록'} · ${site?.name ?? ''}`}
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
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="품명 *">
                <PickInput className="input" value={form.itemName} options={itemNames} onPick={(v) => setForm({ ...form, itemName: v, spec: '', unit: '' })} />
              </Field>
            </div>
            <Field label="규격">
              <PickInput className="input" value={form.spec} options={specsOf(form.itemName)} onPick={(v) => setForm({ ...form, spec: v, unit: form.unit || unitOf(form.itemName, v) })} />
            </Field>
            <Field label="단위">
              <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="업체 *">
                <select className="input" value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
                  <option value="">업체 선택</option>
                  {activeVendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="지정단가 *">
              <NumInput className="input text-right" value={form.price} onChange={(n) => setForm({ ...form, price: n })} />
            </Field>
            <div />
            <Field label="적용 시작 (비우면 바로)">
              <input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </Field>
            <Field label="적용 끝 (비우면 계속)">
              <input type="date" className="input" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="비고 (예: 계약 단가, 협의 내용)">
                <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </div>
            {(() => {
              const lp = catOf.get(itemKey(form.itemName, form.spec))?.site[siteId];
              return lp ? <div className="col-span-2 text-[12px] text-muted">이 현장 최근 계산서 단가: <b>{won(lp.p)}원</b> ({lp.m} · {lp.v})</div> : null;
            })()}
          </div>
        </Modal>
      )}

      {copy && (
        <Modal
          open
          title={`다른 현장 지정단가 복사 → ${site?.name ?? ''}`}
          onClose={() => setCopy(null)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setCopy(null)}>
                취소
              </button>
              <button className="btn-primary" onClick={buildCopy}>
                미리 보기
              </button>
            </>
          }
        >
          <div className="space-y-3 text-[13px]">
            <Field label="복사해 올 현장">
              <select className="input" value={copy.from} onChange={(e) => setCopy({ ...copy, from: e.target.value })}>
                <option value="">현장 선택</option>
                {sites
                  .filter((s) => s.id !== siteId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (지정단가 {list.filter((p) => p.fixed && p.siteId === s.id).length})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="단가 조정 % (예: 3 = 3% 올림, -2 = 2% 내림, 0 = 그대로)">
              <NumInput className="input w-32 text-right" value={copy.rate} onChange={(n) => setCopy({ ...copy, rate: n })} />
            </Field>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={copy.overwrite} onChange={(e) => setCopy({ ...copy, overwrite: e.target.checked })} /> 이 현장에 이미 있는 지정단가도 덮어쓰기
            </label>
          </div>
        </Modal>
      )}

      {preview && (
        <Modal
          open
          title={preview.title}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setPreview(null)}>
                취소
              </button>
              <button className="btn-primary" disabled={!preview.ops.length} onClick={runPreview}>
                반영
              </button>
            </>
          }
        >
          <div className="space-y-2 text-[13px]">
            <div>
              추가 <b>{preview.added}</b>건 · 변경 <b>{preview.changed}</b>건 · 그대로 {preview.same}건
            </div>
            {preview.skipped.length > 0 && (
              <div className="rounded-md bg-amber-soft px-3 py-2 text-[12px] text-amber-900">
                건너뜀 {preview.skipped.length}건 (업체 이름을 업체 목록과 같게 고쳐서 다시 올리세요): {preview.skipped.slice(0, 8).join(', ')}
                {preview.skipped.length > 8 ? ' …' : ''}
              </div>
            )}
          </div>
        </Modal>
      )}

      {hist && (
        <Modal open title={`지정단가 이력 · ${hist.itemName} ${hist.spec} · ${hist.vendorName}`} onClose={() => setHist(null)}>
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th>바뀐 때까지</th>
                <th>바꾼 사람</th>
                <th className="num">단가</th>
              </tr>
            </thead>
            <tbody>
              <tr className="font-semibold">
                <td>{new Date(hist.updatedAt).toLocaleString('ko-KR')} (지금)</td>
                <td>{hist.updatedByName}</td>
                <td className="num">{won(hist.price)}</td>
              </tr>
              {[...hist.history].reverse().map((h, i) => (
                <tr key={i}>
                  <td>{new Date(h.at).toLocaleString('ko-KR')}</td>
                  <td>{h.by}</td>
                  <td className="num">{won(h.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
