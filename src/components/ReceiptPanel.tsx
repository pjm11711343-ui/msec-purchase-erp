import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { audit, commitBatch, newId } from '../lib/db';
import { C } from '../lib/firebase';
import { num } from '../lib/normalize';
import { poLineKey, today } from '../lib/receipts';
import { errMsg, useToast } from './ui';
import type { PurchaseOrder, Receipt } from '../types';

/** 발주서 한 장의 입고 입력 + 입고 기록 */
export default function ReceiptPanel({ po, receipts }: { po: PurchaseOrder; receipts: Receipt[] }) {
  const { profile, vendor, can } = useAuth();
  const toast = useToast();
  const mine = receipts.filter((r) => r.poId === po.id);
  const got = (k: string) => mine.filter((r) => r.lineKey === k).reduce((a, r) => a + r.qty, 0);
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canConfirm = !vendor && (can('admin', 'material', 'siteManager', 'siteStaff'));
  const isVendor = !!vendor;
  const who = vendor ? vendor.vendorName : (profile?.name ?? '');

  const rows = po.lines.map((l) => {
    const k = poLineKey(l);
    const received = got(k);
    return { l, k, received, remain: Math.max(0, l.qty - received) };
  });

  const register = async (keys: string[], useRemain: boolean) => {
    if (!date) return toast('입고일을 입력하세요.', 'err');
    const ops: Parameters<typeof commitBatch>[0] = [];
    for (const r of rows.filter((x) => keys.includes(x.k))) {
      const q = useRemain ? r.remain : num(qty[r.k] ?? r.remain);
      if (q <= 0) continue;
      const rec: Omit<Receipt, 'id'> = {
        poId: po.id,
        poNo: po.poNo,
        siteId: po.siteId,
        siteName: po.siteName,
        vendorId: po.vendorId,
        vendorName: po.vendorName,
        lineKey: r.k,
        itemName: r.l.itemName,
        spec: r.l.spec,
        unit: r.l.unit,
        qty: q,
        date,
        ...(note ? { note } : {}),
        source: isVendor ? 'vendor' : 'office',
        enteredBy: vendor?.id ?? profile?.id ?? '',
        enteredByName: who,
        createdAt: Date.now(),
      };
      ops.push({ type: 'set', col: C.receipts, id: newId(C.receipts), data: rec, merge: false });
    }
    if (!ops.length) return toast('입고할 수량이 없습니다.', 'err');
    setBusy(true);
    try {
      await commitBatch(ops);
      await audit('입고 등록', po.poNo, { lines: ops.length, date });
      toast(`${ops.length}줄 입고를 등록했습니다.`);
      setPick(new Set());
      setQty({});
      setNote('');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Receipt) => {
    if (!confirm(`${r.date} ${r.itemName} ${r.qty}${r.unit} 입고 기록을 지울까요?`)) return;
    try {
      await commitBatch([{ type: 'delete', col: C.receipts, id: r.id }]);
      toast('지웠습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const confirmAll = async () => {
    const list = mine.filter((r) => !r.confirmed);
    if (!list.length) return;
    try {
      await commitBatch(list.map((r) => ({ type: 'set' as const, col: C.receipts, id: r.id, data: { confirmed: true, confirmedByName: who, confirmedAt: Date.now() } })));
      toast(`${list.length}건 입고를 확인했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const openKeys = rows.filter((r) => r.remain > 0).map((r) => r.k);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[#fafbfc] px-4 py-2.5">
        <span className="text-[12px] text-muted">현장 입고일</span>
        <input className="input h-7 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input h-7 w-56" placeholder="메모 (예: 1차 분할 납품)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost h-7 text-[12px]" disabled={busy || !pick.size} onClick={() => register([...pick], false)}>
            선택 {pick.size}줄 입고 등록
          </button>
          <button className="btn-primary h-7 text-[12px]" disabled={busy || !openKeys.length} onClick={() => register(openKeys, true)}>
            남은 수량 전체 입고
          </button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th className="w-8">
              <input type="checkbox" checked={openKeys.length > 0 && openKeys.every((k) => pick.has(k))} onChange={(e) => setPick(e.target.checked ? new Set(openKeys) : new Set())} />
            </th>
            <th>품명</th>
            <th>규격</th>
            <th>단위</th>
            <th className="num">발주</th>
            <th className="num">입고 누계</th>
            <th className="num">남은 수량</th>
            <th className="num">이번 입고</th>
            <th>희망납기</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className={r.remain === 0 ? 'text-muted' : ''}>
              <td>
                {r.remain > 0 && (
                  <input
                    type="checkbox"
                    checked={pick.has(r.k)}
                    onChange={() =>
                      setPick((s) => {
                        const n = new Set(s);
                        if (n.has(r.k)) n.delete(r.k);
                        else n.add(r.k);
                        return n;
                      })
                    }
                  />
                )}
              </td>
              <td>{r.l.itemName}</td>
              <td>{r.l.spec}</td>
              <td>{r.l.unit}</td>
              <td className="num">{r.l.qty.toLocaleString()}</td>
              <td className="num">{r.received ? r.received.toLocaleString() : ''}</td>
              <td className={`num font-semibold ${r.remain ? '' : 'text-emerald-600'}`}>{r.remain ? r.remain.toLocaleString() : '완료'}</td>
              <td className="num">
                {r.remain > 0 && (
                  <input
                    className="input h-7 w-20 px-1.5 text-right"
                    value={qty[r.k] ?? String(r.remain)}
                    onChange={(e) => {
                      setQty((q) => ({ ...q, [r.k]: e.target.value }));
                      setPick((s) => new Set(s).add(r.k));
                    }}
                  />
                )}
              </td>
              <td className="whitespace-nowrap text-muted">{r.l.dueDate}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between border-t border-line px-4 py-2">
        <span className="font-semibold">입고 기록 {mine.length}건</span>
        {canConfirm && mine.some((r) => !r.confirmed) && (
          <button className="btn-dark h-7 text-[12px]" onClick={confirmAll}>
            미확인 입고 모두 확인
          </button>
        )}
      </div>
      {mine.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>입고일</th>
              <th>품명</th>
              <th>규격</th>
              <th className="num">수량</th>
              <th>메모</th>
              <th>입력</th>
              <th>현장 확인</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{r.date}</td>
                <td>{r.itemName}</td>
                <td>{r.spec}</td>
                <td className="num">
                  {r.qty.toLocaleString()} {r.unit}
                </td>
                <td className="text-muted">{r.note}</td>
                <td className="text-muted">
                  {r.enteredByName}
                  {r.source === 'office' && ' (대리)'}
                </td>
                <td>{r.confirmed ? <span className="chip bg-emerald-50 text-emerald-700">확인 {r.confirmedByName}</span> : <span className="chip bg-line text-muted">미확인</span>}</td>
                <td className="text-right">
                  {((!r.confirmed && (!isVendor || r.enteredBy === vendor?.id)) || can('admin')) && (
                    <button className="text-[12px] text-muted hover:text-red-600" onClick={() => remove(r)}>
                      지우기
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
