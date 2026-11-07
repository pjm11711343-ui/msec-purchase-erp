// 구매 흐름 › 정산 대조: 한 달 동안 ERP 입고(입고 수량 × 발주 단가)와 업체 거래명세서 금액을 업체·현장별로 맞춰 본다
//  - 차이가 나면 품목(품명+규격)별로 펼쳐 수량·단가·금액이 어디서 다른지 빨간색으로 보여 준다
import { Fragment, useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { useCollection } from '../lib/db';
import { C } from '../lib/firebase';
import { useSites } from '../lib/hooks';
import { itemKey } from '../lib/itemMaster';
import { won } from '../lib/normalize';
import { usePurchaseOrders } from '../lib/pos';
import { usePoPrices, withVendorPrices } from '../lib/poPrices';
import { poLineKey, useReceipts } from '../lib/receipts';
import { billMonthOf } from '../lib/billing';
import { itemKey as ik2, offFixed, priceValid, usePriceList } from '../lib/itemMaster';
import { Empty, PageHeader, Stat } from '../components/ui';
import type { Invoice } from '../types';

interface ItemRow {
  key: string;
  itemName: string;
  spec: string;
  unit: string;
  erpQty: number;
  erpAmt: number;
  erpPrice: number;
  invQty: number;
  invAmt: number;
  invPrice: number;
}
interface Group {
  key: string;
  siteId: string;
  siteName: string;
  vendorId: string;
  vendorName: string;
  erpAmt: number;
  invAmt: number;
  hasInvoice: boolean;
  items: ItemRow[];
}

const thisMonth = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const prevMonths = (n: number) => {
  const out: string[] = [];
  const d = new Date(Date.now() + 9 * 3600e3);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
};
const TOL = 10; // 원 단위 반올림 차이는 맞는 것으로 본다

export default function Reconcile() {
  const sites = useSites();
  const pos = usePurchaseOrders();
  const prices = usePoPrices();
  const receipts = useReceipts();
  const [month, setMonth] = useState(thisMonth());
  const [siteF, setSiteF] = useState('');
  const [vendorF, setVendorF] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const invs = useCollection<Invoice>(C.invoices, [where('month', '==', month)], month);
  const priceList = usePriceList();
  /** 현장 지정단가 (현장|업체|품목) */
  const fixedMap = useMemo(() => new Map(priceList.data.filter((p) => p.fixed && p.siteId && priceValid(p, `${month}-15`)).map((p) => [`${p.siteId}|${p.vendorId}|${ik2(p.itemName, p.spec)}`, p.price])), [priceList.data, month]);
  const fixedOf = (g: Group, i: ItemRow) => fixedMap.get(`${g.siteId}|${g.vendorId}|${i.key}`);

  const groups = useMemo(() => {
    const poMap = new Map(pos.data.map((p) => [p.id, withVendorPrices(p, prices.data)]));
    const m = new Map<string, Group>();
    const g = (siteId: string, siteName: string, vendorId: string, vendorName: string) => {
      const k = `${siteId}_${vendorId}`;
      let x = m.get(k);
      if (!x) m.set(k, (x = { key: k, siteId, siteName, vendorId, vendorName, erpAmt: 0, invAmt: 0, hasInvoice: false, items: [] }));
      return x;
    };
    const item = (gr: Group, itemName: string, spec: string, unit: string) => {
      const k = itemKey(itemName, spec ?? '');
      let r = gr.items.find((i) => i.key === k);
      if (!r) gr.items.push((r = { key: k, itemName, spec: spec ?? '', unit: unit ?? '', erpQty: 0, erpAmt: 0, erpPrice: 0, invQty: 0, invAmt: 0, invPrice: 0 }));
      return r;
    };
    // ERP 입고: 이 달 입고 수량 × 발주 단가
    for (const r of receipts.data) {
      if (billMonthOf(r) !== month) continue;
      const po = poMap.get(r.poId);
      const line = po?.lines.find((l) => poLineKey(l) === r.lineKey);
      const price = line?.price ?? 0;
      const gr = g(r.siteId, r.siteName, r.vendorId, r.vendorName);
      const it = item(gr, r.itemName, r.spec, r.unit);
      it.erpQty += r.qty;
      it.erpAmt += Math.round(r.qty * price);
      if (price) it.erpPrice = price;
      gr.erpAmt += Math.round(r.qty * price);
    }
    // 업체 거래명세서(계산서): 이 달
    const siteName = (id: string) => sites.data.find((s) => s.id === id)?.name ?? id;
    for (const inv of invs.data) {
      const gr = g(inv.siteId, siteName(inv.siteId), inv.vendorId, inv.vendorName);
      gr.hasInvoice = true;
      for (const l of inv.lines) {
        const it = item(gr, l.itemName, l.spec, l.unit);
        const q = l.changedQty ?? l.qty ?? 0;
        it.invQty += q;
        it.invAmt += l.finalAmount || 0;
        const p = l.changedPrice ?? l.unitPrice;
        if (p) it.invPrice = p;
        gr.invAmt += l.finalAmount || 0;
      }
    }
    return [...m.values()].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ko') || a.vendorName.localeCompare(b.vendorName, 'ko'));
  }, [pos.data, prices.data, receipts.data, invs.data, sites.data, month]);

  const vendors = useMemo(() => [...new Map(groups.map((x) => [x.vendorId, x.vendorName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko')), [groups]);
  const diffOf = (x: Group) => x.invAmt - x.erpAmt;
  const list = groups.filter((x) => (!siteF || x.siteId === siteF) && (!vendorF || x.vendorId === vendorF) && (!onlyDiff || Math.abs(diffOf(x)) > TOL));
  const sum = (f: (x: Group) => number) => list.reduce((a, x) => a + f(x), 0);
  const mismatch = list.filter((x) => Math.abs(diffOf(x)) > TOL).length;
  const loading = pos.loading || receipts.loading || invs.loading;

  const exportXlsx = () => {
    const aoa: (string | number)[][] = [['현장', '업체', '품명', '규격', '단위', 'ERP 입고수량', 'ERP 단가', 'ERP 금액', '명세서 수량', '명세서 단가', '명세서 금액', '금액 차이']];
    for (const x of list) for (const i of x.items) aoa.push([x.siteName, x.vendorName, i.itemName, i.spec, i.unit, i.erpQty, i.erpPrice, i.erpAmt, i.invQty, i.invPrice, i.invAmt, i.invAmt - i.erpAmt]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '정산대조');
    XLSX.writeFile(wb, `정산대조_${month}.xlsx`);
  };

  return (
    <div>
      <PageHeader
        title="정산 대조"
        desc="계산서월 기준 입고(입고 수량 × 발주 단가, 매월 20일 마감·이월 반영)와 업체가 낸 거래명세서 금액을 업체·현장별로 맞춰 봅니다. 줄을 누르면 품목별로 어디가 다른지 보입니다."
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="input w-32" value={month} onChange={(e) => (setMonth(e.target.value), setOpen(null))}>
              {prevMonths(18).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select className="input w-44" value={siteF} onChange={(e) => setSiteF(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="input w-44" value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">전체 업체</option>
              {vendors.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[12.5px]">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> 차이만
            </label>
            <button className="btn-ghost" disabled={!list.length} onClick={exportXlsx}>
              엑셀
            </button>
          </div>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="ERP 입고 금액" value={`${won(sum((x) => x.erpAmt))}원`} />
        <Stat label="명세서 금액" value={`${won(sum((x) => x.invAmt))}원`} />
        <Stat label="차이 (명세서 − ERP)" value={`${won(sum(diffOf))}원`} accent />
        <Stat label="안 맞는 업체·현장" value={`${mismatch}건`} />
      </div>
      <div className="card overflow-x-auto">
        {!list.length ? (
          <Empty>{loading ? '불러오는 중…' : `${month}에 입고나 거래명세서가 없습니다.`}</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>현장</th>
                <th>업체</th>
                <th className="num">ERP 입고 금액</th>
                <th className="num">명세서 금액</th>
                <th className="num">차이</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const d = diffOf(x);
                const ok = Math.abs(d) <= TOL;
                return (
                  <Fragment key={x.key}>
                    <tr className="cursor-pointer" onClick={() => setOpen(open === x.key ? null : x.key)}>
                      <td>{x.siteName}</td>
                      <td className="font-medium">
                        {open === x.key ? '▾' : '▸'} {x.vendorName}
                      </td>
                      <td className="num">{won(x.erpAmt)}</td>
                      <td className="num">{x.hasInvoice ? won(x.invAmt) : '-'}</td>
                      <td className={`num font-semibold ${ok ? '' : 'text-red-600'}`}>{d > 0 ? '+' : ''}{won(d)}</td>
                      <td>
                        {!x.hasInvoice ? (
                          <span className="chip bg-amber-soft text-amber-800">명세서 없음</span>
                        ) : !x.erpAmt ? (
                          <span className="chip bg-amber-soft text-amber-800">ERP 입고 없음</span>
                        ) : ok ? (
                          <span className="chip bg-emerald-50 text-emerald-700">일치</span>
                        ) : (
                          <span className="chip bg-red-50 text-red-700">차이</span>
                        )}
                        {(() => {
                          const n = x.items.filter((i) => offFixed(fixedOf(x, i), i.invPrice)).length;
                          return n ? <span className="chip ml-1 bg-violet-100 text-violet-800">지정단가 다름 {n}</span> : null;
                        })()}
                      </td>
                    </tr>
                    {open === x.key && (
                      <tr>
                        <td colSpan={6} className="bg-canvas p-2">
                          <table className="tbl bg-white text-[12px]">
                            <thead>
                              <tr>
                                <th>품명</th>
                                <th>규격</th>
                                <th>단위</th>
                                <th className="num">ERP 수량</th>
                                <th className="num">명세서 수량</th>
                                <th className="num">ERP 단가</th>
                                <th className="num">명세서 단가</th>
                                <th className="num">지정단가</th>
                                <th className="num">ERP 금액</th>
                                <th className="num">명세서 금액</th>
                                <th className="num">차이</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...x.items]
                                .sort((a, b) => Math.abs(b.invAmt - b.erpAmt) - Math.abs(a.invAmt - a.erpAmt))
                                .map((i) => {
                                  const qBad = Math.abs(i.erpQty - i.invQty) > 1e-6;
                                  const pBad = !!i.erpPrice && !!i.invPrice && Math.abs(i.erpPrice - i.invPrice) > 0.5;
                                  const dd = i.invAmt - i.erpAmt;
                                  return (
                                    <tr key={i.key}>
                                      <td>{i.itemName}</td>
                                      <td>{i.spec}</td>
                                      <td>{i.unit}</td>
                                      <td className={`num ${qBad ? 'font-bold text-red-600' : ''}`}>{i.erpQty.toLocaleString()}</td>
                                      <td className={`num ${qBad ? 'font-bold text-red-600' : ''}`}>{i.invQty.toLocaleString()}</td>
                                      <td className={`num ${pBad ? 'font-bold text-red-600' : ''}`}>{won(i.erpPrice)}</td>
                                      <td className={`num ${pBad || offFixed(fixedOf(x, i), i.invPrice) ? 'font-bold text-red-600' : ''}`}>{won(i.invPrice)}</td>
                                      <td className={`num ${offFixed(fixedOf(x, i), i.invPrice) ? 'bg-red-50 font-bold text-violet-800' : 'text-violet-800'}`} title={offFixed(fixedOf(x, i), i.invPrice) ? '명세서 단가가 현장 지정단가와 다릅니다' : undefined}>
                                        {fixedOf(x, i) ? won(fixedOf(x, i)!) : ''}
                                      </td>
                                      <td className="num">{won(i.erpAmt)}</td>
                                      <td className="num">{won(i.invAmt)}</td>
                                      <td className={`num ${Math.abs(dd) > TOL ? 'font-bold text-red-600' : ''}`}>{dd > 0 ? '+' : ''}{won(dd)}</td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                          <div className="px-1 pt-1.5 text-[11.5px] text-muted">빨간 수량 = 입고 기록과 명세서 수량이 다름 · 빨간 단가 = 발주 단가 또는 현장 지정단가와 명세서 단가가 다름. ERP 단가가 0이면 발주서에 단가가 비어 있는 줄입니다.</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
