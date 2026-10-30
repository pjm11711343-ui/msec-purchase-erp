// 구매 흐름 › 견적 의뢰 (자재부·관리자)
//  목록 → 의뢰서 작성(품목·현장·업체) → 업체에 보내기(메일+포털) → 견적 받기(포털 제출 / 엑셀·직접 입력) → 비교 → ERP 단가표 반영
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites, useVendors } from '../../lib/hooks';
import { itemKey, usePriceList } from '../../lib/itemMaster';
import { useStdItems } from '../../lib/stdItems';
import { aliasKey, saveReqAliases } from '../../lib/reqAlias';
import PickInput from '../../components/PickInput';
import { nameKey, num, won } from '../../lib/normalize';
import { notify } from '../../lib/notify';
import { readWorkbook } from '../../lib/parsers';
import { elementToPdfBase64 } from '../../lib/poPdf';
import { applyQuotes, DEFAULT_RFQ_GUIDE, nextRfqNo, quoteId, useQuotes, useRfqs, type QuoteLine, type Rfq, type RfqLine, type RfqQuote } from '../../lib/rfq';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';
import type { Vendor } from '../../types';

const STATUS: Record<Rfq['status'], [string, string]> = {
  draft: ['작성 중', 'bg-line text-muted'],
  sent: ['견적 받는 중', 'bg-amber-soft text-amber-800'],
  closed: ['마감', 'bg-emerald-50 text-emerald-700'],
};
const lineKey = () => Math.random().toString(36).slice(2, 9);

export default function RfqPage() {
  const { id } = useParams();
  return id ? <RfqDetail id={id} /> : <RfqList />;
}

function RfqList() {
  const rfqs = useRfqs();
  const quotes = useQuotes();
  const [q, setQ] = useState('');
  const list = [...rfqs.data].sort((a, b) => b.createdAt - a.createdAt).filter((r) => !q || nameKey([r.rfqNo, r.title, r.siteName, ...r.lines.map((l) => l.itemName)].join(' ')).includes(nameKey(q)));
  return (
    <div>
      <PageHeader
        title="견적 의뢰"
        desc="업체에 품명·규격·수량으로 견적을 의뢰합니다. 업체는 포털에서 단가를 넣어 제출하거나 견적서 파일로 회신하고, 받은 견적은 품목·단가(ERP 단가표)에 업체별 단가로 반영되어 구매청구서 단가 자동 채우기에 쓰입니다."
        actions={
          <Link to="/rfq/new" className="btn-primary">
            + 견적 의뢰서 작성
          </Link>
        }
      />
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">{list.length}건</span>
          <input className="input ml-auto h-7 w-56" placeholder="견적번호·현장·품명 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!list.length ? (
          <Empty>{rfqs.loading ? '불러오는 중…' : '견적 의뢰서가 없습니다.'}</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>작성일</th>
                <th>견적번호</th>
                <th>제목</th>
                <th>현장</th>
                <th>품목</th>
                <th className="text-center">업체</th>
                <th className="text-center">회신</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const qs = quotes.data.filter((x) => x.rfqId === r.id && x.status === 'submitted');
                const pend = qs.filter((x) => !x.appliedAt).length;
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString('ko-KR')}</td>
                    <td>
                      <Link to={`/rfq/${r.id}`} className="font-semibold text-navy-900 hover:text-amber-700 hover:underline">
                        {r.rfqNo}
                      </Link>
                    </td>
                    <td>{r.title}</td>
                    <td>{r.siteName}</td>
                    <td className="max-w-[280px] truncate text-muted">
                      {r.lines[0]?.itemName} {r.lines[0]?.spec}
                      {r.lines.length > 1 && ` 외 ${r.lines.length - 1}건`}
                    </td>
                    <td className="text-center">{r.vendorIds.length}</td>
                    <td className="text-center">
                      {qs.length}/{r.vendorIds.length}
                      {pend > 0 && <span className="chip ml-1 bg-violet-50 text-violet-700">반영 대기 {pend}</span>}
                    </td>
                    <td>
                      <span className={`chip ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type Draft = Omit<Rfq, 'id'> & { id?: string };

function RfqDetail({ id }: { id: string }) {
  const nav = useNavigate();
  const { profile } = useAuth();
  const toast = useToast();
  const rfqs = useRfqs();
  const vendors = useVendors();
  const sites = useSites();
  const std = useStdItems(); // 프로그램 기준 품명·규격 (청구서와 같은 목록)
  const priceList = usePriceList();
  const isNew = id === 'new';
  const stored = rfqs.data.find((r) => r.id === id);
  const quotes = useQuotes(isNew ? '__none__' : id);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [vq, setVq] = useState('');
  const [entry, setEntry] = useState<{ vendor: Vendor; lines: Record<string, QuoteLine>; fileName?: string } | null>(null);
  const [pdfVendor, setPdfVendor] = useState<string | null>(null);
  const [newItem, setNewItem] = useState<{ key: string; itemName: string; spec: string; unit: string } | null>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const who = profile?.name ?? '';

  useEffect(() => {
    if (d) return;
    if (isNew && !rfqs.loading) {
      setD({ rfqNo: nextRfqNo(rfqs.data), title: '', scope: 'common', guide: DEFAULT_RFQ_GUIDE, lines: [{ key: lineKey(), itemName: '', spec: '', unit: '', qty: 0 }], vendorIds: [], status: 'draft', createdAt: Date.now(), createdByName: who, updatedAt: Date.now() });
    } else if (stored) setD(structuredClone(stored));
  }, [isNew, rfqs.loading, rfqs.data, stored, d, who]);
  // 저장된 뒤 다른 곳에서 바뀌면 (작성 중이 아닐 때) 최신으로
  useEffect(() => {
    if (stored && d && d.id && stored.updatedAt > d.updatedAt && d.status !== 'draft') setD(structuredClone(stored));
  }, [stored, d]);

  const badCount = d ? d.lines.filter((l) => l.itemName.trim() && !std.isStd(l.itemName, l.spec)).length : 0;
  if (!d) return <div className="text-muted">{rfqs.loading ? '불러오는 중…' : '견적 의뢰서를 찾을 수 없습니다.'}</div>;

  const editable = d.status === 'draft';
  const setLine = (k: string, p: Partial<RfqLine>) => setD({ ...d, lines: d.lines.map((l) => (l.key === k ? { ...l, ...p } : l)) });
  const vName = (vid: string) => vendors.data.find((v) => v.id === vid)?.name ?? vid;
  const unitOf = std.unitOf;
  /** 원래 표기를 기준 품명으로 고친 줄 → 회사 공용 "다른 표기"로 기억 (다음 붙여넣기·청구서 엑셀에서 자동 인식) */
  const learn = async (lines: RfqLine[]) => {
    const seen = new Set<string>();
    const items = lines
      .filter((l) => l.srcItem && std.isStd(l.itemName, l.spec) && aliasKey(l.srcItem, l.srcSpec ?? '') !== aliasKey(l.itemName, l.spec))
      .filter((l) => {
        const k = aliasKey(l.srcItem!, l.srcSpec ?? '');
        if (seen.has(k)) return false;
        seen.add(k);
        const ex = std.aliasMap.get(k);
        return !ex || ex.toItem !== l.itemName || ex.toSpec !== l.spec;
      })
      .map((l) => ({ fromItem: l.srcItem!, fromSpec: l.srcSpec ?? '', toItem: l.itemName, toSpec: l.spec, byName: who }));
    if (items.length) await saveReqAliases(items).catch(() => undefined);
  };

  const save = async (patch: Partial<Rfq> = {}, msg = '저장했습니다.') => {
    const lines = d.lines.filter((l) => l.itemName.trim()).map((l) => ({ ...l, itemName: l.itemName.trim(), spec: l.spec.trim(), unit: l.unit.trim() }));
    if (!lines.length) return toast('품목을 한 줄 이상 넣으세요.', 'err'), null;
    if (patch.status === 'sent' && badCount) return toast(`기준 품명·규격이 아닌 줄이 ${badCount}개 있습니다 (빨간 칸). 목록에서 고르거나 새 품목으로 등록한 뒤 보내세요.`, 'err'), null;
    void learn(lines);
    const rid = d.id ?? newId(C.rfqs);
    const site = sites.data.find((s) => s.id === d.siteId);
    const { id: _x, ...rest } = d;
    void _x;
    const data = { ...rest, lines, siteName: site?.name ?? '', ...(d.scope === 'site' && !d.siteId ? { scope: 'common' as const } : {}), updatedAt: Date.now(), ...patch };
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.rfqs, id: rid, data, merge: false }]);
      setD({ ...data, id: rid });
      if (isNew) nav(`/rfq/${rid}`, { replace: true });
      toast(msg);
      return { ...data, id: rid } as Rfq;
    } catch (e) {
      toast(errMsg(e), 'err');
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** 보내기: 저장 → 업체별 의뢰서 PDF 메일 (이메일 없는 업체는 포털로만) */
  const send = async () => {
    if (!d.vendorIds.length) return toast('보낼 업체를 고르세요.', 'err');
    if (!confirm(`${d.vendorIds.length}개 업체에 견적을 의뢰할까요? 이메일이 있는 업체에는 의뢰서 PDF 메일이 가고, 모든 업체의 포털 "견적 요청"에 나타납니다.`)) return;
    const r = await save({ status: 'sent', sentAt: Date.now() }, '보냈습니다. 업체 포털에 견적 요청이 나타납니다.');
    if (!r) return;
    await audit('견적 의뢰 발송', r.rfqNo, { vendors: r.vendorIds.length });
    const result: string[] = [];
    for (const vid of r.vendorIds) {
      setPdfVendor(vid);
      await new Promise((ok) => setTimeout(ok, 120));
      let pdfBase64 = '';
      try {
        if (pdfRef.current) pdfBase64 = await elementToPdfBase64(pdfRef.current);
      } catch {
        /* PDF가 안 만들어져도 메일은 보낸다 */
      }
      const x = await notify('rfq_sent', { rfqId: r.id, vendorId: vid, pdfBase64 });
      result.push(`${vName(vid)}: ${x.ok ? (x.email === 'sent' ? '메일 보냄' : '이메일 없음(포털만)') : `메일 실패 (${x.error})`}`);
    }
    setPdfVendor(null);
    toast(result.join(' · '), result.some((x) => x.includes('실패')) ? 'err' : undefined);
  };

  const qOf = (vid: string) => quotes.data.find((q) => q.vendorId === vid);
  const submitted = quotes.data.filter((q) => q.status === 'submitted');
  const unapplied = submitted.filter((q) => !q.appliedAt || q.appliedAt < (q.submittedAt ?? 0));

  const apply = async (qs: RfqQuote[]) => {
    if (!qs.length) return;
    setBusy(true);
    try {
      const r = await applyQuotes(d as Rfq, qs, priceList.data, who);
      await audit('견적 단가표 반영', d.rfqNo, r);
      toast(`ERP 단가표에 반영했습니다 — 신규 ${r.added}건, 단가 변경 ${r.changed}건${r.same ? `, 같은 단가 ${r.same}건` : ''}. 구매청구서 단가 자동 채우기에 바로 쓰입니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** 자재부가 업체 견적을 대신 입력 (직접 입력 / 엑셀) → 제출 + 단가표 반영 */
  const saveEntry = async () => {
    if (!entry) return;
    const lines = d.lines.map((l) => ({ key: l.key, price: entry.lines[l.key]?.price || 0, ...(entry.lines[l.key]?.maker ? { maker: entry.lines[l.key].maker } : {}), ...(entry.lines[l.key]?.note ? { note: entry.lines[l.key].note } : {}) }));
    if (!lines.some((l) => l.price > 0)) return toast('단가를 한 줄 이상 넣으세요.', 'err');
    const q: RfqQuote = { id: quoteId(d.id!, entry.vendor.id), rfqId: d.id!, vendorId: entry.vendor.id, vendorName: entry.vendor.name, lines, status: 'submitted', by: 'office', byName: who, ...(entry.fileName ? { fileName: entry.fileName } : {}), submittedAt: Date.now(), updatedAt: Date.now() };
    try {
      const { id: qid, ...data } = q;
      await commitBatch([{ type: 'set', col: C.rfqQuotes, id: qid, data, merge: false }]);
      setEntry(null);
      await apply([q]);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  /** 업체 견적서 엑셀: 품명·규격으로 의뢰 품목과 맞춰 단가·제조사·비고를 읽는다 */
  const readQuoteExcel = async (file: File) => {
    if (!entry) return;
    try {
      const wb = readWorkbook(await file.arrayBuffer());
      const next = { ...entry.lines };
      let hit = 0;
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '' });
        const hi = aoa.findIndex((r) => r.some((c) => /품\s*명|자재\s*명|품\s*목/.test(String(c))));
        if (hi < 0) continue;
        const h = aoa[hi].map((c) => String(c).replace(/\s/g, ''));
        const col = (re: RegExp) => h.findIndex((c) => re.test(c));
        const ci = col(/^(품명|자재명|품목|자재명칭)/);
        const cs = col(/^규격/);
        const cp = col(/^(견적단가|단가|공급단가|납품단가)/);
        const cm = col(/제조|메이커|maker/i);
        const cn = col(/^비고/);
        if (cp < 0) continue;
        for (const r of aoa.slice(hi + 1)) {
          const item = String(r[ci] ?? '').trim();
          if (!item) continue;
          const spec = cs >= 0 ? String(r[cs] ?? '').trim() : '';
          const rec = std.recognize(item, spec);
          const l =
            d.lines.find((x) => itemKey(x.itemName, x.spec) === itemKey(rec.itemName, rec.spec)) ??
            d.lines.find((x) => x.srcItem && itemKey(x.srcItem, x.srcSpec ?? '') === itemKey(item, spec)) ??
            d.lines.find((x) => nameKey(x.itemName) === nameKey(rec.itemName) && !x.spec);
          const price = num(r[cp]);
          if (!l || !(price > 0)) continue;
          next[l.key] = { key: l.key, price, maker: cm >= 0 ? String(r[cm] ?? '').trim() || undefined : next[l.key]?.maker, note: cn >= 0 ? String(r[cn] ?? '').trim() || undefined : next[l.key]?.note };
          hit++;
        }
      }
      setEntry({ ...entry, lines: next, fileName: file.name });
      toast(hit ? `${hit}줄의 단가를 읽었습니다. 확인 후 저장하세요.` : '엑셀에서 맞는 품목·단가를 찾지 못했습니다. (품명·규격·단가 열 필요)', hit ? undefined : 'err');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  /** 견적 비교표 / 업체 회신용 양식 엑셀 */
  const exportExcel = (forVendor?: string) => {
    const vs = forVendor ? [] : d.vendorIds;
    const aoa = [
      [`견적 의뢰서 ${d.rfqNo}`, d.title, d.siteName ? `현장: ${d.siteName}` : '', d.deliveryPlace ? `납품 장소: ${d.deliveryPlace}` : ''],
      [],
      ['No', '품명', '규격', '단위', '수량', ...(forVendor ? ['단가', '제조사', '비고'] : vs.flatMap((v) => [`${vName(v)} 단가`, `${vName(v)} 제조사`])), ...(forVendor ? [] : ['최저가', '최저 업체'])],
      ...d.lines.map((l, i) => {
        const ps = vs.map((v) => qOf(v)?.lines.find((x) => x.key === l.key));
        const valid = vs.map((v, j) => ({ v, p: ps[j]?.price ?? 0 })).filter((x) => x.p > 0 && qOf(x.v)?.status === 'submitted');
        const min = valid.sort((a, b) => a.p - b.p)[0];
        return [i + 1, l.itemName, l.spec, l.unit, l.qty || '', ...(forVendor ? ['', '', ''] : ps.flatMap((p) => [p?.price || '', p?.maker ?? ''])), ...(forVendor ? [] : [min?.p ?? '', min ? vName(min.v) : ''])];
      }),
    ];
    if (forVendor && d.guide) aoa.push([], ['※ 견적 작성 안내'], ...d.guide.split('\n').map((x) => [x]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [5, 26, 16, 6, 8, ...Array(Math.max(3, vs.length * 2 + 2)).fill(12)].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, forVendor ? '견적서' : '견적비교');
    XLSX.writeFile(wb, forVendor ? `견적의뢰서_${d.rfqNo}_${vName(forVendor)}.xlsx` : `견적비교_${d.rfqNo}.xlsx`);
  };

  const vendorList = vendors.data.filter((v) => v.active !== false).filter((v) => !vq || nameKey(v.name).includes(nameKey(vq)) || d.vendorIds.includes(v.id));

  return (
    <div>
      <PageHeader
        title={`견적 의뢰서 ${d.rfqNo}`}
        desc={editable ? '품명·규격은 프로그램 기준(구매청구서와 같은 목록)으로만 넣습니다. 그래야 업체 견적 단가가 청구서 품목에 그대로 연결됩니다. 업체에는 품명·규격·단위·수량과 현장·납품 장소, 안내만 보입니다.' : undefined}
        actions={
          <>
            <Link to="/rfq" className="btn-ghost">
              목록
            </Link>
            {editable ? (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => save()}>
                  저장
                </button>
                <button className="btn-primary" disabled={busy} onClick={send}>
                  업체에 보내기
                </button>
              </>
            ) : (
              <>
                <button className="btn-ghost" onClick={() => exportExcel()}>
                  견적 비교 엑셀
                </button>
                {d.status === 'sent' ? (
                  <button className="btn-ghost" disabled={busy} onClick={() => confirm('견적을 마감할까요? 업체는 더 이상 제출·수정할 수 없습니다.') && save({ status: 'closed' }, '마감했습니다.')}>
                    마감
                  </button>
                ) : (
                  <button className="btn-ghost" disabled={busy} onClick={() => save({ status: 'sent' }, '다시 받기 시작했습니다.')}>
                    마감 풀기
                  </button>
                )}
                {unapplied.length > 0 && (
                  <button className="btn-primary" disabled={busy} onClick={() => apply(unapplied)}>
                    받은 견적 {unapplied.length}건 단가표 반영
                  </button>
                )}
              </>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <div className="col-span-2">
            <Field label="제목">
              <input className="input" disabled={!editable} value={d.title} placeholder="예: 11월 STS 부속 단가" onChange={(e) => setD({ ...d, title: e.target.value })} />
            </Field>
          </div>
          <Field label="현장 (업체에 보임)">
            <select className="input" disabled={!editable} value={d.siteId ?? ''} onChange={(e) => setD({ ...d, siteId: e.target.value || undefined, ...(e.target.value ? {} : { scope: 'common' }) })}>
              <option value="">(현장 지정 안 함)</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="납품 장소 (업체에 보임)">
            <input className="input" disabled={!editable} value={d.deliveryPlace ?? ''} placeholder={sites.data.find((s) => s.id === d.siteId)?.address ?? ''} onChange={(e) => setD({ ...d, deliveryPlace: e.target.value })} />
          </Field>
          <div className="col-span-2">
            <Field label="업체 안내 문구">
              <input className="input" disabled={!editable} value={d.note ?? ''} placeholder="예: VAT 별도, 운반비 포함 단가로" onChange={(e) => setD({ ...d, note: e.target.value })} />
            </Field>
          </div>
          <div className="col-span-2 md:col-span-4">
            <Field label="견적 작성 안내 (업체에 보임 — 의뢰서 PDF·메일·업체 포털)" hint="업체가 품명·규격을 바꿔 적지 않도록 기본 안내가 들어 있습니다. 필요하면 고쳐 쓰세요.">
              <textarea className="input h-28 w-full text-[12.5px] leading-relaxed" disabled={!editable} value={d.guide ?? ''} onChange={(e) => setD({ ...d, guide: e.target.value })} />
              {editable && d.guide !== DEFAULT_RFQ_GUIDE && (
                <button className="mt-1 text-[11.5px] text-sky-700 hover:underline" onClick={() => setD({ ...d, guide: DEFAULT_RFQ_GUIDE })}>
                  기본 안내로 되돌리기
                </button>
              )}
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="받은 단가 적용" hint="받은 견적은 전부 품목·단가(ERP 단가표)에 업체별로 들어갑니다.">
              <div className="flex h-8 items-center gap-4 text-[13px]">
                <label className="flex items-center gap-1">
                  <input type="radio" disabled={!editable} checked={d.scope === 'common'} onChange={() => setD({ ...d, scope: 'common' })} /> 공통 단가 (모든 현장)
                </label>
                <label className={`flex items-center gap-1 ${!d.siteId ? 'text-muted' : ''}`}>
                  <input type="radio" disabled={!editable || !d.siteId} checked={d.scope === 'site'} onChange={() => setD({ ...d, scope: 'site' })} /> 이 현장 예외 단가
                </label>
              </div>
            </Field>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <span className="font-semibold">업체 {d.vendorIds.length}</span>
            {editable && <input className="input ml-auto h-7 w-36" placeholder="업체 검색" value={vq} onChange={(e) => setVq(e.target.value)} />}
          </div>
          <div className="max-h-[230px] overflow-auto px-2 py-1">
            {(editable ? vendorList : vendors.data.filter((v) => d.vendorIds.includes(v.id))).map((v) => {
              const qq = qOf(v.id);
              return (
                <div key={v.id} className="flex items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-canvas">
                  {editable && (
                    <input type="checkbox" checked={d.vendorIds.includes(v.id)} onChange={(e) => setD({ ...d, vendorIds: e.target.checked ? [...d.vendorIds, v.id] : d.vendorIds.filter((x) => x !== v.id) })} />
                  )}
                  <span className="font-medium">{v.name}</span>
                  {!v.email && <span className="text-[10.5px] text-muted">메일 없음</span>}
                  {!editable && (
                    <span className="ml-auto flex items-center gap-1">
                      {qq?.status === 'submitted' ? (
                        <span className="chip bg-emerald-50 text-emerald-700">{qq.by === 'office' ? '대신 입력' : '제출'}</span>
                      ) : qq ? (
                        <span className="chip bg-amber-soft text-amber-800">작성 중</span>
                      ) : (
                        <span className="chip bg-line text-muted">대기</span>
                      )}
                      <button
                        className="text-[11.5px] text-sky-700 hover:underline"
                        onClick={() => setEntry({ vendor: v, lines: Object.fromEntries((qq?.lines ?? []).map((l) => [l.key, l])), fileName: qq?.fileName })}
                      >
                        견적 입력
                      </button>
                      <button className="text-[11.5px] text-muted hover:text-ink" title="업체 회신용 엑셀 양식" onClick={() => exportExcel(v.id)}>
                        양식
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">품목 {d.lines.filter((l) => l.itemName).length}</span>
          {!editable && submitted.length > 0 && <span className="text-[12px] text-muted">업체별 견적 비교 · 최저가는 굵게</span>}
          {editable && (
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setNewItem({ key: '', itemName: '', spec: '', unit: '' })}>
                + 새 품목 등록
              </button>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, lines: [...d.lines, { key: lineKey(), itemName: '', spec: '', unit: '', qty: 0 }] })}>
                + 줄 추가
              </button>
            </div>
          )}
        </div>
        {editable && (
          <div className={`border-b border-line px-4 py-2 text-[12.5px] ${badCount ? 'bg-red-50 text-red-700' : 'bg-canvas text-muted'}`}>
            품목은 한 줄씩 직접 작성합니다 (복사·붙여넣기 안 됨). 품명·규격은 목록에서 고르고, 목록에 없는 품목은 "+ 새 품목 등록" 후 고르세요.
            {badCount > 0 && <b> 기준 품명·규격이 아닌 줄 {badCount}개 (빨간 칸)를 고쳐야 보낼 수 있습니다.</b>}
          </div>
        )}
        <div
          className="overflow-auto"
          // 견적 의뢰 품목은 직접 작성만: 붙여넣기·끌어다 놓기 막음
          onPasteCapture={(e) => {
            if (!editable) return;
            e.preventDefault();
            toast('견적 의뢰서는 붙여넣기를 할 수 없습니다. 목록에서 골라 직접 작성하세요.', 'err');
          }}
          onDropCapture={(e) => editable && e.preventDefault()}
        >
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>품명</th>
                <th>규격</th>
                <th className="w-16">단위</th>
                <th className="num w-20">수량</th>
                {!editable &&
                  d.vendorIds.map((v) => (
                    <th key={v} className="num whitespace-nowrap">
                      {vName(v)}
                    </th>
                  ))}
                {editable && <th className="w-8"></th>}
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l, i) => {
                const prices = d.vendorIds.map((v) => {
                  const q = qOf(v);
                  return q?.status === 'submitted' ? q.lines.find((x) => x.key === l.key) : undefined;
                });
                const min = Math.min(...prices.map((p) => (p?.price ? p.price : Infinity)));
                return (
                  <tr key={l.key}>
                    <td className="text-muted">{i + 1}</td>
                    <td>
                      {editable ? (
                        <PickInput
                          value={l.itemName}
                          options={std.itemOptions}
                          invalid={!!l.itemName && !std.itemOptions.some((x) => nameKey(x) === nameKey(l.itemName))}
                          placeholder="품명 선택 ▾"
                          onPick={(v) => setLine(l.key, { itemName: v, ...(std.specOptions(v).some((x) => itemKey(v, x) === itemKey(v, l.spec)) ? {} : { spec: '' }), unit: unitOf(v, '') || l.unit })}
                        />
                      ) : (
                        <span className="font-medium">{l.itemName}</span>
                      )}
                      {editable && l.srcItem && (
                        <div className="mt-0.5 text-[10.5px] text-muted">
                          원래 표기: {l.srcItem} {l.srcSpec}
                        </div>
                      )}
                      {editable && l.itemName && !std.isStd(l.itemName, l.spec) && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px]">
                          <span className="font-semibold text-red-600">품명·규격 수정 요함</span>
                          {std.suggest(l.srcItem ?? l.itemName, l.srcSpec ?? l.spec).map((c) => (
                            <button
                              key={`${c.i}|${c.s}`}
                              className="rounded border border-sky-200 bg-sky-50 px-1 text-sky-800 hover:bg-sky-100"
                              onClick={() => setLine(l.key, { itemName: c.i, spec: c.s, unit: unitOf(c.i, c.s) || l.unit, srcItem: l.srcItem ?? l.itemName, srcSpec: l.srcSpec ?? l.spec })}
                            >
                              {c.i} {c.s}
                            </button>
                          ))}
                          <button className="text-sky-700 underline" onClick={() => setNewItem({ key: l.key, itemName: l.srcItem ?? l.itemName, spec: l.srcSpec ?? l.spec, unit: l.unit })}>
                            새 품목
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {editable ? (
                        <PickInput
                          value={l.spec}
                          options={std.specOptions(l.itemName)}
                          invalid={!!l.spec && !std.isStd(l.itemName, l.spec)}
                          placeholder={l.itemName ? '규격 ▾' : '품명 먼저'}
                          onPick={(v) => setLine(l.key, { spec: v, unit: unitOf(l.itemName, v) || l.unit })}
                        />
                      ) : (
                        l.spec
                      )}
                    </td>
                    <td>{editable ? <input className="input h-7 w-full px-1.5" value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} /> : l.unit}</td>
                    <td className="num">{editable ? <NumInput className="input h-7 w-full px-1.5 text-right" value={l.qty} onChange={(n) => setLine(l.key, { qty: n })} /> : l.qty ? l.qty.toLocaleString() : ''}</td>
                    {!editable &&
                      prices.map((p, j) => (
                        <td key={j} className={`num whitespace-nowrap ${p?.price && p.price === min ? 'font-bold text-emerald-700' : ''}`} title={[p?.maker, p?.note].filter(Boolean).join(' · ')}>
                          {p?.price ? won(p.price) : ''}
                          {p?.maker && <div className="text-[10.5px] font-normal text-muted">{p.maker}</div>}
                        </td>
                      ))}
                    {editable && (
                      <td>
                        <button className="text-muted hover:text-red-600" onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })}>
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!editable && submitted.length > 0 && (
          <div className="border-t border-line px-4 py-2 text-[12px] text-muted">
            {submitted.map((q) => `${q.vendorName}: ${q.by === 'office' ? `대신 입력(${q.byName ?? ''})` : '포털 제출'} ${q.submittedAt ? new Date(q.submittedAt).toLocaleDateString('ko-KR') : ''}${q.appliedAt && q.appliedAt >= (q.submittedAt ?? 0) ? ' · 단가표 반영됨' : ' · 반영 대기'}`).join('  |  ')}
          </div>
        )}
      </div>

      <Modal
        open={!!entry}
        wide
        title={entry ? `견적 입력 · ${entry.vendor.name}` : ''}
        onClose={() => setEntry(null)}
        footer={
          <>
            <label className="btn-ghost mr-auto cursor-pointer">
              업체 견적서 엑셀 읽기
              <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => (e.target.files?.[0] && readQuoteExcel(e.target.files[0]), (e.target.value = ''))} />
            </label>
            <button className="btn-ghost" onClick={() => setEntry(null)}>
              취소
            </button>
            <button className="btn-primary" disabled={busy} onClick={saveEntry}>
              저장 · 단가표 반영
            </button>
          </>
        }
      >
        {entry && (
          <>
            <div className="mb-2 text-[12.5px] text-muted">
              업체가 메일·팩스로 보낸 견적서를 대신 넣습니다. 엑셀이면 "업체 견적서 엑셀 읽기"로 품명·규격·단가(·제조사·비고) 열을 읽습니다. PDF는 보면서 직접 입력하세요.
              {entry.fileName && <span className="ml-1 text-ink">({entry.fileName})</span>}
            </div>
            <table className="tbl text-[12.5px]">
              <thead>
                <tr>
                  <th>품명</th>
                  <th>규격</th>
                  <th className="num">수량</th>
                  <th className="num w-32">단가</th>
                  <th className="w-32">제조사</th>
                  <th>비고</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => {
                  const cur = entry.lines[l.key] ?? { key: l.key, price: 0 };
                  const set = (p: Partial<QuoteLine>) => setEntry({ ...entry, lines: { ...entry.lines, [l.key]: { ...cur, ...p } } });
                  return (
                    <tr key={l.key}>
                      <td>{l.itemName}</td>
                      <td>{l.spec}</td>
                      <td className="num">{l.qty ? l.qty.toLocaleString() : ''}</td>
                      <td>
                        <NumInput className="input h-7 w-full px-1.5 text-right" value={cur.price} onChange={(n) => set({ price: n })} />
                      </td>
                      <td>
                        <input className="input h-7 w-full px-1.5" value={cur.maker ?? ''} onChange={(e) => set({ maker: e.target.value || undefined })} />
                      </td>
                      <td>
                        <input className="input h-7 w-full px-1.5" value={cur.note ?? ''} onChange={(e) => set({ note: e.target.value || undefined })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Modal>

      <Modal
        open={!!newItem}
        title="새 품목 등록 (프로그램 기준 품명·규격)"
        onClose={() => setNewItem(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setNewItem(null)}>
              취소
            </button>
            <button
              className="btn-primary"
              onClick={async () => {
                if (!newItem?.itemName.trim()) return toast('품명을 입력하세요.', 'err');
                try {
                  const now = Date.now();
                  await commitBatch([{ type: 'set', col: C.items, id: newId(C.items), data: { itemName: newItem.itemName.trim(), spec: newItem.spec.trim(), unit: newItem.unit.trim(), status: 'active', createdAt: now, requestedByName: who, note: `견적 의뢰 ${d.rfqNo}에서 등록` } }]);
                  const old = d.lines.find((x) => x.key === newItem.key);
                  if (!old) {
                    const nl = { key: lineKey(), itemName: newItem.itemName.trim(), spec: newItem.spec.trim(), unit: newItem.unit.trim(), qty: 0 };
                    setD({ ...d, lines: [...d.lines.filter((l) => l.itemName.trim()), nl] });
                    setNewItem(null);
                    toast('품목 목록에 등록하고 의뢰서에 한 줄 추가했습니다. 수량을 넣으세요.');
                    return;
                  }
                  setLine(newItem.key, { itemName: newItem.itemName.trim(), spec: newItem.spec.trim(), unit: newItem.unit.trim(), ...(old && (old.srcItem || aliasKey(old.itemName, old.spec) !== aliasKey(newItem.itemName, newItem.spec)) ? { srcItem: old.srcItem ?? old.itemName, srcSpec: old.srcSpec ?? old.spec } : {}) });
                  setNewItem(null);
                  toast('품목·단가의 품목 목록에 등록했습니다. 청구서에서도 같은 품명으로 씁니다.');
                } catch (e) {
                  toast(errMsg(e), 'err');
                }
              }}
            >
              등록
            </button>
          </>
        }
      >
        {newItem && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 text-[12.5px] text-muted">회사에서 쓸 표기로 고쳐 등록하세요. 등록하면 품목·단가 목록과 구매청구서 품명 목록에 바로 나옵니다.</div>
            <div className="col-span-2">
              <Field label="품명 *">
                <input className="input" value={newItem.itemName} onChange={(e) => setNewItem({ ...newItem, itemName: e.target.value })} />
              </Field>
            </div>
            <Field label="규격">
              <input className="input" value={newItem.spec} onChange={(e) => setNewItem({ ...newItem, spec: e.target.value })} />
            </Field>
            <Field label="단위">
              <input className="input" value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      {pdfVendor && (
        <div style={{ position: 'fixed', left: -10000, top: 0, width: 800, background: '#fff' }} aria-hidden>
          <div ref={pdfRef} className="bg-white p-4">
            <RfqSheet rfq={d as Rfq} vendorName={vName(pdfVendor)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 업체에 보내는 견적 의뢰서 (PDF용) — 품명·규격·단위·수량, 현장·납품 장소, 안내만 */
export function RfqSheet({ rfq, vendorName }: { rfq: Rfq; vendorName: string }) {
  const cell = 'border border-black px-2 py-1';
  const head = `${cell} bg-[#f2f2f2] text-center font-semibold whitespace-nowrap`;
  return (
    <div className="mx-auto w-[760px] bg-white p-6 text-[12px] text-black">
      <div className="mb-4 text-center text-[22px] font-bold tracking-[0.5em] underline underline-offset-[6px]">견적의뢰서</div>
      <table className="w-full border-collapse">
        <tbody>
          {[
            ['수     신', `${vendorName} 귀중`, '견적번호', rfq.rfqNo],
            ['발     신', '㈜ 명 신 기 공', '의 뢰 일', new Date(rfq.sentAt ?? Date.now()).toLocaleDateString('ko-KR')],
            ['현     장', rfq.siteName ?? '', '납품 장소', rfq.deliveryPlace ?? ''],
          ].map((r, i) => (
            <tr key={i}>
              <td className={head}>{r[0]}</td>
              <td className={cell}>{r[1]}</td>
              <td className={head}>{r[2]}</td>
              <td className={cell}>{r[3]}</td>
            </tr>
          ))}
          <tr>
            <td className={`${cell} py-2 text-center`} colSpan={4}>
              아래 품목의 견적을 의뢰하오니 단가를 기입하여 회신하여 주시기 바랍니다.{rfq.note ? ` (${rfq.note})` : ''}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="mt-[-1px] w-full border-collapse">
        <thead>
          <tr>
            <th className={`${head} w-8`}>No</th>
            <th className={head}>품 명</th>
            <th className={head}>규 격</th>
            <th className={`${head} w-12`}>단위</th>
            <th className={`${head} w-16`}>수 량</th>
            <th className={`${head} w-20`}>단 가</th>
            <th className={`${head} w-20`}>제조사</th>
            <th className={head}>비 고</th>
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((l, i) => (
            <tr key={l.key}>
              <td className={`${cell} text-center`}>{i + 1}</td>
              <td className={cell}>{l.itemName}</td>
              <td className={cell}>{l.spec}</td>
              <td className={`${cell} text-center`}>{l.unit}</td>
              <td className={`${cell} text-right`}>{l.qty ? l.qty.toLocaleString() : ''}</td>
              <td className={cell} />
              <td className={cell} />
              <td className={cell} />
            </tr>
          ))}
        </tbody>
      </table>
      {rfq.guide && (
        <div className="mt-3 border border-black px-3 py-2 text-[11px] leading-relaxed">
          <div className="mb-1 font-bold">※ 견적 작성 안내</div>
          {rfq.guide.split('\n').map((x, i) => (
            <div key={i}>{x}</div>
          ))}
        </div>
      )}
      <div className="mt-3 text-right text-[11px] text-gray-600">업체 포털 "견적 요청" 메뉴에서 바로 입력하실 수 있습니다.</div>
    </div>
  );
}
