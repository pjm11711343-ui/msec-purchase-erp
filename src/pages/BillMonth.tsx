// 구매 흐름 › 계산서월 지정: 업체가 등록한 입고 물량을 몇 월 계산서로 청구할지 자재부가 정한다
//  - 기본은 자동: 전월 21일 ~ 당월 20일 입고 = 당월 계산서
//  - 여러 줄을 골라 "다음 달로 이월" · "○월로 지정" · "자동으로 되돌리기"
//  - 계산서(거래명세서)에 이미 들어간 줄은 잠김
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { audit, commitBatch, useCollection } from '../lib/db';
import { C } from '../lib/firebase';
import { useSites } from '../lib/hooks';
import { won } from '../lib/normalize';
import { usePurchaseOrders } from '../lib/pos';
import { usePoPrices, withVendorPrices } from '../lib/poPrices';
import { poLineKey, useReceipts } from '../lib/receipts';
import { addMonth, autoBillMonth, billedReceiptIds, billMonthOf, billPeriod, carryOf, CLOSE_DAY, daysToClose, openBillMonth } from '../lib/billing';
import { useAuth } from '../auth/AuthContext';
import { Empty, errMsg, PageHeader, Stat, useToast } from '../components/ui';
import type { Invoice } from '../types';

type St = 'open' | 'billed' | 'all';

export default function BillMonth() {
  const { profile } = useAuth();
  const toast = useToast();
  const sites = useSites();
  const pos = usePurchaseOrders();
  const prices = usePoPrices();
  const receipts = useReceipts();
  const invoices = useCollection<Invoice>(C.invoices);
  const [month, setMonth] = useState(openBillMonth());
  const [siteF, setSiteF] = useState('');
  const [vendorF, setVendorF] = useState('');
  const [st, setSt] = useState<St>('open');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  const billed = useMemo(() => billedReceiptIds(receipts.data, invoices.data), [receipts.data, invoices.data]);
  const poMap = useMemo(() => new Map(pos.data.map((p) => [p.id, withVendorPrices(p, prices.data)])), [pos.data, prices.data]);
  const priceOf = (poId: string, lineKey: string) => poMap.get(poId)?.lines.find((l) => poLineKey(l) === lineKey)?.price ?? 0;

  const rows = useMemo(
    () =>
      receipts.data
        .filter((r) => poMap.get(r.poId)?.status !== 'cancelled')
        .map((r) => {
          const price = priceOf(r.poId, r.lineKey);
          return { r, bm: billMonthOf(r), carry: carryOf(r), billed: billed.has(r.id), price, amt: Math.round(r.qty * price) };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [receipts.data, poMap, billed],
  );
  const months = useMemo(() => {
    const s = new Set(rows.map((x) => x.bm));
    s.add(openBillMonth());
    s.add(month);
    return [...s].sort().reverse();
  }, [rows, month]);
  const vendors = useMemo(() => [...new Map(rows.map((x) => [x.r.vendorId, x.r.vendorName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko')), [rows]);
  const scoped = rows.filter((x) => (!siteF || x.r.siteId === siteF) && (!vendorF || x.r.vendorId === vendorF));
  const list = scoped
    .filter((x) => x.bm === month && (st === 'all' || (st === 'open' ? !x.billed : x.billed)))
    .sort((a, b) => a.r.siteName.localeCompare(b.r.siteName, 'ko') || a.r.vendorName.localeCompare(b.r.vendorName, 'ko') || a.r.date.localeCompare(b.r.date));
  // 지난 계산서월인데 아직 계산서에 안 들어간 줄 (이월할지 확인 필요)
  const stale = scoped.filter((x) => !x.billed && x.bm < openBillMonth());
  const inMonth = scoped.filter((x) => x.bm === month);
  const sum = (l: typeof rows) => l.reduce((a, x) => a + x.amt, 0);
  const period = billPeriod(month);
  const dday = daysToClose();
  const openNow = scoped.filter((x) => x.bm === openBillMonth() && !x.billed);

  const selectable = list.filter((x) => !x.billed);
  const allOn = selectable.length > 0 && selectable.every((x) => sel.has(x.r.id));
  const toggle = (id: string) => setSel((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s).add(id)));

  const apply = async (mode: 'next' | 'to' | 'auto') => {
    const chosen = list.filter((x) => sel.has(x.r.id) && !x.billed);
    if (!chosen.length) return toast('줄을 고르세요.', 'err');
    if (mode === 'to' && !/^\d{4}-\d{2}$/.test(to)) return toast('지정할 월을 고르세요.', 'err');
    const label = mode === 'next' ? `다음 달(${addMonth(month, 1)})로 이월` : mode === 'to' ? `${to} 계산서로 지정` : '자동(입고일 기준)으로 되돌리기';
    if (!confirm(`${chosen.length}줄 · ${won(sum(chosen))}원을 ${label} 할까요?`)) return;
    setBusy(true);
    try {
      await commitBatch(
        chosen.map((x) => {
          const target = mode === 'next' ? addMonth(x.bm, 1) : mode === 'to' ? to : '';
          const auto = autoBillMonth(x.r.date);
          return {
            type: 'set' as const,
            col: C.receipts,
            id: x.r.id,
            data: target && target !== auto ? { billMonth: target, billBy: profile?.name ?? '', billAt: Date.now() } : { billMonth: '', billBy: profile?.name ?? '', billAt: Date.now() },
          };
        }),
      );
      await audit('계산서월 지정', label, { count: chosen.length, from: month });
      toast(`${chosen.length}줄을 ${label} 했습니다.`);
      setSel(new Set());
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const exportXlsx = () => {
    const aoa: (string | number)[][] = [['계산서월', '현장', '업체', '발주번호', '입고일', '품명', '규격', '단위', '수량', '단가', '금액', '이월', '계산서', '지정']];
    for (const x of inMonth) aoa.push([x.bm, x.r.siteName, x.r.vendorName, x.r.poNo, x.r.date, x.r.itemName, x.r.spec, x.r.unit, x.r.qty, x.price, x.amt, x.carry ? `${x.carry}회` : '', x.billed ? '반영' : '미반영', x.r.billBy ?? '']);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '계산서월');
    XLSX.writeFile(wb, `계산서월_${month}.xlsx`);
  };

  return (
    <div>
      <PageHeader
        title="계산서월 지정"
        desc={`업체가 등록한 입고 물량을 몇 월 계산서로 청구할지 정합니다. 마감은 매월 ${CLOSE_DAY}일 — 전월 ${CLOSE_DAY + 1}일 ~ 당월 ${CLOSE_DAY}일 입고분이 자동으로 당월 계산서가 됩니다. 이월할 줄만 골라서 바꾸세요.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="input w-44" value={siteF} onChange={(e) => (setSiteF(e.target.value), setSel(new Set()))}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="input w-44" value={vendorF} onChange={(e) => (setVendorF(e.target.value), setSel(new Set()))}>
              <option value="">전체 업체</option>
              {vendors.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
            <button className="btn-ghost" disabled={!inMonth.length} onClick={exportXlsx}>
              엑셀
            </button>
          </div>
        }
      />

      {dday >= 0 && dday <= 3 && openNow.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-soft px-4 py-2.5 text-[13px] text-amber-900">
          ⏰ <b>{openBillMonth()} 계산서 마감 {dday === 0 ? '오늘' : `D-${dday}`}</b> ({openBillMonth()}-{CLOSE_DAY}) · 아직 계산서에 안 들어간 입고 {openNow.length}줄 · {won(sum(openNow))}원
        </div>
      )}
      {stale.length > 0 && (
        <button
          className="mb-3 block w-full rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-left text-[13px] text-red-800 hover:bg-red-100"
          onClick={() => (setMonth([...new Set(stale.map((x) => x.bm))].sort()[0]), setSt('open'), setSel(new Set()))}
        >
          ⚠ 지난 계산서월인데 아직 계산서에 안 들어간 입고 {stale.length}줄 · {won(sum(stale))}원 ({[...new Set(stale.map((x) => x.bm))].sort().join(', ')}) — 눌러서 확인하고 이월하세요 ›
        </button>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`${month} 계산서 대상`} value={`${won(sum(inMonth))}원`} />
        <Stat label="계산서 반영" value={`${won(sum(inMonth.filter((x) => x.billed)))}원`} />
        <Stat label="미반영" value={`${won(sum(inMonth.filter((x) => !x.billed)))}원`} accent />
        <Stat label="이월된 줄" value={`${inMonth.filter((x) => x.carry > 0).length}줄`} />
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">계산서월</span>
          <select className="input h-7 w-32" value={month} onChange={(e) => (setMonth(e.target.value), setSel(new Set()))}>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
                {m === openBillMonth() ? ' (이번)' : ''}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted">
            자동 기간 {period.from} ~ {period.to}
          </span>
          <div className="flex gap-1">
            {(['open', 'billed', 'all'] as const).map((k) => (
              <button key={k} className={`rounded-md px-2.5 py-1 text-[12px] ${st === k ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`} onClick={() => (setSt(k), setSel(new Set()))}>
                {k === 'open' ? '미반영' : k === 'billed' ? '계산서 반영' : '전체'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted">{sel.size}줄 선택</span>
            <button className="btn-primary h-7 text-[12px]" disabled={busy || !sel.size} onClick={() => apply('next')}>
              다음 달로 이월
            </button>
            <input type="month" className="input h-7 w-36" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn-dark h-7 text-[12px]" disabled={busy || !sel.size || !to} onClick={() => apply('to')}>
              이 달로 지정
            </button>
            <button className="btn-ghost h-7 text-[12px]" disabled={busy || !sel.size} onClick={() => apply('auto')}>
              자동으로 되돌리기
            </button>
          </div>
        </div>
        {!list.length ? (
          <Empty>{receipts.loading ? '불러오는 중…' : `${month} 계산서월에 해당하는 입고가 없습니다.`}</Empty>
        ) : (
          <div className="max-h-[620px] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" checked={allOn} disabled={!selectable.length} onChange={() => setSel(allOn ? new Set() : new Set(selectable.map((x) => x.r.id)))} />
                  </th>
                  <th>현장</th>
                  <th>업체</th>
                  <th>입고일</th>
                  <th>품명</th>
                  <th>규격</th>
                  <th className="num">수량</th>
                  <th className="num">단가</th>
                  <th className="num">금액</th>
                  <th>발주</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.r.id} className={x.billed ? 'text-muted' : sel.has(x.r.id) ? 'bg-amber-soft/40' : ''} onClick={() => !x.billed && toggle(x.r.id)}>
                    <td>
                      <input type="checkbox" disabled={x.billed} checked={sel.has(x.r.id)} onChange={() => toggle(x.r.id)} onClick={(e) => e.stopPropagation()} />
                    </td>
                    <td className="whitespace-nowrap">{x.r.siteName}</td>
                    <td className="whitespace-nowrap">{x.r.vendorName}</td>
                    <td className="whitespace-nowrap">{x.r.date}</td>
                    <td>{x.r.itemName}</td>
                    <td className="text-[12px]">{x.r.spec}</td>
                    <td className="num">
                      {x.r.qty.toLocaleString()}
                      <span className="ml-0.5 text-[11px] text-muted">{x.r.unit}</span>
                    </td>
                    <td className="num">{x.price ? won(x.price) : <span className="text-amber-700">단가 없음</span>}</td>
                    <td className="num font-semibold">{won(x.amt)}</td>
                    <td className="text-[11.5px] text-muted">{x.r.poNo}</td>
                    <td className="whitespace-nowrap text-[11.5px]">
                      {x.billed ? (
                        <span className="chip bg-emerald-50 text-emerald-700">계산서 반영 🔒</span>
                      ) : x.carry > 0 ? (
                        <span className={`chip ${x.carry >= 2 ? 'bg-red-50 text-red-700' : 'bg-sky-50 text-sky-700'}`} title={`${x.r.billBy ?? ''} 지정`}>
                          이월 {x.carry}회 ({autoBillMonth(x.r.date)}→)
                        </span>
                      ) : x.carry < 0 ? (
                        <span className="chip bg-violet-50 text-violet-700">앞당김 ({autoBillMonth(x.r.date)}→)</span>
                      ) : (
                        <span className="chip bg-line text-muted">자동</span>
                      )}
                      {!x.r.confirmed && <span className="ml-1 text-amber-700">현장 미확인</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-4 py-2 text-[11.5px] text-muted">
          계산서 반영 줄(🔒)은 바꿀 수 없습니다. 바꾸려면 그 계산서를 먼저 지우세요. 업체 포털 거래명세서에도 이 계산서월 기준으로 나옵니다.
        </div>
      </div>
    </div>
  );
}
