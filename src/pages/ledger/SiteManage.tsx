// 월별 품목 · 현장 관리: 현장 자료 삭제(기간 선택)·제외, 같은 업체·같은 월 중복 계산서 정리
import { useMemo, useState } from 'react';
import { audit, commitBatch, fetchWhere } from '../../lib/db';
import { C } from '../../lib/firebase';
import { refreshCatalog } from '../../lib/itemCatalog';
import { cmp, fmtA, mL, mLong, saveSiteExclude } from '../../lib/ledgerData';
import { nameKey } from '../../lib/normalize';
import { cleanVendorName } from '../../lib/parsers';
import { Empty, errMsg, useToast } from '../../components/ui';
import type { Invoice, LedgerEntry, Site } from '../../types';

const counted = (i: Invoice) => !(i.submitted && !i.appliedToLedger);
const stamp = (i: Invoice) => Math.max(i.uploadedAt ?? 0, i.appliedAt ?? 0);

async function deleteInvoices(list: Invoice[], onProgress?: (d: number, t: number) => void) {
  const ops: { type: 'delete'; col: string; id: string }[] = [];
  for (const inv of list) {
    const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', inv.id);
    ops.push(...old.map((e) => ({ type: 'delete' as const, col: C.ledger, id: e.id })), { type: 'delete', col: C.invoices, id: inv.id });
  }
  await commitBatch(ops, onProgress);
}

export default function SiteManage({ invoices, sites, excluded }: { invoices: Invoice[]; sites: Site[]; excluded: string[] }) {
  const toast = useToast();
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState('');
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '(삭제된 현장)';
  const months = useMemo(() => [...new Set(invoices.map((i) => i.month))].sort(), [invoices]);

  /* 같은 현장·같은 월에 같은 업체(표기만 다른 것 포함) 계산서가 둘 이상 */
  const dups = useMemo(() => {
    const g = new Map<string, Invoice[]>();
    for (const i of invoices) {
      if (!counted(i)) continue;
      const k = `${i.month}|${i.siteId}|${nameKey(cleanVendorName(i.vendorName) || i.vendorName)}`;
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return [...g.values()].filter((l) => l.length > 1).map((l) => [...l].sort((a, b) => stamp(b) - stamp(a)));
  }, [invoices]);

  const list = useMemo(() => {
    const S = new Map<string, { id: string; n: number; lines: number; a: number; ms: Set<string>; vs: Set<string> }>();
    for (const i of invoices) {
      if (!counted(i)) continue;
      const o = S.get(i.siteId) ?? { id: i.siteId, n: 0, lines: 0, a: 0, ms: new Set(), vs: new Set() };
      o.n++;
      o.lines += i.lines.length;
      o.a += i.lines.reduce((x, l) => x + (l.finalAmount || 0), 0);
      o.ms.add(i.month);
      o.vs.add(i.vendorName);
      S.set(i.siteId, o);
    }
    return [...S.values()].sort((a, b) => cmp(siteName(a.id), siteName(b.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, sites]);

  const cleanDups = async () => {
    const del = dups.flatMap((l) => l.slice(1));
    if (!confirm(`중복 계산서 ${del.length}건을 지우고, 현장·업체·월마다 가장 최근에 올린 것만 남길까요?\n(투입원장에서도 빠지고 되돌릴 수 없습니다)\n\n지울 계산서:\n${del.map((i) => `- ${mLong(i.month)} ${siteName(i.siteId)} · ${i.vendorName} (${i.fileName || i.source})`).join('\n')}`)) return;
    setBusy('dup');
    try {
      await deleteInvoices(del);
      await audit('월별 품목 중복 정리', `${del.length}건`, { ids: del.map((i) => i.id) });
      refreshCatalog();
      toast(`중복 ${del.length}건을 정리했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy('');
    }
  };

  const removeSite = async (siteId: string) => {
    const del = invoices.filter((i) => i.siteId === siteId && (!month || i.month === month));
    if (!del.length) return toast(`${siteName(siteId)}에 ${month ? mLong(month) + ' ' : ''}자료가 없습니다.`, 'err');
    if (!confirm(`${siteName(siteId)} · ${month ? mLong(month) : '전체 기간'} 계산서 ${del.length}건(${del.reduce((a, i) => a + i.lines.length, 0).toLocaleString()}줄)을 삭제할까요?\n계산서 메뉴·투입원장에서도 빠지고 되돌릴 수 없습니다.\n\n지우지 않고 월별 품목에서만 빼려면 [제외]를 쓰세요.`)) return;
    setBusy(siteId);
    try {
      await deleteInvoices(del);
      await audit('월별 품목 현장 자료 삭제', siteId, { month: month || '전체', count: del.length });
      refreshCatalog();
      toast(`${del.length}건 삭제했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy('');
    }
  };

  const toggleEx = async (siteId: string) => {
    const next = excluded.includes(siteId) ? excluded.filter((x) => x !== siteId) : [...excluded, siteId];
    try {
      await saveSiteExclude(next);
      toast(excluded.includes(siteId) ? `${siteName(siteId)} 제외를 풀었습니다.` : `${siteName(siteId)}를 월별 품목에서 뺐습니다. (계산서 자료는 그대로)`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <div className="space-y-3">
      {dups.length > 0 && (
        <div className="card border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-amber-800">⚠ 같은 현장·같은 월에 같은 업체 계산서가 두 번 이상 들어 있습니다 ({dups.length}건) — 금액이 중복 합산됩니다</b>
            <span className="flex-1" />
            <button className="btn-primary h-8 text-[12px]" disabled={!!busy} onClick={cleanDups}>
              {busy === 'dup' ? '정리 중…' : '최근 것만 남기고 정리'}
            </button>
          </div>
          <table className="tbl mt-2 bg-white text-[12px]">
            <thead>
              <tr>
                <th>월</th>
                <th>현장</th>
                <th>업체 표기</th>
                <th>파일</th>
                <th>올린 때</th>
                <th className="num">금액</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {dups.flatMap((l) =>
                l.map((i, j) => (
                  <tr key={i.id} className={j ? 'text-muted' : ''}>
                    <td>{mLong(i.month)}</td>
                    <td>{siteName(i.siteId)}</td>
                    <td>{i.vendorName}</td>
                    <td className="max-w-[260px] truncate">{i.fileName || (i.source === 'import' ? '예전 자료' : i.source)}</td>
                    <td className="whitespace-nowrap">{stamp(i) ? new Date(stamp(i)).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td>
                    <td className="num">{fmtA(i.totalAmount)}</td>
                    <td>{j ? <span className="chip bg-red-50 text-red-600">지움</span> : <span className="chip bg-green-50 text-green-700">남김</span>}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <b>🏗 현장 관리</b>
          <span className="text-[12px] text-muted">현장 {list.length}곳</span>
          <span className="flex-1" />
          <label className="flex items-center gap-1 text-[12px] text-muted">
            삭제 기간
            <select className="input h-7" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">전체 기간</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {mLong(m)}만
                </option>
              ))}
            </select>
          </label>
        </div>
        {!list.length ? (
          <Empty>계산서 자료가 없습니다.</Empty>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="tbl text-[12.5px]">
              <thead>
                <tr>
                  <th>현장</th>
                  <th className="num">계산서</th>
                  <th className="num">명세</th>
                  <th className="num">금액</th>
                  <th>자료 있는 월</th>
                  <th>업체</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((o) => {
                  const ex = excluded.includes(o.id);
                  return (
                    <tr key={o.id} className={ex ? 'opacity-60' : ''}>
                      <td className="whitespace-nowrap">
                        <b>{siteName(o.id)}</b>
                        {ex && <span className="chip ml-1 bg-slate-100 text-slate-600">제외 중</span>}
                      </td>
                      <td className="num">{o.n.toLocaleString()}</td>
                      <td className="num">{o.lines.toLocaleString()}</td>
                      <td className="num">{fmtA(o.a)}</td>
                      <td className="text-[12px] text-muted">{[...o.ms].sort().map(mL).join(', ')}</td>
                      <td className="max-w-[260px] whitespace-normal text-[12px] text-muted">{[...o.vs].sort(cmp).join(', ')}</td>
                      <td className="whitespace-nowrap">
                        <button className="btn-ghost h-7 text-[12px]" onClick={() => toggleEx(o.id)} title="계산서 자료는 지우지 않고 월별 품목 화면·엑셀에서만 뺍니다">
                          {ex ? '제외 해제' : '제외'}
                        </button>
                        <button className="btn-ghost ml-1 h-7 text-[12px] text-red-600" disabled={!!busy} onClick={() => removeSite(o.id)}>
                          {busy === o.id ? '삭제 중…' : month ? `${mL(month)} 삭제` : '삭제'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
          [제외]는 계산서 자료를 그대로 두고 월별 품목에서만 뺍니다(모든 사용자 공통). [삭제]는 고른 기간의 계산서를 계산서 메뉴·투입원장에서도 지웁니다.
        </p>
      </div>
    </div>
  );
}
