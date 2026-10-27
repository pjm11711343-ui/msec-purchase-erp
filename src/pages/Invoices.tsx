import { useMemo, useState } from 'react';
import { orderBy, where } from 'firebase/firestore';
import { readWorkbook, parseInvoiceWorkbook, type ParsedInvoiceFile } from '../lib/parsers';
import { audit, commitBatch, fetchWhere, newId, useCollection, useSettings } from '../lib/db';
import { C } from '../lib/firebase';
import { useSiteCategories, useSites, useVendors } from '../lib/hooks';
import { categoryKey, looselyEqual, nameKey, won } from '../lib/normalize';
import { useAuth } from '../auth/AuthContext';
import { autoMatch, matchSummary } from '../lib/matching';
import { usePurchaseOrders } from '../lib/pos';
import { useReceipts } from '../lib/receipts';
import { Link } from 'react-router-dom';
import { Empty, errMsg, Modal, PageHeader, useToast } from '../components/ui';
import type { Invoice, InvoiceLine, LedgerEntry, Site, SiteCategory, Vendor } from '../types';

const NO_CAT = '(분류 없음)';
const NEW_CAT = '__new__';

interface SheetMap {
  siteId: string; // '' = 가져오지 않음
  catMap: Record<string, string>; // 분류 원문 → siteCategoryId ('' = 미분류)
}
interface FileState {
  parsed: ParsedInvoiceFile;
  vendorId: string; // '__new__' = 새 업체로 등록
  vendorName: string;
  month: string;
  sheets: SheetMap[];
}

function guessSite(sites: Site[], sheetName: string, label: string): string {
  const cands = [sheetName, label, sheetName.replace(/\(.*\)$/, '')];
  const trade = /소방/.test(sheetName + label) ? '소방' : /기계/.test(sheetName + label) ? '기계' : undefined;
  const hit = sites.filter((s) =>
    cands.some((c) => c && (looselyEqual(s.name, c) || s.aliases?.some((a) => nameKey(a) === nameKey(c)) || looselyEqual(s.groupName ?? '', c))),
  );
  if (hit.length > 1 && trade) return hit.find((s) => s.trade === trade)?.id ?? hit[0].id;
  return hit[0]?.id ?? '';
}

function guessCat(cats: SiteCategory[], text: string): string {
  if (text === NO_CAT) return '';
  const nk = nameKey(text);
  const byAlias = cats.find((c) => nameKey(c.name) === nk || c.aliases?.some((a) => nameKey(a) === nk));
  if (byAlias) return byAlias.id;
  const ck = categoryKey(text);
  return cats.find((c) => categoryKey(c.name) === ck)?.id ?? '';
}

function findVendor(vendors: Vendor[], name: string): Vendor | undefined {
  const k = nameKey(name);
  return vendors.find((v) => nameKey(v.name) === k || v.aliases?.some((a) => nameKey(a) === k));
}

export default function Invoices() {
  const settings = useSettings();
  const { profile } = useAuth();
  const sites = useSites();
  const vendors = useVendors();
  const cats = useSiteCategories();
  const toast = useToast();
  const pos = usePurchaseOrders();
  const receipts = useReceipts();
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);
  const [filterMonth, setFilterMonth] = useState('');
  const invoices = useCollection<Invoice>(
    C.invoices,
    filterMonth ? [where('month', '==', filterMonth)] : [orderBy('uploadedAt', 'desc')],
    filterMonth,
  );
  const [detail, setDetail] = useState<Invoice | null>(null);

  const catsOf = (siteId: string) => cats.data.filter((c) => c.siteId === siteId).sort((a, b) => a.order - b.order);

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const added: FileState[] = [];
    for (const file of Array.from(list)) {
      try {
        const parsed = parseInvoiceWorkbook(readWorkbook(await file.arrayBuffer()), file.name);
        const v = findVendor(vendors.data, parsed.vendorName);
        added.push({
          parsed,
          vendorId: v?.id ?? '__new__',
          vendorName: parsed.vendorName,
          month: parsed.month,
          sheets: parsed.sheets.map((s) => {
            const siteId = guessSite(sites.data, s.sheetName, s.siteLabel);
            const catMap: Record<string, string> = {};
            s.categories.forEach((c) => (catMap[c.text] = siteId ? guessCat(catsOf(siteId), c.text) : ''));
            return { siteId, catMap };
          }),
        });
      } catch (e) {
        toast(`${file.name}: ${errMsg(e)}`, 'err');
      }
    }
    setFiles((f) => [...f, ...added]);
  };

  const update = (fi: number, fn: (f: FileState) => FileState) => setFiles((fs) => fs.map((f, i) => (i === fi ? fn(f) : f)));

  const save = async () => {
    for (const f of files) {
      if (!f.month) return toast(`${f.parsed.fileName}: 계산서 월을 입력하세요.`, 'err');
      if (f.vendorId === '__new__' && !f.vendorName.trim()) return toast(`${f.parsed.fileName}: 업체명을 입력하세요.`, 'err');
    }
    setBusy(true);
    try {
      type Op = Parameters<typeof commitBatch>[0][number];
      const ops: Op[] = [];
      const invoiceDocs = new Map<string, Invoice>();
      const ledgerByInvoice = new Map<string, Map<string, number>>();
      const siteAlias = new Map<string, Set<string>>();
      const catAlias = new Map<string, Set<string>>();
      const now = Date.now();
      // "+ 새 현장분류" 로 고른 분류를 먼저 만든다 (같은 현장·같은 이름은 하나만)
      const created = new Map<string, string>();
      for (const f of files)
        f.sheets.forEach((m) => {
          if (!m.siteId) return;
          for (const [text, cid] of Object.entries(m.catMap)) {
            if (cid !== NEW_CAT) continue;
            const key = `${m.siteId}|${nameKey(text)}`;
            if (!created.has(key)) {
              const id = newId(C.siteCategories);
              created.set(key, id);
              const order = cats.data.filter((x) => x.siteId === m.siteId).length + created.size;
              const data: Omit<SiteCategory, 'id'> = { siteId: m.siteId, name: text, aliases: [], order, contractAmount: 0, changeAmount: 0, execAmount: 0, migratedInput: 0, migratedMonth: settings.cutoffMonth };
              ops.push({ type: 'set', col: C.siteCategories, id, data });
            }
            m.catMap[text] = created.get(key)!;
          }
        });

      for (const f of files) {
        let vendorId = f.vendorId;
        let vendorName = f.vendorName.trim();
        if (vendorId === '__new__') {
          const ex = findVendor(vendors.data, vendorName);
          vendorId = ex?.id ?? newId(C.vendors);
          if (!ex) ops.push({ type: 'set', col: C.vendors, id: vendorId, data: { name: vendorName, aliases: [], active: true } });
        } else vendorName = vendors.data.find((v) => v.id === vendorId)?.name ?? vendorName;
        const applied = f.month > settings.cutoffMonth;

        f.parsed.sheets.forEach((s, si) => {
          const m = f.sheets[si];
          if (!m.siteId) return;
          const invId = `${f.month}_${vendorId}_${m.siteId}`;
          const lines: InvoiceLine[] = s.lines.map((l) => {
            const cid = m.catMap[l.categoryText || NO_CAT];
            return { ...l, ...(cid ? { siteCategoryId: cid } : {}), matchStatus: applied ? 'unmatched' : 'migrated' };
          });
          const prev = invoiceDocs.get(invId);
          const inv: Invoice = prev
            ? { ...prev, lines: [...prev.lines, ...lines], sheetName: `${prev.sheetName}, ${s.sheetName}` }
            : {
                id: invId,
                month: f.month,
                vendorId,
                vendorName,
                siteId: m.siteId,
                sheetName: s.sheetName,
                source: 'excel',
                fileName: f.parsed.fileName,
                totalAmount: 0,
                lineCount: 0,
                appliedToLedger: applied,
                lines: [],
                uploadedBy: profile?.name ?? '',
                uploadedAt: now,
              };
          if (!prev) inv.lines = lines;
          inv.totalAmount = inv.lines.reduce((a, l) => a + l.finalAmount, 0);
          inv.lineCount = inv.lines.length;
          invoiceDocs.set(invId, inv);

          if (applied) {
            const agg = ledgerByInvoice.get(invId) ?? new Map<string, number>();
            for (const l of lines) if (l.siteCategoryId) agg.set(l.siteCategoryId, (agg.get(l.siteCategoryId) ?? 0) + l.finalAmount);
            ledgerByInvoice.set(invId, agg);
          }
          // 별칭 학습
          const sa = siteAlias.get(m.siteId) ?? new Set<string>();
          sa.add(s.sheetName);
          if (s.siteLabel) sa.add(s.siteLabel);
          siteAlias.set(m.siteId, sa);
          for (const [text, cid] of Object.entries(m.catMap)) {
            if (!cid || text === NO_CAT) continue;
            const ca = catAlias.get(cid) ?? new Set<string>();
            ca.add(text);
            catAlias.set(cid, ca);
          }
        });
      }

      // 같은 월·업체·현장을 다시 올리면 이전 원장 기록을 지운다
      for (const invId of invoiceDocs.keys()) {
        const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', invId);
        old.forEach((e) => ops.push({ type: 'delete', col: C.ledger, id: e.id }));
      }
      for (const inv of invoiceDocs.values()) {
        // 5단계: 기준월 이후 계산서는 발주·입고와 자동매칭 (분류가 비면 발주 줄 분류를 씀)
        if (inv.appliedToLedger) {
          const others = await fetchWhere<Invoice>(C.invoices, 'vendorId', inv.vendorId);
          inv.lines = autoMatch(inv, pos.data, receipts.data, others, settings.priceTolerance);
          const agg2 = new Map<string, number>();
          inv.lines.forEach((l) => l.siteCategoryId && agg2.set(l.siteCategoryId, (agg2.get(l.siteCategoryId) ?? 0) + l.finalAmount));
          ledgerByInvoice.set(inv.id, agg2);
        }
        const { id, ...data } = inv;
        ops.push({ type: 'set', col: C.invoices, id, data, merge: false });
        const agg = ledgerByInvoice.get(id);
        agg?.forEach((amount, cid) => {
          const e: Omit<LedgerEntry, 'id'> = {
            siteId: inv.siteId,
            siteCategoryId: cid,
            month: inv.month,
            amount: Math.round(amount),
            source: 'invoice',
            invoiceId: id,
            createdAt: now,
          };
          ops.push({ type: 'set', col: C.ledger, id: `${id}__${cid}`, data: e, merge: false });
        });
      }
      siteAlias.forEach((set, siteId) => {
        const s = sites.data.find((x) => x.id === siteId);
        if (!s) return;
        const merged = new Set([...(s.aliases ?? []), ...[...set].filter((a) => nameKey(a) !== nameKey(s.name))]);
        if (merged.size !== (s.aliases ?? []).length) ops.push({ type: 'set', col: C.sites, id: siteId, data: { aliases: [...merged] } });
      });
      catAlias.forEach((set, cid) => {
        const c = cats.data.find((x) => x.id === cid);
        if (!c) return;
        const merged = new Set([...(c.aliases ?? []), ...[...set].filter((a) => nameKey(a) !== nameKey(c.name))]);
        if (merged.size !== (c.aliases ?? []).length) ops.push({ type: 'set', col: C.siteCategories, id: cid, data: { aliases: [...merged] } });
      });

      await commitBatch(ops);
      await audit('계산서정리 업로드', files.map((f) => f.parsed.fileName).join(', '), { invoices: invoiceDocs.size });
      toast(`계산서 ${invoiceDocs.size}건을 저장했습니다.`);
      setFiles([]);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeInvoice = async (inv: Invoice) => {
    if (!confirm(`${inv.month} ${inv.vendorName} · ${siteName(inv.siteId)} 계산서를 삭제할까요? 투입원장에서도 빠집니다.`)) return;
    try {
      const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', inv.id);
      await commitBatch([...old.map((e) => ({ type: 'delete' as const, col: C.ledger, id: e.id })), { type: 'delete', col: C.invoices, id: inv.id }]);
      await audit('계산서 삭제', inv.id);
      toast('삭제했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const siteName = (id: string) => sites.data.find((s) => s.id === id)?.name ?? '(삭제된 현장)';
  const catName = (id?: string) => cats.data.find((c) => c.id === id)?.name;
  const unmappedCount = (inv: Invoice) => inv.lines.filter((l) => !l.siteCategoryId).length;

  const months = useMemo(() => {
    const s = new Set(invoices.data.map((i) => i.month));
    if (filterMonth) s.add(filterMonth);
    return [...s].sort().reverse();
  }, [invoices.data, filterMonth]);

  return (
    <div>
      <PageHeader
        title="계산서"
        desc={`월 계산서정리 엑셀(업체별)을 올리면 현장·분류별로 나눠 저장합니다. ${settings.cutoffMonth} 이후 월만 투입원장에 더해집니다.`}
        actions={
          <>
            <label className="btn-ghost cursor-pointer">
              계산서정리 파일 선택
              <input type="file" accept=".xlsx,.xls" multiple hidden onChange={(e) => (onFiles(e.target.files), (e.target.value = ''))} />
            </label>
            {files.length > 0 && (
              <button className="btn-primary" disabled={busy} onClick={save}>
                {busy ? '저장 중…' : `저장 (파일 ${files.length}개)`}
              </button>
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-col gap-4">
        {files.map((f, fi) => {
          const applied = f.month > settings.cutoffMonth;
          return (
            <div key={fi} className="card fade-up overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[#fafbfc] px-5 py-3">
                <span className="font-semibold">{f.parsed.fileName}</span>
                <span className="text-muted">업체</span>
                <select className="input h-7 w-44" value={f.vendorId} onChange={(e) => update(fi, (x) => ({ ...x, vendorId: e.target.value }))}>
                  <option value="__new__">+ 새 업체로 등록</option>
                  {vendors.data.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                {f.vendorId === '__new__' && (
                  <input className="input h-7 w-36" value={f.vendorName} onChange={(e) => update(fi, (x) => ({ ...x, vendorName: e.target.value }))} />
                )}
                <span className="text-muted">월</span>
                <input className="input h-7 w-28" type="month" value={f.month} onChange={(e) => update(fi, (x) => ({ ...x, month: e.target.value }))} />
                <span className={`chip ${applied ? 'bg-emerald-50 text-emerald-700' : 'bg-line text-muted'}`}>
                  {applied ? '투입원장 반영' : `기준월(${settings.cutoffMonth}) 이전 · 기록만 저장`}
                </span>
                <button className="btn-ghost ml-auto h-7 text-[12px]" onClick={() => setFiles((fs) => fs.filter((_, i) => i !== fi))}>
                  빼기
                </button>
              </div>
              {f.parsed.warnings.map((w, i) => (
                <div key={i} className="border-b border-line bg-amber-soft px-5 py-1.5 text-[12px]">
                  ⚠ {w}
                </div>
              ))}
              <table className="tbl">
                <thead>
                  <tr>
                    <th>거래명세서 시트 (현장 표기)</th>
                    <th>ERP 현장</th>
                    <th className="num">줄</th>
                    <th className="num">금액</th>
                    <th>분류 → 현장분류</th>
                  </tr>
                </thead>
                <tbody>
                  {f.parsed.sheets.map((s, si) => {
                    const m = f.sheets[si];
                    const setM = (patch: Partial<SheetMap>) =>
                      update(fi, (x) => ({ ...x, sheets: x.sheets.map((y, j) => (j === si ? { ...y, ...patch } : y)) }));
                    const siteCats = catsOf(m.siteId);
                    return (
                      <tr key={s.sheetName} className={m.siteId ? '' : 'opacity-60'}>
                        <td className="align-top">
                          <div className="font-medium">{s.sheetName}</div>
                          <div className="text-[11.5px] text-muted">{s.siteLabel}</div>
                        </td>
                        <td className="align-top">
                          <select
                            className={`input h-7 w-48 ${m.siteId ? '' : 'border-amber-brand'}`}
                            value={m.siteId}
                            onChange={(e) => {
                              const siteId = e.target.value;
                              const catMap: Record<string, string> = {};
                              s.categories.forEach((c) => (catMap[c.text] = siteId ? guessCat(catsOf(siteId), c.text) : ''));
                              setM({ siteId, catMap });
                            }}
                          >
                            <option value="">가져오지 않음</option>
                            {sites.data.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.code} {x.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="num align-top">{s.lines.length}</td>
                        <td className="num align-top">{won(s.total)}</td>
                        <td>
                          {m.siteId &&
                            s.categories.map((c) => (
                              <div key={c.text} className="flex items-center gap-2 py-0.5">
                                <span className="w-40 truncate" title={c.text}>
                                  {c.text}
                                </span>
                                <span className="w-24 text-right text-[11.5px] tabular-nums text-muted">{won(c.amount)}</span>
                                <span className="text-muted">→</span>
                                <select
                                  className={`input h-7 w-52 ${m.catMap[c.text] ? '' : 'border-amber-brand bg-amber-soft'}`}
                                  value={m.catMap[c.text] ?? ''}
                                  onChange={(e) => setM({ catMap: { ...m.catMap, [c.text]: e.target.value } })}
                                >
                                  <option value="">미분류 (원장 제외)</option>
                                  {c.text !== NO_CAT && <option value={NEW_CAT}>+ 새 현장분류 "{c.text}"</option>}
                                  {siteCats.map((sc) => (
                                    <option key={sc.id} value={sc.id}>
                                      {sc.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">저장된 계산서</span>
          <select className="input ml-auto h-7" value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)}>
            <option value="">최근 업로드순</option>
            {months.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        {invoices.data.length === 0 ? (
          <Empty>{invoices.loading ? '불러오는 중…' : '저장된 계산서가 없습니다.'}</Empty>
        ) : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>월</th>
                  <th>업체</th>
                  <th>현장</th>
                  <th className="num">줄</th>
                  <th className="num">금액</th>
                  <th>원장</th>
                  <th>미분류</th>
                  <th>발주 매칭</th>
                  <th>올린 사람</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.data.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.month}</td>
                    <td>{inv.vendorName}</td>
                    <td>{siteName(inv.siteId)}</td>
                    <td className="num">{inv.lineCount}</td>
                    <td className="num">{won(inv.totalAmount)}</td>
                    <td>{inv.appliedToLedger ? <span className="chip bg-emerald-50 text-emerald-700">반영</span> : <span className="chip bg-line text-muted">기록만</span>}</td>
                    <td>{unmappedCount(inv) ? <span className="chip bg-amber-soft text-amber-800">{unmappedCount(inv)}줄</span> : '-'}</td>
                    <td>
                      {inv.submitted ? (
                        <span className="chip bg-amber-brand text-navy-950">업체 제출 · 반영 대기</span>
                      ) : inv.appliedToLedger ? (
                        (() => {
                          const m = matchSummary(inv);
                          const bad = m.total - m.ok;
                          return <span className={`chip ${bad ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{m.ok}/{m.total}{bad ? ` · 확인 ${bad}` : ''}</span>;
                        })()
                      ) : (
                        <span className="text-[12px] text-muted">-</span>
                      )}
                    </td>
                    <td className="text-muted">{inv.uploadedBy}</td>
                    <td className="whitespace-nowrap text-right">
                      <Link to={`/invoices/${inv.id}`} className="btn-dark h-7 text-[12px]">
                        매칭
                      </Link>{' '}
                      <button className="btn-ghost h-7 text-[12px]" onClick={() => setDetail(inv)}>
                        내역
                      </button>{' '}
                      <button className="btn-danger h-7 text-[12px]" onClick={() => removeInvoice(inv)}>
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!detail} title={detail ? `${detail.month} ${detail.vendorName} · ${siteName(detail.siteId)}` : ''} onClose={() => setDetail(null)} wide>
        {detail && (
          <table className="tbl">
            <thead>
              <tr>
                <th>입고일</th>
                <th>발주일</th>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th className="num">수량</th>
                <th className="num">단가</th>
                <th className="num">확정금액</th>
                <th>분류 원문</th>
                <th>현장분류</th>
                <th>공정</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap">{l.receivedDate ?? ''}</td>
                  <td className="whitespace-nowrap">{l.orderDate ?? ''}</td>
                  <td>{l.itemName}</td>
                  <td>{l.spec}</td>
                  <td>{l.unit}</td>
                  <td className="num">{(l.changedQty ?? l.qty).toLocaleString()}</td>
                  <td className="num">{won(l.changedPrice ?? l.unitPrice)}</td>
                  <td className="num">{won(l.finalAmount)}</td>
                  <td className="text-muted">{l.categoryText}</td>
                  <td>{catName(l.siteCategoryId) ?? <span className="text-amber-700">미분류</span>}</td>
                  <td className="text-muted">{l.process ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}
