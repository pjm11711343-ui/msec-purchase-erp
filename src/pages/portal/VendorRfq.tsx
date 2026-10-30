// 업체 포털 › 견적 요청: 내게 온 견적 의뢰서에 단가·제조사·비고를 넣어 제출
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import { won } from '../../lib/normalize';
import { quoteId, useVendorRfqs, type QuoteLine, type Rfq } from '../../lib/rfq';
import { Empty, errMsg, NumInput, useToast } from '../../components/ui';

export default function VendorRfq() {
  const { vendor } = useAuth();
  const toast = useToast();
  const { rfqs, quotes } = useVendorRfqs(vendor?.vendorId);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, QuoteLine>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const list = rfqs.data.filter((r) => r.status !== 'draft').sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
  const cur = list.find((r) => r.id === open);
  const myQ = (r: Rfq) => quotes.data.find((q) => q.rfqId === r.id);

  const openRfq = (r: Rfq) => {
    const q = myQ(r);
    setLines(Object.fromEntries((q?.lines ?? []).map((l) => [l.key, l])));
    setNote(q?.note ?? '');
    setOpen(r.id);
  };
  const save = async (submit: boolean) => {
    if (!cur || !vendor) return;
    const ls = cur.lines.map((l) => ({ key: l.key, price: lines[l.key]?.price || 0, ...(lines[l.key]?.maker ? { maker: lines[l.key].maker } : {}), ...(lines[l.key]?.note ? { note: lines[l.key].note } : {}) }));
    if (submit && !ls.some((l) => l.price > 0)) return toast('단가를 한 줄 이상 넣으세요.', 'err');
    if (submit && ls.some((l) => !l.price) && !confirm('단가가 빈 품목이 있습니다. 빈 품목은 견적 없음으로 제출할까요?')) return;
    setBusy(true);
    try {
      const prev = myQ(cur);
      await commitBatch([
        {
          type: 'set',
          col: C.rfqQuotes,
          id: quoteId(cur.id, vendor.vendorId),
          data: { rfqId: cur.id, vendorId: vendor.vendorId, vendorName: vendor.vendorName, lines: ls, note, status: submit ? 'submitted' : prev?.status === 'submitted' ? 'submitted' : 'draft', by: 'vendor', ...(submit ? { submittedAt: Date.now() } : {}), updatedAt: Date.now() },
        },
      ]);
      toast(submit ? '견적을 제출했습니다. 감사합니다.' : '임시 저장했습니다.');
      if (submit) setOpen(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (cur) {
    const closed = cur.status === 'closed';
    const total = cur.lines.reduce((a, l) => a + (lines[l.key]?.price || 0) * (l.qty || 0), 0);
    return (
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <button className="btn-ghost h-7 text-[12px]" onClick={() => setOpen(null)}>
            ← 목록
          </button>
          <span className="font-semibold">견적 의뢰 {cur.rfqNo}</span>
          <span className="text-[12.5px] text-muted">
            {cur.title} {cur.siteName && `· 현장 ${cur.siteName}`} {cur.deliveryPlace && `· 납품 ${cur.deliveryPlace}`}
          </span>
          {myQ(cur)?.status === 'submitted' && <span className="chip bg-emerald-50 text-emerald-700">제출함 {myQ(cur)?.submittedAt ? new Date(myQ(cur)!.submittedAt!).toLocaleDateString('ko-KR') : ''}</span>}
        </div>
        {cur.note && <div className="border-b border-line bg-amber-soft/50 px-4 py-2 text-[12.5px]">안내: {cur.note}</div>}
        {cur.guide && (
          <div className="border-b border-line bg-sky-50 px-4 py-2 text-[12.5px] leading-relaxed text-sky-900">
            <div className="mb-0.5 font-semibold">※ 견적 작성 안내</div>
            {cur.guide.split('\n').map((x, i) => (
              <div key={i}>{x}</div>
            ))}
          </div>
        )}
        <div className="overflow-auto">
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th className="w-8">No</th>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th className="num">수량</th>
                <th className="num w-36">단가 (VAT 별도)</th>
                <th className="num">금액</th>
                <th className="w-36">제조사</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {cur.lines.map((l, i) => {
                const v = lines[l.key] ?? { key: l.key, price: 0 };
                const set = (p: Partial<QuoteLine>) => setLines({ ...lines, [l.key]: { ...v, ...p } });
                return (
                  <tr key={l.key}>
                    <td className="text-muted">{i + 1}</td>
                    <td className="font-medium">{l.itemName}</td>
                    <td>{l.spec}</td>
                    <td>{l.unit}</td>
                    <td className="num">{l.qty ? l.qty.toLocaleString() : ''}</td>
                    <td>{closed ? <span className="block text-right">{v.price ? won(v.price) : ''}</span> : <NumInput className="input h-7 w-full px-1.5 text-right" value={v.price} onChange={(n) => set({ price: n })} />}</td>
                    <td className="num">{v.price && l.qty ? won(v.price * l.qty) : ''}</td>
                    <td>{closed ? v.maker : <input className="input h-7 w-full px-1.5" value={v.maker ?? ''} onChange={(e) => set({ maker: e.target.value || undefined })} />}</td>
                    <td>{closed ? v.note : <input className="input h-7 w-full px-1.5" value={v.note ?? ''} onChange={(e) => set({ note: e.target.value || undefined })} />}</td>
                  </tr>
                );
              })}
              <tr className="bg-[#f7f8fb] font-semibold">
                <td colSpan={6} className="text-right">
                  합계 (수량 있는 품목)
                </td>
                <td className="num">{total ? won(total) : ''}</td>
                <td colSpan={2}></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <input className="input w-80" disabled={closed} placeholder="견적 전체 비고 (예: 유효기간, 납기)" value={note} onChange={(e) => setNote(e.target.value)} />
          {closed ? (
            <span className="ml-auto text-[12.5px] text-muted">마감된 견적입니다.</span>
          ) : (
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost" disabled={busy} onClick={() => save(false)}>
                임시 저장
              </button>
              <button className="btn-primary" disabled={busy} onClick={() => save(true)}>
                {myQ(cur)?.status === 'submitted' ? '수정 제출' : '견적 제출'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-2.5 font-semibold">견적 요청</div>
      {!list.length ? (
        <Empty>{rfqs.loading ? '불러오는 중…' : '받은 견적 요청이 없습니다.'}</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>의뢰일</th>
              <th>견적번호</th>
              <th>제목</th>
              <th>현장</th>
              <th>품목</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const q = myQ(r);
              return (
                <tr key={r.id} className="cursor-pointer" onClick={() => openRfq(r)}>
                  <td className="whitespace-nowrap">{r.sentAt ? new Date(r.sentAt).toLocaleDateString('ko-KR') : ''}</td>
                  <td className="font-semibold text-navy-900">{r.rfqNo}</td>
                  <td>{r.title}</td>
                  <td>{r.siteName}</td>
                  <td className="text-muted">
                    {r.lines[0]?.itemName} {r.lines.length > 1 && `외 ${r.lines.length - 1}건`}
                  </td>
                  <td>
                    {r.status === 'closed' ? (
                      <span className="chip bg-line text-muted">마감</span>
                    ) : q?.status === 'submitted' ? (
                      <span className="chip bg-emerald-50 text-emerald-700">제출함</span>
                    ) : q ? (
                      <span className="chip bg-amber-soft text-amber-800">작성 중</span>
                    ) : (
                      <span className="chip bg-violet-50 text-violet-700">새 요청</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
