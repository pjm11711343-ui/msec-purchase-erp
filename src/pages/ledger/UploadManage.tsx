// 월별 품목 · 업로드 관리: 월별로 올린 파일 목록, 반영 월 바꾸기, 파일·월 삭제 (+ 현장 관리·중복 정리)
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { audit, commitBatch, fetchWhere } from '../../lib/db';
import { C } from '../../lib/firebase';
import { refreshCatalog } from '../../lib/itemCatalog';
import { fmtA, mLong } from '../../lib/ledgerData';
import { nameKey } from '../../lib/normalize';
import { cleanVendorName } from '../../lib/parsers';
import { Empty, errMsg, useToast } from '../../components/ui';
import SiteManage from './SiteManage';
import type { Invoice, LedgerEntry, Site } from '../../types';

type Op = Parameters<typeof commitBatch>[0][number];
interface FileGroup {
  key: string;
  month: string;
  name: string;
  vendor: string;
  source: Invoice['source'];
  invs: Invoice[];
  lines: number;
  amt: number;
  at: number;
  by: string;
  pending: boolean; // 업체 포털 제출만 하고 반영 전
}

const amtOf = (i: Invoice) => i.lines.reduce((a, l) => a + (l.finalAmount || 0), 0);
const SRC: Record<Invoice['source'], string> = { excel: '엑셀', portal: '업체 포털', import: '예전 자료' };

async function delOps(list: Invoice[]): Promise<Op[]> {
  const ops: Op[] = [];
  for (const inv of list) {
    const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', inv.id);
    ops.push(...old.map((e) => ({ type: 'delete' as const, col: C.ledger, id: e.id })), { type: 'delete', col: C.invoices, id: inv.id });
  }
  return ops;
}

export default function UploadManage({ invoices, sites, excluded }: { invoices: Invoice[]; sites: Site[]; excluded: string[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '(삭제된 현장)';

  const files = useMemo(() => {
    const g = new Map<string, FileGroup>();
    for (const i of invoices) {
      const name = i.fileName || (i.source === 'portal' ? '업체 포털 제출' : '(파일명 없음)');
      const key = `${i.month}|${i.source}|${name}|${i.vendorId}`;
      const o = g.get(key) ?? { key, month: i.month, name, vendor: i.vendorName, source: i.source, invs: [], lines: 0, amt: 0, at: 0, by: i.uploadedBy, pending: false };
      o.invs.push(i);
      o.lines += i.lines.length;
      o.amt += amtOf(i);
      o.at = Math.max(o.at, i.uploadedAt ?? 0, i.appliedAt ?? 0);
      o.pending ||= !!(i.submitted && !i.appliedToLedger);
      g.set(key, o);
    }
    return [...g.values()].sort((a, b) => b.month.localeCompare(a.month) || b.at - a.at);
  }, [invoices]);

  /* 같은 월·같은 업체(표기만 다른 것 포함) 파일이 둘 이상이면 중복 표시 */
  const dupKeys = useMemo(() => {
    const m = new Map<string, FileGroup[]>();
    for (const f of files) {
      if (f.pending) continue;
      const k = `${f.month}|${nameKey(cleanVendorName(f.vendor) || f.vendor)}`;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return new Set([...m.values()].filter((l) => l.length > 1).flat().map((f) => f.key));
  }, [files]);

  const byMonth = useMemo(() => {
    const m = new Map<string, FileGroup[]>();
    for (const f of files) m.set(f.month, [...(m.get(f.month) ?? []), f]);
    return [...m.entries()];
  }, [files]);

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    try {
      await fn();
      refreshCatalog();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy('');
    }
  };

  const removeFile = (f: FileGroup) => {
    if (!confirm(`${mLong(f.month)} · ${f.vendor}\n${f.name}\n\n현장 ${f.invs.length}곳 · ${f.lines.toLocaleString()}줄 · ${fmtA(f.amt)}원을 삭제할까요?\n계산서 메뉴·투입원장에서도 빠지고 되돌릴 수 없습니다.`)) return;
    run(f.key, async () => {
      await commitBatch(await delOps(f.invs));
      await audit('월별 품목 파일 삭제', f.name, { month: f.month, count: f.invs.length });
      toast('삭제했습니다.');
    });
  };

  const removeMonth = (m: string, fs: FileGroup[]) => {
    const invs = fs.flatMap((f) => f.invs);
    if (!confirm(`${mLong(m)} 자료 전체(파일 ${fs.length}개 · 계산서 ${invs.length}건 · ${fs.reduce((a, f) => a + f.lines, 0).toLocaleString()}줄)를 삭제할까요?\n계산서 메뉴·투입원장에서도 빠지고 되돌릴 수 없습니다.`)) return;
    run('m:' + m, async () => {
      await commitBatch(await delOps(invs));
      await audit('월별 품목 월 전체 삭제', m, { count: invs.length });
      toast(`${mLong(m)} 자료를 삭제했습니다.`);
    });
  };

  /** 반영 월 바꾸기: 계산서 번호(월_업체_현장)가 바뀌므로 새로 만들고 예전 것은 지운다 (투입원장 줄도 같이 옮김) */
  const moveMonth = (f: FileGroup, to: string) => {
    if (!to || to === f.month) return;
    const clash = f.invs.filter((i) => invoices.some((x) => x.id === `${to}_${i.vendorId}_${i.siteId}`));
    if (clash.length) {
      toast(`${mLong(to)}에 같은 업체·현장 계산서가 이미 있습니다: ${clash.map((i) => siteName(i.siteId)).join(', ')}. 먼저 정리해 주세요.`, 'err');
      return;
    }
    if (!confirm(`${f.name}\n반영 월을 ${mLong(f.month)} → ${mLong(to)}로 바꿀까요? (현장 ${f.invs.length}곳)`)) return;
    run(f.key, async () => {
      const ops: Op[] = [];
      for (const inv of f.invs) {
        const nid = `${to}_${inv.vendorId}_${inv.siteId}`;
        const { id: _old, ...rest } = inv;
        void _old;
        ops.push({ type: 'set', col: C.invoices, id: nid, data: { ...rest, month: to }, merge: false });
        const old = await fetchWhere<LedgerEntry>(C.ledger, 'invoiceId', inv.id);
        for (const e of old) {
          const { id: eid, ...er } = e;
          ops.push({ type: 'set', col: C.ledger, id: `${nid}__${e.siteCategoryId}`, data: { ...er, month: to, invoiceId: nid }, merge: false });
          ops.push({ type: 'delete', col: C.ledger, id: eid });
        }
        ops.push({ type: 'delete', col: C.invoices, id: inv.id });
      }
      for (let i = 0; i < ops.length; i += 40) await commitBatch(ops.slice(i, i + 40));
      await audit('월별 품목 반영 월 변경', f.name, { from: f.month, to });
      toast(`${mLong(to)}로 옮겼습니다.`);
    });
  };

  const totalLines = files.reduce((a, f) => a + f.lines, 0);
  return (
    <div className="space-y-3">
      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <b>월별 업로드 파일</b>
          <span className="text-[12px] text-muted">
            {byMonth.length}개월 · 파일 {files.length}개 · {totalLines.toLocaleString()}줄
            {dupKeys.size > 0 && <b className="ml-1 text-red-600">· 중복 의심 {dupKeys.size}개</b>}
          </span>
          <span className="flex-1" />
          <Link to="/invoices" className="btn-primary h-8 text-[12px]">
            ＋ 계산서정리 파일 업로드
          </Link>
        </div>
        {!files.length ? (
          <Empty>올린 계산서가 없습니다. 계산서 메뉴에서 계산서정리 파일을 올리거나 '예전 자료 가져오기'를 쓰세요.</Empty>
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="tbl text-[12.5px]">
              <thead className="sticky top-0 z-[1]">
                <tr>
                  <th>반영 월</th>
                  <th>파일명</th>
                  <th>업체</th>
                  <th className="num">현장</th>
                  <th className="num">줄</th>
                  <th className="num">금액</th>
                  <th>올린 때</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {byMonth.map(([m, fs]) => (
                  <Fragment key={m}>
                    <tr className="bg-canvas font-semibold">
                      <td colSpan={3}>
                        {mLong(m)} <span className="font-normal text-muted">파일 {fs.length}개 · 업체 {new Set(fs.map((f) => f.vendor)).size}곳</span>
                      </td>
                      <td className="num">{new Set(fs.flatMap((f) => f.invs.map((i) => i.siteId))).size}</td>
                      <td className="num">{fs.reduce((a, f) => a + f.lines, 0).toLocaleString()}</td>
                      <td className="num">{fmtA(fs.reduce((a, f) => a + f.amt, 0))}</td>
                      <td></td>
                      <td>
                        <button className="btn-ghost h-7 text-[12px] text-red-600" disabled={!!busy} onClick={() => removeMonth(m, fs)}>
                          {busy === 'm:' + m ? '삭제 중…' : '월 전체 삭제'}
                        </button>
                      </td>
                    </tr>
                    {fs.map((f) => (
                      <Fragment key={f.key}>
                        <tr>
                          <td>
                            <input type="month" className="input h-7 w-36" defaultValue={f.month} disabled={!!busy} onBlur={(e) => (e.target.value !== f.month ? moveMonth(f, e.target.value) : undefined)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                          </td>
                          <td className="max-w-[340px]">
                            <button className="text-left hover:underline" onClick={() => setOpen((s) => (s.has(f.key) ? (s.delete(f.key), new Set(s)) : new Set(s).add(f.key)))}>
                              <b>{f.name}</b>
                            </button>
                            <span className="chip ml-1 bg-slate-100 text-[11px] text-slate-600">{SRC[f.source]}</span>
                            {f.pending && <span className="chip ml-1 bg-amber-50 text-[11px] text-amber-700">반영 전</span>}
                            {dupKeys.has(f.key) && <span className="chip ml-1 bg-red-50 text-[11px] text-red-600">중복</span>}
                          </td>
                          <td>{f.vendor}</td>
                          <td className="num">{f.invs.length}</td>
                          <td className="num">{f.lines.toLocaleString()}</td>
                          <td className="num">{fmtA(f.amt)}</td>
                          <td className="whitespace-nowrap text-[12px] text-muted">
                            {f.at ? new Date(f.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                            {f.by ? ` · ${f.by}` : ''}
                          </td>
                          <td>
                            <button className="btn-ghost h-7 text-[12px] text-red-600" disabled={!!busy} onClick={() => removeFile(f)}>
                              {busy === f.key ? '처리 중…' : '삭제'}
                            </button>
                          </td>
                        </tr>
                        {open.has(f.key) &&
                          f.invs.map((i) => (
                            <tr key={i.id} className="text-[12px] text-muted">
                              <td></td>
                              <td colSpan={2}>
                                └ {siteName(i.siteId)} <span className="text-[11px]">({i.sheetName})</span>
                              </td>
                              <td></td>
                              <td className="num">{i.lines.length.toLocaleString()}</td>
                              <td className="num">{fmtA(amtOf(i))}</td>
                              <td colSpan={2}>{i.appliedToLedger ? '투입집계 반영' : '기록용'}</td>
                            </tr>
                          ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
          파일명을 누르면 현장별 내역이 펼쳐집니다. 반영 월을 잘못 넣었으면 왼쪽 월 칸에서 바로 바꿀 수 있습니다. 같은 파일을 계산서 메뉴에서 다시 올리면 같은 월·업체·현장 자료는 교체되어 중복되지 않습니다.
        </p>
      </div>
      <SiteManage invoices={invoices} sites={sites} excluded={excluded} />
    </div>
  );
}
