import { useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import { notifyQuiet } from '../../lib/notify';
import { useAuth } from '../../auth/AuthContext';
import { commitBatch, useCollection } from '../../lib/db';
import { C } from '../../lib/firebase';
import { won } from '../../lib/normalize';
import { poProgress, receivedMap, useReceipts, useVendorPOs } from '../../lib/receipts';
import ReceiptPanel from '../../components/ReceiptPanel';
import VendorStatement from './VendorStatement';
import { Empty, errMsg, RateBar, useToast } from '../../components/ui';
import { MIN_ROWS, PoSheet, signBoxes } from '../po/PoDetail';
import type { Invoice, Site } from '../../types';

/** 업체 전용 화면: 자기 업체 발주서 확인 · 입고 등록 */
export default function VendorPortal() {
  const { vendor, logout } = useAuth();
  const pos = useVendorPOs();
  const receipts = useReceipts();
  const sites = useCollection<Site>(C.sites);
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<'receipt' | 'sheet'>('receipt');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [page, setPage] = useState<'po' | 'statement'>('po');
  const rec = useMemo(() => receivedMap(receipts.data), [receipts.data]);

  const list = pos.data
    .map((p) => ({ p, prog: poProgress(p, rec) }))
    .filter((x) => filter === 'all' || x.prog.state !== '입고완료');
  const cur = pos.data.find((p) => p.id === open);

  const ack = async (id: string) => {
    try {
      await commitBatch([{ type: 'set', col: C.purchaseOrders, id, data: { ackAt: Date.now(), ackBy: vendor?.vendorName ?? '' } }]);
      toast('발주를 확인했습니다.');
      notifyQuiet('po_ack', { poId: id });
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const unack = async (id: string) => {
    if (!confirm('발주 확인을 취소할까요?')) return;
    try {
      await commitBatch([{ type: 'set', col: C.purchaseOrders, id, data: { ackAt: 0, ackBy: '' } }]);
      toast('발주 확인을 취소했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  // 이미 거래명세서로 제출한 입고 기록 (입고 취소 불가)
  const invoices = useCollection<Invoice>(C.invoices, vendor ? [where('vendorId', '==', vendor.vendorId)] : [], vendor?.vendorId ?? '', !!vendor);
  const billed = useMemo(() => {
    const s = new Set<string>();
    invoices.data.forEach((inv) => inv.lines.forEach((l) => l.receiptIds?.forEach((x) => s.add(x))));
    return s;
  }, [invoices.data]);

  return (
    <div className="min-h-full bg-canvas">
      <header className="no-print flex items-center gap-3 bg-navy-950 px-6 py-3 text-white">
        <div>
          <div className="text-[11px] tracking-[0.2em] text-amber-brand">MYUNGSIN · 협력업체</div>
          <div className="text-[16px] font-bold">{vendor?.vendorName}</div>
        </div>
        <div className="ml-auto text-[12px] text-white/60">업체코드 {vendor?.code}</div>
        <button className="text-[12px] text-amber-brand hover:underline" onClick={logout}>
          로그아웃
        </button>
      </header>
      <div className="mx-auto max-w-[1280px] p-5">
        <div className="no-print mb-4 flex gap-1">
          {(['po', 'statement'] as const).map((t) => (
            <button key={t} className={`rounded-md px-4 py-1.5 text-[13px] font-semibold ${page === t ? 'bg-navy-950 text-white' : 'bg-white text-muted hover:text-ink'}`} onClick={() => (setPage(t), setOpen(null))}>
              {t === 'po' ? '발주서 · 입고' : '거래명세서'}
            </button>
          ))}
        </div>
        {page === 'statement' ? (
          <VendorStatement />
        ) : !cur ? (
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="font-semibold">발주서</span>
              <select className="input ml-auto h-7" value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')}>
                <option value="open">입고 남은 것</option>
                <option value="all">전체</option>
              </select>
            </div>
            {!list.length ? (
              <Empty>{pos.loading ? '불러오는 중…' : '받은 발주서가 없습니다.'}</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>발주일</th>
                    <th>발주번호</th>
                    <th>현장</th>
                    <th>품목</th>
                    <th className="num">금액</th>
                    <th className="w-44">입고</th>
                    <th>발주 확인</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(({ p, prog }) => (
                    <tr key={p.id} className="cursor-pointer" onClick={() => (setOpen(p.id), setView('receipt'))}>
                      <td className="whitespace-nowrap">{p.orderDate}</td>
                      <td className="font-semibold text-navy-900">{p.poNo}</td>
                      <td>{p.siteName}</td>
                      <td className="max-w-[280px] truncate text-muted">
                        {p.lines[0]?.itemName}
                        {p.lines.length > 1 && ` 외 ${p.lines.length - 1}건`}
                      </td>
                      <td className="num">{won(p.totalAmount)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="w-14 text-[12px]">{prog.state}</span>
                          <RateBar rate={prog.rate} />
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {p.ackAt ? (
                          <div className="flex items-center gap-1.5">
                            <span className="chip bg-emerald-50 text-emerald-700">확인 {new Date(p.ackAt).toLocaleDateString('ko-KR')}</span>
                            <button className="text-[11.5px] text-muted hover:text-red-600" onClick={() => unack(p.id)}>
                              확인 취소
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button className="btn-primary h-7 text-[12px]" onClick={() => ack(p.id)}>
                              발주 확인
                            </button>
                            {p.revisedAt ? <span className="chip bg-amber-soft text-amber-800">발주 변경됨 · 다시 확인</span> : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div>
            <div className="no-print mb-3 flex flex-wrap items-center gap-2">
              <button className="btn-ghost" onClick={() => setOpen(null)}>
                목록
              </button>
              <span className="text-[17px] font-bold text-navy-950">{cur.poNo}</span>
              <span className="text-muted">
                {cur.siteName} · {won(cur.totalAmount)}원
              </span>
              <div className="ml-auto flex gap-2">
                <button className={view === 'receipt' ? 'btn-dark' : 'btn-ghost'} onClick={() => setView('receipt')}>
                  입고 등록
                </button>
                <button className={view === 'sheet' ? 'btn-dark' : 'btn-ghost'} onClick={() => setView('sheet')}>
                  발주서 보기
                </button>
                {view === 'sheet' && (
                  <button className="btn-ghost" onClick={() => window.print()}>
                    인쇄 / PDF
                  </button>
                )}
              </div>
            </div>
            {view === 'receipt' ? (
              <div className="card overflow-hidden">
                <ReceiptPanel po={cur} receipts={receipts.data} prices={pos.prices} billed={billed} />
              </div>
            ) : (
              <PoSheet po={cur} site={sites.data.find((s) => s.id === cur.siteId)} boxes={signBoxes(cur)} internal={false} showPrice pad={Math.max(0, MIN_ROWS - cur.lines.length)} />
            )}
          </div>
        )}
        <p className="no-print mt-4 text-[12px] text-muted">현장 입고일은 업체 출고일이 아니라 현장에 실제 도착한 날짜로 입력해 주세요. 나눠서 납품하면 납품할 때마다 등록합니다.</p>
      </div>
    </div>
  );
}
