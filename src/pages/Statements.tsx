// 구매 흐름 › 거래명세서: 현장별 업체 거래명세서(계산서정리·업체 포털 제출) 보기·미리보기·출력
import { useEffect, useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import { useCollection } from '../lib/db';
import { C } from '../lib/firebase';
import { useSites } from '../lib/hooks';
import { won } from '../lib/normalize';
import StatementModal from '../components/StatementSheet';
import { Empty, PageHeader } from '../components/ui';
import type { Invoice } from '../types';

export default function Statements() {
  const sites = useSites();
  const [siteId, setSiteId] = useState('');
  const [month, setMonth] = useState('');
  const [vendor, setVendor] = useState('');
  const [view, setView] = useState<Invoice | null>(null);
  useEffect(() => {
    if (!siteId && sites.data.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);
  const invs = useCollection<Invoice>(C.invoices, siteId ? [where('siteId', '==', siteId)] : [], siteId, !!siteId);
  const months = useMemo(() => [...new Set(invs.data.map((i) => i.month))].sort().reverse(), [invs.data]);
  const vendors = useMemo(() => [...new Set(invs.data.map((i) => i.vendorName))].sort((a, b) => a.localeCompare(b, 'ko')), [invs.data]);
  const list = invs.data
    .filter((i) => (!month || i.month === month) && (!vendor || i.vendorName === vendor))
    .sort((a, b) => b.month.localeCompare(a.month) || a.vendorName.localeCompare(b.vendorName, 'ko'));
  const siteName = sites.data.find((s) => s.id === siteId)?.name ?? '';
  const total = list.reduce((a, i) => a + i.totalAmount, 0);

  return (
    <div>
      <PageHeader
        title="거래명세서"
        desc="현장에 들어온 업체 거래명세서입니다. 업체가 포털로 제출한 것과 자재부가 올린 계산서정리가 모두 나옵니다. 눌러서 미리보고 출력(PDF 저장)할 수 있습니다."
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="input w-52" value={siteId} onChange={(e) => (setSiteId(e.target.value), setMonth(''), setVendor(''))}>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="input w-32" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">전체 월</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select className="input w-44" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">전체 업체</option>
              {vendors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <div className="card overflow-hidden">
        {!list.length ? (
          <Empty>{invs.loading ? '불러오는 중…' : !siteId ? '볼 수 있는 현장이 없습니다.' : '거래명세서가 없습니다.'}</Empty>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>월</th>
                  <th>업체</th>
                  <th>구분</th>
                  <th className="num">줄</th>
                  <th className="num">공급가액</th>
                  <th>상태</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} className="cursor-pointer" onClick={() => setView(i)}>
                    <td className="whitespace-nowrap">{i.month}</td>
                    <td className="font-medium">{i.vendorName}</td>
                    <td className="text-[12px] text-muted">{i.source === 'portal' ? '업체 포털 제출' : '계산서정리'}</td>
                    <td className="num">{i.lineCount}</td>
                    <td className="num font-semibold">{won(i.totalAmount)}</td>
                    <td>{i.submitted && !i.appliedToLedger ? <span className="chip bg-amber-soft text-amber-800">자재부 확인 대기</span> : <span className="chip bg-emerald-50 text-emerald-700">반영</span>}</td>
                    <td className="text-right">
                      <button className="btn-ghost h-7 text-[12px]" onClick={(e) => (e.stopPropagation(), setView(i))}>
                        미리보기·출력
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-line px-4 py-2 text-[12px] text-muted">
              {list.length}건 · 공급가액 합계 <b className="text-ink">{won(total)}원</b>
            </div>
          </>
        )}
      </div>
      {view && <StatementModal inv={view} siteName={siteName} onClose={() => setView(null)} />}
    </div>
  );
}
