import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites, useVendors } from '../../lib/hooks';
import { won } from '../../lib/normalize';
import { nextPoNo, pendingLines, preOrderState, usePurchaseOrders, type PendingLine, type PreState } from '../../lib/pos';
import { useRequisitions } from '../../lib/reqs';
import { decidePrices, usePoPrices, type PoPrice } from '../../lib/poPrices';
import { Empty, errMsg, PageHeader, useSelection, useToast } from '../../components/ui';
import { PO_STATUS_LABEL, type PoLine, type PoStatus, type PurchaseOrder } from '../../types';

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function PoChip({ s }: { s: PoStatus }) {
  const c = s === 'sent' ? 'bg-emerald-50 text-emerald-700' : s === 'cancelled' ? 'bg-line text-muted line-through' : 'bg-amber-soft text-amber-800';
  return <span className={`chip ${c}`}>{PO_STATUS_LABEL[s]}</span>;
}

/** 선발주 표시: 청구서 결재가 어디까지 왔는지 */
export function PreChip({ s }: { s?: PreState }) {
  if (!s) return null;
  const [c, t] =
    s === 'approved'
      ? ['bg-emerald-50 text-emerald-700', '선발주 · 승인 완료']
      : s === 'rejected'
        ? ['bg-red-50 text-red-700', '선발주 · 청구 반려']
        : s === 'draft'
          ? ['bg-red-50 text-red-700', '선발주 · 청구 회수됨']
          : ['bg-violet-50 text-violet-700', '선발주 · 결재 중'];
  return <span className={`chip ${c}`}>{t}</span>;
}

const PRE_KEY = 'po.withPre';

export default function PoList() {
  const { profile, can } = useAuth();
  const isOffice = can('admin', 'material');
  const reqs = useRequisitions();
  const pos = usePurchaseOrders();
  const sites = useSites();
  const vendors = useVendors();
  const toast = useToast();
  const { sel, toggle, setAll, clear } = useSelection();
  const [tab, setTab] = useState<'pending' | 'list' | 'price'>(isOffice ? 'pending' : 'list');
  const prices = usePoPrices();
  const priceReqs = useMemo(() => prices.data.filter((p) => p.kind === 'change' && p.status === 'pending').sort((a, b) => b.at - a.at), [prices.data]);
  const priceDone = useMemo(() => prices.data.filter((p) => p.applied).sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0)).slice(0, 50), [prices.data]);
  const [rejNote, setRejNote] = useState<Record<string, string>>({});
  const decide = async (list: PoPrice[], ok: boolean) => {
    if (!list.length) return;
    if (!ok && list.some((p) => !rejNote[p.id]?.trim())) return toast('거절 사유를 적어 주세요.', 'err');
    setBusy(true);
    try {
      await decidePrices(pos.data, list.map((p) => ({ p, ok, ...(ok ? {} : { note: rejNote[p.id].trim() }) })), profile?.name ?? '');
      await audit(ok ? '업체 단가 변경 승인' : '업체 단가 변경 거절', list.map((p) => `${p.poNo} ${p.itemName}`).join(', '));
      toast(ok ? `${list.length}건 단가를 바꿨습니다.` : `${list.length}건 거절했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const [vendorPick, setVendorPick] = useState<Record<string, string>>({}); // 거래선 미지정 줄 → 업체
  const [siteF, setSiteF] = useState('');
  const [statusF, setStatusF] = useState<'' | PoStatus>('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // 선발주: 결재 중인 청구서 줄도 발주 대기에 보이기 (자재부·관리자)
  const [withPre, setWithPreState] = useState(() => {
    try {
      return localStorage.getItem(PRE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setWithPre = (v: boolean) => {
    setWithPreState(v);
    try {
      localStorage.setItem(PRE_KEY, v ? '1' : '0');
    } catch {
      /* 무시 */
    }
  };

  const pend = useMemo(() => pendingLines(reqs.data, pos.data, isOffice && withPre), [reqs.data, pos.data, isOffice, withPre]);
  const preCount = useMemo(() => (isOffice ? pendingLines(reqs.data, pos.data, true).filter((p) => p.pre).length : 0), [reqs.data, pos.data, isOffice]);
  const vendorOf = (p: PendingLine) => vendorPick[p.key] ?? p.line.vendorId ?? '';

  // 현장 → 업체 → 줄
  const groups = useMemo(() => {
    const m = new Map<string, Map<string, PendingLine[]>>();
    for (const p of pend) {
      if (siteF && p.req.siteId !== siteF) continue;
      const s = m.get(p.req.siteId) ?? new Map<string, PendingLine[]>();
      const v = vendorOf(p) || '__none__';
      s.set(v, [...(s.get(v) ?? []), p]);
      m.set(p.req.siteId, s);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pend, vendorPick, siteF]);

  const siteName = (id: string) => sites.data.find((s) => s.id === id)?.name ?? id;
  const vendorName = (id: string) => vendors.data.find((v) => v.id === id)?.name ?? '거래선 미지정';

  const create = async () => {
    const chosen = pend.filter((p) => sel.has(p.key));
    if (!chosen.length) return toast('발주할 줄을 고르세요.', 'err');
    const noVendor = chosen.filter((p) => !vendorOf(p));
    if (noVendor.length) return toast(`거래선이 없는 줄이 ${noVendor.length}개 있습니다. 거래선을 고르세요.`, 'err');
    const preN = chosen.filter((p) => p.pre).length;
    if (preN && !confirm(`결재가 끝나지 않은 청구서 줄 ${preN}개를 선발주합니다.\n발주서에 '선발주'로 표시되고, 청구서가 승인되면 '승인 완료'로 바뀝니다.\n계속할까요?`)) return;
    setBusy(true);
    try {
      const byKey = new Map<string, PendingLine[]>();
      chosen.forEach((p) => {
        const k = `${p.req.siteId}|${vendorOf(p)}`;
        byKey.set(k, [...(byKey.get(k) ?? []), p]);
      });
      const date = today();
      const taken = new Set<string>();
      const ops: Parameters<typeof commitBatch>[0] = [];
      const made: string[] = [];
      for (const [k, list] of byKey) {
        const [siteId, vendorId] = k.split('|');
        const site = sites.data.find((s) => s.id === siteId);
        const v = vendors.data.find((x) => x.id === vendorId);
        const poNo = nextPoNo(pos.data, site?.code ?? 'PO', date, taken);
        taken.add(poNo);
        const lines: PoLine[] = list.map(({ req, line }) => {
          const qty = line.orderQty || line.reqQty;
          return {
            reqId: req.id,
            reqDocNo: req.docNo,
            lineKey: line.key,
            itemName: line.itemName,
            spec: line.spec,
            unit: line.unit,
            qty,
            price: line.orderPrice || 0,
            amount: Math.round(qty * (line.orderPrice || 0)),
            remark: line.remark,
            dueDate: line.dueDate,
            location: line.location,
            siteCategoryId: line.siteCategoryId,
          };
        });
        const firstReq = list[0].req;
        const pre = list.some((p) => p.pre);
        const po: Omit<PurchaseOrder, 'id'> = {
          poNo,
          siteId,
          siteName: site?.name ?? '',
          vendorId,
          vendorName: v?.name ?? '',
          vendorPhone: v?.phone,
          vendorEmail: v?.email,
          orderDate: date,
          deliveryTerm: '현장 협의 후',
          notice: '발주서 받을시 본사 담당자와 확인 후 입고해주세요.',
          reqIds: [...new Set(list.map((p) => p.req.id))],
          reqDocNos: [...new Set(list.map((p) => p.req.docNo).filter(Boolean))],
          lines,
          totalAmount: lines.reduce((a, l) => a + l.amount, 0),
          status: 'issued',
          orderedBy: profile?.id ?? '',
          orderedByName: [profile?.name, profile?.position].filter(Boolean).join(' '),
          signNames: firstReq.steps.map((s) => ({ label: s.label, name: s.userName })),
          ...(pre ? { preOrder: true } : {}),
          createdAt: Date.now(),
          history: [{ at: Date.now(), by: profile?.name ?? '', action: pre ? '선발주 (청구서 결재 중)' : '발주서 생성' }],
        };
        ops.push({ type: 'set', col: C.purchaseOrders, id: newId(C.purchaseOrders), data: po, merge: false });
        made.push(`${poNo} ${v?.name}${pre ? ' (선발주)' : ''}`);
      }
      await commitBatch(ops);
      await audit('발주서 생성', made.join(', '));
      toast(`발주서 ${made.length}건을 만들었습니다.`);
      clear();
      setTab('list');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const listShown = useMemo(() => {
    let l = pos.data;
    if (siteF) l = l.filter((p) => p.siteId === siteF);
    if (statusF) l = l.filter((p) => p.status === statusF);
    const k = q.trim().toLowerCase();
    if (k) l = l.filter((p) => [p.poNo, p.vendorName, p.siteName, ...p.reqDocNos, ...p.lines.map((x) => x.itemName)].join(' ').toLowerCase().includes(k));
    return l;
  }, [pos.data, siteF, statusF, q]);

  const selectedTotal = pend.filter((p) => sel.has(p.key)).reduce((a, p) => a + (p.line.orderQty || p.line.reqQty) * (p.line.orderPrice || 0), 0);

  return (
    <div>
      <PageHeader
        title="발주"
        desc="승인된 구매청구 품목을 현장·거래선별로 묶어 발주서를 만듭니다. 자재부·관리자는 결재 중인 청구서도 선발주할 수 있습니다. 발주서는 원 양식대로 인쇄하거나 PDF로 저장해 보내세요."
        actions={
          tab === 'pending' &&
          isOffice && (
            <button className="btn-primary" disabled={busy || !sel.size} onClick={create}>
              {busy ? '만드는 중…' : `선택 ${sel.size}줄 발주서 만들기${selectedTotal ? ` (${won(selectedTotal)}원)` : ''}`}
            </button>
          )
        }
      />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {isOffice && (
            <button className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === 'pending' ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`} onClick={() => setTab('pending')}>
              발주 대기 <span className="ml-1 rounded-full bg-amber-brand px-1.5 text-[11px] text-navy-950">{pend.length}</span>
            </button>
          )}
          <button className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === 'list' ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`} onClick={() => setTab('list')}>
            발주서 목록
          </button>
          {isOffice && (
            <button className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === 'price' ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`} onClick={() => setTab('price')}>
              업체 단가 요청
              {priceReqs.length > 0 && <span className="ml-1 rounded-full bg-violet-600 px-1.5 text-[11px] text-white">{priceReqs.length}</span>}
            </button>
          )}
          {isOffice && tab === 'pending' && (
            <label className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] ${withPre ? 'bg-violet-50 text-violet-800' : 'text-muted'}`} title="결재가 끝나기 전의 청구서 줄도 먼저 발주합니다 (자재부·관리자)">
              <input type="checkbox" checked={withPre} onChange={(e) => setWithPre(e.target.checked)} />
              결재 중 청구서도 보기 (선발주){preCount ? ` · ${preCount}줄` : ''}
            </label>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <select className="input h-7" value={siteF} onChange={(e) => setSiteF(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {tab === 'list' && (
              <>
                <select className="input h-7" value={statusF} onChange={(e) => setStatusF(e.target.value as PoStatus | '')}>
                  <option value="">전체 상태</option>
                  {(Object.keys(PO_STATUS_LABEL) as PoStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {PO_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <input className="input h-7 w-48" placeholder="발주번호·업체·품명" value={q} onChange={(e) => setQ(e.target.value)} />
              </>
            )}
          </div>
        </div>

        {tab === 'price' ? (
          <div className="max-h-[calc(100vh-220px)] overflow-auto">
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="font-semibold">단가 변경 요청 {priceReqs.length}건</span>
              <span className="text-[12px] text-muted">업체가 발주서 단가를 바꿔 달라고 요청한 것입니다. 승인하면 발주서 단가가 바뀝니다.</span>
              {priceReqs.length > 1 && (
                <button className="btn-primary ml-auto h-7 text-[12px]" disabled={busy} onClick={() => confirm(`${priceReqs.length}건을 모두 승인할까요?`) && decide(priceReqs, true)}>
                  모두 승인
                </button>
              )}
            </div>
            {!priceReqs.length ? (
              <Empty>승인 대기 중인 단가 변경 요청이 없습니다.</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>요청일</th>
                    <th>발주번호</th>
                    <th>현장</th>
                    <th>업체</th>
                    <th>품명</th>
                    <th>규격</th>
                    <th className="num">수량</th>
                    <th className="num">지금 단가</th>
                    <th className="num">요청 단가</th>
                    <th className="num">차이</th>
                    <th>사유</th>
                    <th className="w-[260px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {priceReqs.map((p) => {
                    const po = pos.data.find((x) => x.id === p.poId);
                    const cur = po?.lines.find((l) => `${l.reqId}|${l.lineKey}` === p.lineKey)?.price ?? p.oldPrice;
                    const diff = p.price - cur;
                    return (
                      <tr key={p.id}>
                        <td className="whitespace-nowrap">{new Date(p.at).toLocaleDateString('ko-KR')}</td>
                        <td>
                          <Link to={`/po/${p.poId}`} className="font-semibold text-navy-900 hover:underline">
                            {p.poNo}
                          </Link>
                        </td>
                        <td>{p.siteName}</td>
                        <td>{p.vendorName}</td>
                        <td>{p.itemName}</td>
                        <td>{p.spec}</td>
                        <td className="num">{p.qty.toLocaleString()}</td>
                        <td className="num">{won(cur)}</td>
                        <td className="num font-semibold">{won(p.price)}</td>
                        <td className={`num ${diff > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                          {diff > 0 ? '+' : ''}
                          {won(diff)}
                          {cur ? <span className="ml-1 text-[11px]">({diff > 0 ? '+' : ''}{((diff / cur) * 100).toFixed(1)}%)</span> : null}
                        </td>
                        <td className="text-muted">{p.note}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <input className="input h-7 w-28 px-1.5 text-[12px]" placeholder="거절 사유" value={rejNote[p.id] ?? ''} onChange={(e) => setRejNote((m) => ({ ...m, [p.id]: e.target.value }))} />
                            <button className="btn-ghost h-7 text-[12px]" disabled={busy} onClick={() => decide([p], false)}>
                              거절
                            </button>
                            <button className="btn-primary h-7 text-[12px]" disabled={busy} onClick={() => decide([p], true)}>
                              승인
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {priceDone.length > 0 && (
              <>
                <div className="border-t border-line px-4 py-2 font-semibold">최근 처리 (업체 기입·승인·거절)</div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>처리일</th>
                      <th>구분</th>
                      <th>발주번호</th>
                      <th>업체</th>
                      <th>품명</th>
                      <th>규격</th>
                      <th className="num">전 단가</th>
                      <th className="num">단가</th>
                      <th>결과</th>
                      <th>처리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceDone.map((p) => (
                      <tr key={p.id}>
                        <td className="whitespace-nowrap">{p.appliedAt ? new Date(p.appliedAt).toLocaleDateString('ko-KR') : ''}</td>
                        <td>{p.kind === 'fill' ? '빈 단가 기입' : '변경 요청'}</td>
                        <td>
                          <Link to={`/po/${p.poId}`} className="text-navy-900 hover:underline">
                            {p.poNo}
                          </Link>
                        </td>
                        <td>{p.vendorName}</td>
                        <td>{p.itemName}</td>
                        <td>{p.spec}</td>
                        <td className="num text-muted">{p.oldPrice ? won(p.oldPrice) : '-'}</td>
                        <td className="num">{won(p.price)}</td>
                        <td>
                          {p.status === 'approved' ? <span className="chip bg-emerald-50 text-emerald-700">반영</span> : <span className="chip bg-red-50 text-red-700" title={p.decideNote}>거절{p.decideNote ? ` · ${p.decideNote}` : ''}</span>}
                        </td>
                        <td className="text-muted">{p.decidedByName ?? '업체 기입'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        ) : tab === 'pending' ? (
          !groups.size ? (
            <Empty>{reqs.loading ? '불러오는 중…' : withPre ? '발주할 품목이 없습니다.' : '발주할 품목이 없습니다. 구매청구가 최종 승인되면 여기에 나타납니다. 결재 중인 청구서를 먼저 발주하려면 위의 \'결재 중 청구서도 보기 (선발주)\'를 켜세요.'}</Empty>
          ) : (
            <div className="max-h-[calc(100vh-220px)] overflow-auto">
              {[...groups].map(([siteId, byVendor]) => (
                <div key={siteId} className="border-b border-line">
                  <div className="bg-[#f7f8fb] px-4 py-2 font-semibold text-navy-950">{siteName(siteId)}</div>
                  {[...byVendor].map(([vid, list]) => {
                    const keys = list.map((p) => p.key);
                    const all = keys.every((k) => sel.has(k));
                    return (
                      <div key={vid} className="px-4 py-2">
                        <label className="mb-1 flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={all}
                            onChange={(e) => setAll(e.target.checked ? [...new Set([...sel, ...keys])] : [...sel].filter((k) => !keys.includes(k)), true)}
                          />
                          <span className={`font-semibold ${vid === '__none__' ? 'text-amber-700' : ''}`}>{vid === '__none__' ? '거래선 미지정 — 줄마다 거래선을 고르세요' : vendorName(vid)}</span>
                          <span className="text-[12px] text-muted">
                            {list.length}줄 · {won(list.reduce((a, p) => a + (p.line.orderQty || p.line.reqQty) * (p.line.orderPrice || 0), 0))}원
                          </span>
                        </label>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th className="w-8"></th>
                              <th>청구서</th>
                              <th>품명</th>
                              <th>규격</th>
                              <th>단위</th>
                              <th className="num">발주수량</th>
                              <th className="num">단가</th>
                              <th className="num">금액</th>
                              <th>희망납기</th>
                              <th>비고</th>
                              <th>거래선</th>
                            </tr>
                          </thead>
                          <tbody>
                            {list.map((p) => {
                              const qty = p.line.orderQty || p.line.reqQty;
                              return (
                                <tr key={p.key}>
                                  <td>
                                    <input type="checkbox" checked={sel.has(p.key)} onChange={() => toggle(p.key)} />
                                  </td>
                                  <td className="whitespace-nowrap">
                                    <Link to={`/req/${p.req.id}`} className="text-navy-900 hover:underline">
                                      {p.req.docNo || p.req.requestDate}
                                    </Link>
                                    {p.pre && (
                                      <span className="chip ml-1 bg-violet-50 text-violet-700" title="결재가 끝나지 않은 청구서입니다. 발주하면 선발주로 표시됩니다.">
                                        결재 중 · {p.req.steps[p.req.currentStep]?.label ?? ''}
                                      </span>
                                    )}
                                  </td>
                                  <td>{p.line.itemName}</td>
                                  <td>{p.line.spec}</td>
                                  <td>{p.line.unit}</td>
                                  <td className="num">{qty.toLocaleString()}</td>
                                  <td className={`num ${p.line.orderPrice ? '' : 'text-amber-700'}`}>{p.line.orderPrice ? won(p.line.orderPrice) : '단가 없음'}</td>
                                  <td className="num">{won(qty * (p.line.orderPrice || 0))}</td>
                                  <td className="whitespace-nowrap">{p.line.dueDate}</td>
                                  <td className="text-muted">{[p.line.location, p.line.remark].filter(Boolean).join(' · ')}</td>
                                  <td>
                                    <select
                                      className={`input h-7 w-36 ${vendorOf(p) ? '' : 'border-amber-brand bg-amber-soft'}`}
                                      value={vendorOf(p)}
                                      onChange={(e) => setVendorPick((m) => ({ ...m, [p.key]: e.target.value }))}
                                    >
                                      <option value="">거래선 선택</option>
                                      {vendors.data
                                        .filter((v) => v.active)
                                        .map((v) => (
                                          <option key={v.id} value={v.id}>
                                            {v.name}
                                          </option>
                                        ))}
                                    </select>
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
              ))}
            </div>
          )
        ) : !listShown.length ? (
          <Empty>{pos.loading ? '불러오는 중…' : '발주서가 없습니다.'}</Empty>
        ) : (
          <div className="max-h-[calc(100vh-220px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>발주일</th>
                  <th>발주번호</th>
                  <th>현장</th>
                  <th>거래선</th>
                  <th>품목</th>
                  <th className="num">금액</th>
                  <th>청구서</th>
                  <th>상태</th>
                  <th>발주 담당</th>
                </tr>
              </thead>
              <tbody>
                {listShown.map((p) => (
                  <tr key={p.id} className={p.status === 'cancelled' ? 'text-muted' : ''}>
                    <td className="whitespace-nowrap">{p.orderDate}</td>
                    <td>
                      <Link to={`/po/${p.id}`} className="font-semibold text-navy-900 hover:text-amber-700 hover:underline">
                        {p.poNo}
                      </Link>
                    </td>
                    <td>{p.siteName}</td>
                    <td>{p.vendorName}</td>
                    <td className="max-w-[280px] truncate text-muted">
                      {p.lines[0]?.itemName}
                      {p.lines.length > 1 && ` 외 ${p.lines.length - 1}건`}
                    </td>
                    <td className="num">{won(p.totalAmount)}</td>
                    <td className="text-[12px] text-muted">{p.reqDocNos.join(', ')}</td>
                    <td className="whitespace-nowrap">
                      <PoChip s={p.status} /> <PreChip s={preOrderState(p, reqs.data)} />
                    </td>
                    <td className="text-muted">{p.orderedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
