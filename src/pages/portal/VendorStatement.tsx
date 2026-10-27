import { useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import { useAuth } from '../../auth/AuthContext';
import { commitBatch, stripUndefined, useCollection } from '../../lib/db';
import { C } from '../../lib/firebase';
import { won } from '../../lib/normalize';
import { useReceipts, useVendorPOs } from '../../lib/receipts';
import { Empty, errMsg, useToast } from '../../components/ui';
import type { Invoice, InvoiceLine } from '../../types';

const thisMonth = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);

/** 업체 포털: 입고 기록으로 월 거래명세서를 만들어 제출 */
export default function VendorStatement() {
  const { vendor } = useAuth();
  const toast = useToast();
  const pos = useVendorPOs();
  const receipts = useReceipts();
  const invoices = useCollection<Invoice>(C.invoices, vendor ? [where('vendorId', '==', vendor.vendorId)] : [], vendor?.vendorId ?? '', !!vendor);
  const [month, setMonth] = useState(thisMonth());
  const [site, setSite] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const billed = useMemo(() => {
    const s = new Set<string>();
    invoices.data.forEach((inv) => inv.lines.forEach((l) => l.receiptIds?.forEach((id) => s.add(id))));
    return s;
  }, [invoices.data]);
  const sites = useMemo(() => {
    const m = new Map<string, string>();
    receipts.data.forEach((r) => m.set(r.siteId, r.siteName));
    return [...m];
  }, [receipts.data]);
  const siteId = site || sites[0]?.[0] || '';
  const list = receipts.data.filter((r) => r.siteId === siteId && r.date.startsWith(month) && !billed.has(r.id)).sort((a, b) => a.date.localeCompare(b.date));
  const poOf = (id: string) => pos.data.find((p) => p.id === id);
  const priceOf = (r: (typeof list)[number]) => poOf(r.poId)?.lines.find((l) => `${l.reqId}|${l.lineKey}` === r.lineKey);
  const chosen = list.filter((r) => !off.has(r.id));
  const total = chosen.reduce((a, r) => a + r.qty * (priceOf(r)?.price ?? 0), 0);

  const submit = async () => {
    if (!vendor || !chosen.length) return;
    if (!confirm(`${month} ${sites.find((s) => s[0] === siteId)?.[1]} 거래명세 ${chosen.length}줄, ${won(total)}원을 명신기공에 제출할까요?`)) return;
    setBusy(true);
    try {
      const lines: InvoiceLine[] = chosen.map((r) => {
        const pl = priceOf(r);
        const price = pl?.price ?? 0;
        return stripUndefined({
          receivedDate: r.date,
          orderDate: poOf(r.poId)?.orderDate,
          itemName: r.itemName,
          spec: r.spec,
          unit: r.unit,
          qty: r.qty,
          unitPrice: price,
          amount: Math.round(r.qty * price),
          finalAmount: Math.round(r.qty * price),
          categoryText: '',
          siteCategoryId: pl?.siteCategoryId,
          matchStatus: 'matched',
          poId: r.poId,
          poLineKey: r.lineKey,
          receiptIds: [r.id],
        }) as InvoiceLine;
      });
      const id = `${month}_${vendor.vendorId}_${siteId}_P${Date.now()}`;
      const inv: Omit<Invoice, 'id'> = {
        month,
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        siteId,
        sheetName: '업체 포털',
        source: 'portal',
        fileName: '업체 포털 제출',
        totalAmount: lines.reduce((a, l) => a + l.finalAmount, 0),
        lineCount: lines.length,
        appliedToLedger: false,
        submitted: true,
        submittedAt: Date.now(),
        lines,
        uploadedBy: vendor.vendorName,
        uploadedAt: Date.now(),
      };
      await commitBatch([{ type: 'set', col: C.invoices, id, data: inv, merge: false }]);
      toast('거래명세를 제출했습니다. 명신기공 자재부가 확인합니다.');
      setOff(new Set());
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (inv: Invoice) => {
    if (!confirm('제출을 취소할까요?')) return;
    try {
      await commitBatch([{ type: 'delete', col: C.invoices, id: inv.id }]);
      toast('제출을 취소했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const mine = invoices.data.filter((i) => i.source === 'portal').sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));

  return (
    <div className="flex flex-col gap-4">
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">거래명세 작성</span>
          <input className="input h-7 w-32" type="month" value={month} onChange={(e) => (setMonth(e.target.value), setOff(new Set()))} />
          <select className="input h-7" value={siteId} onChange={(e) => (setSite(e.target.value), setOff(new Set()))}>
            {sites.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[12px] text-muted">
            {chosen.length}줄 · {won(total)}원 (VAT 별도)
          </span>
          <button className="btn-primary h-7 text-[12px]" disabled={busy || !chosen.length} onClick={submit}>
            제출
          </button>
        </div>
        {!list.length ? (
          <Empty>이 달·현장에 아직 청구하지 않은 입고 기록이 없습니다. 먼저 발주서에서 입고를 등록하세요.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" checked={!off.size} onChange={(e) => setOff(e.target.checked ? new Set() : new Set(list.map((r) => r.id)))} />
                </th>
                <th>입고일</th>
                <th>발주번호</th>
                <th>품명</th>
                <th>규격</th>
                <th className="num">수량</th>
                <th className="num">발주단가</th>
                <th className="num">금액</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const p = priceOf(r)?.price ?? 0;
                return (
                  <tr key={r.id} className={off.has(r.id) ? 'text-muted' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!off.has(r.id)}
                        onChange={() =>
                          setOff((s) => {
                            const n = new Set(s);
                            if (n.has(r.id)) n.delete(r.id);
                            else n.add(r.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="whitespace-nowrap">{r.date}</td>
                    <td>{r.poNo}</td>
                    <td>{r.itemName}</td>
                    <td>{r.spec}</td>
                    <td className="num">
                      {r.qty.toLocaleString()} {r.unit}
                    </td>
                    <td className="num">{p ? won(p) : <span className="text-amber-700">단가 없음</span>}</td>
                    <td className="num">{won(r.qty * p)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-line px-4 py-2.5 font-semibold">제출한 거래명세</div>
        {!mine.length ? (
          <Empty>제출한 거래명세가 없습니다.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>월</th>
                <th>현장</th>
                <th className="num">줄</th>
                <th className="num">금액</th>
                <th>제출</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mine.map((i) => (
                <tr key={i.id}>
                  <td>{i.month}</td>
                  <td>{i.lines[0] ? sites.find((s) => s[0] === i.siteId)?.[1] ?? '' : ''}</td>
                  <td className="num">{i.lineCount}</td>
                  <td className="num">{won(i.totalAmount)}</td>
                  <td className="text-muted">{i.submittedAt ? new Date(i.submittedAt).toLocaleDateString('ko-KR') : ''}</td>
                  <td>{i.appliedToLedger ? <span className="chip bg-emerald-50 text-emerald-700">명신기공 확인 완료</span> : <span className="chip bg-amber-soft text-amber-800">확인 대기</span>}</td>
                  <td className="text-right">
                    {!i.appliedToLedger && (
                      <button className="text-[12px] text-muted hover:text-red-600" onClick={() => withdraw(i)}>
                        제출 취소
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[12px] text-muted">세금계산서는 기존처럼 발행해 주시고, 여기서는 입고 내역 기준 청구 금액을 미리 맞춰 봅니다.</p>
    </div>
  );
}
