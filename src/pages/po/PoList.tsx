import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites, useVendors } from '../../lib/hooks';
import { won } from '../../lib/normalize';
import { nextPoNo, pendingLines, usePurchaseOrders, type PendingLine } from '../../lib/pos';
import { useRequisitions } from '../../lib/reqs';
import { Empty, errMsg, PageHeader, useSelection, useToast } from '../../components/ui';
import { PO_STATUS_LABEL, type PoLine, type PoStatus, type PurchaseOrder } from '../../types';

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function PoChip({ s }: { s: PoStatus }) {
  const c = s === 'sent' ? 'bg-emerald-50 text-emerald-700' : s === 'cancelled' ? 'bg-line text-muted line-through' : 'bg-amber-soft text-amber-800';
  return <span className={`chip ${c}`}>{PO_STATUS_LABEL[s]}</span>;
}

export default function PoList() {
  const { profile, can } = useAuth();
  const isOffice = can('admin', 'material');
  const reqs = useRequisitions();
  const pos = usePurchaseOrders();
  const sites = useSites();
  const vendors = useVendors();
  const toast = useToast();
  const { sel, toggle, setAll, clear } = useSelection();
  const [tab, setTab] = useState<'pending' | 'list'>(isOffice ? 'pending' : 'list');
  const [vendorPick, setVendorPick] = useState<Record<string, string>>({}); // 거래선 미지정 줄 → 업체
  const [siteF, setSiteF] = useState('');
  const [statusF, setStatusF] = useState<'' | PoStatus>('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const pend = useMemo(() => pendingLines(reqs.data, pos.data), [reqs.data, pos.data]);
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
          createdAt: Date.now(),
          history: [{ at: Date.now(), by: profile?.name ?? '', action: '발주서 생성' }],
        };
        ops.push({ type: 'set', col: C.purchaseOrders, id: newId(C.purchaseOrders), data: po, merge: false });
        made.push(`${poNo} ${v?.name}`);
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
        desc="승인된 구매청구 품목을 현장·거래선별로 묶어 발주서를 만듭니다. 발주서는 원 양식대로 인쇄하거나 PDF로 저장해 보내세요."
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

        {tab === 'pending' ? (
          !groups.size ? (
            <Empty>{reqs.loading ? '불러오는 중…' : '발주할 품목이 없습니다. 구매청구가 최종 승인되면 여기에 나타납니다.'}</Empty>
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
                    <td>
                      <PoChip s={p.status} />
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
