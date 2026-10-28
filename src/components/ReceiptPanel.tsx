import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { audit, commitBatch, newId } from '../lib/db';
import { C } from '../lib/firebase';
import { num, won } from '../lib/normalize';
import { priceDocId, type PoPrice } from '../lib/poPrices';
import { poLineKey, today } from '../lib/receipts';
import { commaText, errMsg, useToast } from './ui';
import type { PurchaseOrder, Receipt } from '../types';

/** 발주서 한 장의 입고 입력 + 입고 기록 */
export default function ReceiptPanel({ po, receipts, prices = [] }: { po: PurchaseOrder; receipts: Receipt[]; prices?: PoPrice[] }) {
  const { profile, vendor, can, readOnly } = useAuth();
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
  const showPrice = isVendor || can('admin', 'material') || readOnly;
  const [priceIn, setPriceIn] = useState<Record<string, string>>({}); // 빈 단가 기입
  const [chg, setChg] = useState<{ k: string; price: string; note: string } | null>(null); // 단가 변경 요청 입력
  const reqOf = (k: string) => prices.find((p) => p.id === priceDocId(po.id, k));

  const rows = po.lines.map((l) => {
    const k = poLineKey(l);
    const received = got(k);
    return { l, k, received, remain: Math.max(0, l.qty - received) };
  });

  const register = async (keys: string[], useRemain: boolean) => {
    if (!date) return toast('입고일을 입력하세요.', 'err');
    const ops: Parameters<typeof commitBatch>[0] = [];
    // 업체: 단가가 비어 있는 줄은 단가를 넣어야 입고 등록
    if (isVendor) {
      const target = rows.filter((x) => keys.includes(x.k) && (useRemain ? x.remain : num(qty[x.k] ?? x.remain)) > 0);
      const miss = target.filter((x) => !x.l.price && !(num(priceIn[x.k]) > 0));
      if (miss.length) return toast(`단가가 비어 있는 줄이 ${miss.length}개 있습니다. 단가를 입력해야 입고 등록할 수 있습니다: ${miss.slice(0, 3).map((x) => `${x.l.itemName} ${x.l.spec}`).join(', ')}`, 'err');
      for (const x of target.filter((t) => !t.l.price)) {
        const p: Omit<PoPrice, 'id'> = {
          poId: po.id,
          poNo: po.poNo,
          siteId: po.siteId,
          siteName: po.siteName,
          vendorId: po.vendorId,
          vendorName: po.vendorName,
          lineKey: x.k,
          itemName: x.l.itemName,
          spec: x.l.spec,
          unit: x.l.unit,
          qty: x.l.qty,
          oldPrice: 0,
          price: num(priceIn[x.k]),
          kind: 'fill',
          status: 'approved',
          applied: false,
          by: vendor?.id ?? '',
          byName: who,
          at: Date.now(),
        };
        ops.push({ type: 'set', col: C.poPrices, id: priceDocId(po.id, x.k), data: p, merge: false });
      }
    }
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
    if (!ops.some((o) => o.col === C.receipts)) return toast('입고할 수량이 없습니다.', 'err');
    setBusy(true);
    try {
      await commitBatch(ops);
      const n = ops.filter((o) => o.col === C.receipts).length;
      await audit('입고 등록', po.poNo, { lines: n, date });
      toast(`${n}줄 입고를 등록했습니다.`);
      setPick(new Set());
      setQty({});
      setPriceIn({});
      setNote('');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** 업체: 단가 변경 요청 (자재부 승인 후 발주서에 반영) */
  const requestChange = async () => {
    if (!chg) return;
    const r = rows.find((x) => x.k === chg.k);
    const price = num(chg.price);
    if (!r || !(price > 0)) return toast('바꿀 단가를 입력하세요.', 'err');
    if (price === r.l.price) return toast('지금 단가와 같습니다.', 'err');
    const p: Omit<PoPrice, 'id'> = {
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
      qty: r.l.qty,
      oldPrice: r.l.price,
      price,
      kind: 'change',
      status: 'pending',
      applied: false,
      ...(chg.note.trim() ? { note: chg.note.trim() } : {}),
      by: vendor?.id ?? '',
      byName: who,
      at: Date.now(),
    };
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.poPrices, id: priceDocId(po.id, r.k), data: p, merge: false }]);
      toast('단가 변경을 요청했습니다. 명신기공 자재부가 승인하면 발주서 단가가 바뀝니다.');
      setChg(null);
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
      {!readOnly && (
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
      )}
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
            {showPrice && <th className="num w-44">단가</th>}
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
                {r.remain > 0 && !readOnly && (
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
              {showPrice && (
                <td className="num">
                  {(() => {
                    const rq = reqOf(r.k);
                    const pending = rq?.kind === 'change' && rq.status === 'pending';
                    if (!r.l.price) {
                      return isVendor && !readOnly ? (
                        <input
                          className="input h-7 w-28 border-amber-brand bg-amber-soft px-1.5 text-right"
                          placeholder="단가 입력 (필수)"
                          value={priceIn[r.k] ?? ''}
                          onChange={(e) => setPriceIn((m) => ({ ...m, [r.k]: commaText(e.target.value) }))}
                        />
                      ) : (
                        <span className="text-amber-700">단가 없음</span>
                      );
                    }
                    if (chg?.k === r.k)
                      return (
                        <div className="flex flex-col items-end gap-1">
                          <input className="input h-7 w-28 px-1.5 text-right" autoFocus placeholder="바꿀 단가" value={chg.price} onChange={(e) => setChg({ ...chg, price: commaText(e.target.value) })} />
                          <input className="input h-7 w-40 px-1.5" placeholder="사유 (예: 원자재 인상)" value={chg.note} onChange={(e) => setChg({ ...chg, note: e.target.value })} />
                          <div className="flex gap-1">
                            <button className="btn-ghost h-6 px-2 text-[11px]" onClick={() => setChg(null)}>
                              취소
                            </button>
                            <button className="btn-primary h-6 px-2 text-[11px]" disabled={busy} onClick={requestChange}>
                              변경 요청
                            </button>
                          </div>
                        </div>
                      );
                    return (
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-semibold">
                          {won(r.l.price)}
                          {r.l.priceBy === 'vendor' && <span className="ml-1 text-[10.5px] font-normal text-violet-700">{r.l.priceOld ? `변경 (전 ${won(r.l.priceOld)})` : '업체 기입'}</span>}
                        </span>
                        {pending && <span className="chip bg-violet-50 text-violet-700">변경 요청 {won(rq.price)}원 · 승인 대기</span>}
                        {rq?.kind === 'change' && rq.status === 'rejected' && isVendor && (
                          <span className="chip bg-red-50 text-red-700" title={rq.decideNote}>
                            요청 {won(rq.price)}원 거절{rq.decideNote ? ` · ${rq.decideNote}` : ''}
                          </span>
                        )}
                        {isVendor && !readOnly && !pending && (
                          <button className="text-[11px] text-navy-900 hover:underline" onClick={() => setChg({ k: r.k, price: '', note: '' })}>
                            단가 수정 요청
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </td>
              )}
              <td className="num">{r.received ? r.received.toLocaleString() : ''}</td>
              <td className={`num font-semibold ${r.remain ? '' : 'text-emerald-600'}`}>{r.remain ? r.remain.toLocaleString() : '완료'}</td>
              <td className="num">
                {r.remain > 0 && !readOnly && (
                  <input
                    className="input h-7 w-20 px-1.5 text-right"
                    value={qty[r.k] ?? commaText(String(r.remain))}
                    onChange={(e) => {
                      setQty((q) => ({ ...q, [r.k]: commaText(e.target.value) }));
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
                  {!readOnly && ((!r.confirmed && (!isVendor || r.enteredBy === vendor?.id)) || can('admin')) && (
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
