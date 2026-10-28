import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { usePurchaseOrders } from '../lib/pos';
import { usePoPrices } from '../lib/poPrices';
import { poProgress, receivedMap, useReceipts } from '../lib/receipts';
import { useSites } from '../lib/hooks';
import { won } from '../lib/normalize';
import ReceiptPanel from '../components/ReceiptPanel';
import { useAuth } from '../auth/AuthContext';
import { Empty, PageHeader, RateBar, Stat } from '../components/ui';

type St = '' | '미입고' | '부분입고' | '입고완료';

export default function ReceiptStatus() {
  const pos = usePurchaseOrders();
  const { readOnly } = useAuth();
  const receipts = useReceipts();
  const prices = usePoPrices();
  const sites = useSites();
  const [tab, setTab] = useState<'po' | 'log'>('po');
  const [siteF, setSiteF] = useState('');
  const [stF, setStF] = useState<St>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rec = useMemo(() => receivedMap(receipts.data), [receipts.data]);

  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    return pos.data
      .filter((p) => p.status !== 'cancelled')
      .map((p) => ({ p, prog: poProgress(p, rec), unconfirmed: receipts.data.filter((r) => r.poId === p.id && !r.confirmed).length }))
      .filter(({ p, prog }) => (!siteF || p.siteId === siteF) && (!stF || prog.state === stF) && (!k || [p.poNo, p.vendorName, p.siteName, ...p.lines.map((l) => l.itemName)].join(' ').toLowerCase().includes(k)));
  }, [pos.data, rec, receipts.data, siteF, stF, q]);

  const count = (s: St) => pos.data.filter((p) => p.status !== 'cancelled' && poProgress(p, rec).state === s).length;
  const log = receipts.data.filter((r) => !siteF || r.siteId === siteF);

  const exportLog = () => {
    const aoa = [['입고일', '현장', '업체', '발주번호', '품명', '규격', '단위', '수량', '메모', '입력', '현장확인']];
    log.forEach((r) => aoa.push([r.date, r.siteName, r.vendorName, r.poNo, r.itemName, r.spec, r.unit, String(r.qty), r.note ?? '', r.enteredByName + (r.source === 'office' ? '(대리)' : ''), r.confirmed ? `확인 ${r.confirmedByName ?? ''}` : '미확인']));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '입고내역');
    XLSX.writeFile(wb, `입고내역_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div>
      <PageHeader title="입고 현황" desc="업체가 포털에서 입력한 현장 입고를 발주서별로 봅니다. 업체 대신 입력(대리)하거나 현장 확인을 할 수 있습니다." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="미입고 발주서" value={`${count('미입고')}건`} />
        <Stat label="부분 입고" value={`${count('부분입고')}건`} accent />
        <Stat label="입고 완료" value={`${count('입고완료')}건`} />
        <Stat label="현장 미확인 입고" value={`${receipts.data.filter((r) => !r.confirmed).length}건`} />
      </div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {(['po', 'log'] as const).map((t) => (
            <button key={t} className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === t ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`} onClick={() => setTab(t)}>
              {t === 'po' ? '발주서별' : '입고 기록'}
            </button>
          ))}
          <div className="ml-auto flex flex-wrap gap-2">
            <select className="input h-7" value={siteF} onChange={(e) => setSiteF(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {tab === 'po' ? (
              <>
                <select className="input h-7" value={stF} onChange={(e) => setStF(e.target.value as St)}>
                  <option value="">전체</option>
                  <option>미입고</option>
                  <option>부분입고</option>
                  <option>입고완료</option>
                </select>
                <input className="input h-7 w-44" placeholder="발주번호·업체·품명" value={q} onChange={(e) => setQ(e.target.value)} />
              </>
            ) : (
              <button className="btn-ghost h-7 text-[12px]" onClick={exportLog}>
                엑셀
              </button>
            )}
          </div>
        </div>
        {tab === 'po' ? (
          !rows.length ? (
            <Empty>{pos.loading ? '불러오는 중…' : '발주서가 없습니다.'}</Empty>
          ) : (
            <div className="max-h-[calc(100vh-300px)] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>발주일</th>
                    <th>발주번호</th>
                    <th>현장</th>
                    <th>업체</th>
                    <th className="num">금액</th>
                    <th>업체 확인</th>
                    <th className="w-48">입고</th>
                    <th>현장 미확인</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, prog, unconfirmed }) => (
                    <Fragment key={p.id}>
                      <tr className={open === p.id ? 'bg-amber-soft/40' : ''}>
                        <td className="whitespace-nowrap">{p.orderDate}</td>
                        <td>
                          <Link to={`/po/${p.id}`} className="font-semibold text-navy-900 hover:underline">
                            {p.poNo}
                          </Link>
                        </td>
                        <td>{p.siteName}</td>
                        <td>{p.vendorName}</td>
                        <td className="num">{won(p.totalAmount)}</td>
                        <td>{p.ackAt ? <span className="chip bg-emerald-50 text-emerald-700">확인</span> : <span className="chip bg-line text-muted">미확인</span>}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="w-14 text-[12px]">{prog.state}</span>
                            <RateBar rate={prog.rate} />
                          </div>
                        </td>
                        <td>{unconfirmed ? <span className="chip bg-amber-soft text-amber-800">{unconfirmed}건</span> : ''}</td>
                        <td className="text-right">
                          <button className="btn-ghost h-7 text-[12px]" onClick={() => setOpen(open === p.id ? null : p.id)}>
                            {open === p.id ? '닫기' : readOnly ? '입고 내역' : '입고 입력·확인'}
                          </button>
                        </td>
                      </tr>
                      {open === p.id && (
                        <tr>
                          <td colSpan={9} className="bg-white p-0">
                            <div className="m-2 rounded-xl border border-amber-brand/50">
                              <ReceiptPanel po={p} receipts={receipts.data} prices={prices.data} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !log.length ? (
          <Empty>입고 기록이 없습니다.</Empty>
        ) : (
          <div className="max-h-[calc(100vh-300px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>입고일</th>
                  <th>현장</th>
                  <th>업체</th>
                  <th>발주번호</th>
                  <th>품명</th>
                  <th>규격</th>
                  <th className="num">수량</th>
                  <th>메모</th>
                  <th>입력</th>
                  <th>현장 확인</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{r.date}</td>
                    <td>{r.siteName}</td>
                    <td>{r.vendorName}</td>
                    <td>{r.poNo}</td>
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
                    <td>{r.confirmed ? <span className="chip bg-emerald-50 text-emerald-700">확인</span> : <span className="chip bg-line text-muted">미확인</span>}</td>
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
