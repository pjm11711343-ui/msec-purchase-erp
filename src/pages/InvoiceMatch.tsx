import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { documentId, where } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { audit, useCollection, useSettings } from '../lib/db';
import { C } from '../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../lib/hooks';
import { suggestCats } from '../lib/catMatch';
import { autoMatch, billedMap, candidatesFor, lineQty, linePrice, matchSummary, rebuildLedger } from '../lib/matching';
import { won } from '../lib/normalize';
import { usePurchaseOrders } from '../lib/pos';
import { poLineKey, useReceipts } from '../lib/receipts';
import { Empty, errMsg, PageHeader, Stat, useToast } from '../components/ui';
import type { Invoice, InvoiceLine } from '../types';

const ISSUE_TEXT: Record<string, string> = {
  미발주: '같은 업체·현장·품명·규격의 발주가 없습니다',
  수량초과: '입고된 수량보다 많이 청구했습니다',
  단가차이: '발주 단가와 다릅니다',
  미입고: '발주는 있지만 입고 기록이 없습니다',
};

export default function InvoiceMatch() {
  const { id } = useParams();
  const { profile } = useAuth();
  const settings = useSettings();
  const toast = useToast();
  const pos = usePurchaseOrders();
  const receipts = useReceipts();
  const sites = useSites();
  const cats = useSiteCategories();
  const std = useStandardCategories();
  const one = useCollection<Invoice>(C.invoices, [where(documentId(), '==', id ?? '_')], id ?? '');
  const inv0 = one.data[0];
  const sameVendor = useCollection<Invoice>(C.invoices, [where('vendorId', '==', inv0?.vendorId ?? '_')], inv0?.vendorId ?? '', !!inv0);
  const [lines, setLines] = useState<InvoiceLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyIssue, setOnlyIssue] = useState(false);
  const [onlyNoCat, setOnlyNoCat] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkCat, setBulkCat] = useState('');

  useEffect(() => {
    if (inv0 && !lines) setLines(structuredClone(inv0.lines));
  }, [inv0, lines]);

  const billed = useMemo(() => (inv0 ? billedMap(sameVendor.data, inv0.id) : new Map<string, number>()), [sameVendor.data, inv0]);
  if (!inv0 || !lines) return <div className="text-muted">{one.loading ? '불러오는 중…' : '계산서를 찾을 수 없습니다.'}</div>;
  const inv: Invoice = { ...inv0, lines };
  const sum = matchSummary(inv);
  const siteCats = cats.data.filter((c) => c.siteId === inv.siteId).sort((a, b) => a.order - b.order);
  const catName = (cid?: string) => cats.data.find((c) => c.id === cid)?.name;
  const dirty = JSON.stringify(lines) !== JSON.stringify(inv0.lines);

  const runAuto = () => {
    setLines(autoMatch({ ...inv0, lines }, pos.data, receipts.data, sameVendor.data, settings.priceTolerance));
    toast('자동매칭을 다시 돌렸습니다. 확인 후 저장하세요.');
  };

  const setLine = (i: number, patch: Partial<InvoiceLine>) => setLines((ls) => ls && ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async (apply?: boolean) => {
    setBusy(true);
    try {
      const next: Invoice = {
        ...inv,
        ...(apply ? { appliedToLedger: true, submitted: false, appliedAt: Date.now(), lines: lines.map((l) => (l.matchStatus === 'migrated' ? { ...l, matchStatus: 'unmatched' } : l)) } : {}),
      };
      const { id: _id, ...data } = next;
      void _id;
      await rebuildLedger(next, [{ type: 'set', col: C.invoices, id: inv.id, data, merge: false }]);
      await audit(apply ? '업체 거래명세 원장 반영' : '계산서 매칭 저장', inv.id, { ok: sum.ok, total: sum.total });
      toast(apply ? '투입원장에 반영했습니다.' : '저장했습니다. 투입원장도 다시 계산했습니다.');
      setLines(null);
      setPicked(new Set());
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const shown = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (!onlyIssue || (l.matchStatus === 'unmatched' && l.matchIssue)) && (!onlyNoCat || !l.siteCategoryId));
  const allPicked = shown.length > 0 && shown.every(({ i }) => picked.has(i));
  const togglePick = (i: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  /** 체크한 줄 일괄 변경 */
  const applyBulk = (patch: (l: InvoiceLine) => Partial<InvoiceLine>) => {
    setLines((ls) => ls && ls.map((l, j) => (picked.has(j) ? { ...l, ...patch(l) } : l)));
    toast(`${picked.size}줄을 바꿨습니다. 확인 후 저장하세요.`);
    setPicked(new Set());
    setBulkCat('');
  };
  const pickedLines = lines.filter((_, j) => picked.has(j));
  const canAccept = pickedLines.some((l) => l.matchStatus === 'unmatched' && l.poId);
  const before = inv.month <= settings.cutoffMonth && !inv.submitted;

  return (
    <div>
      <PageHeader
        title={`계산서 매칭 · ${inv.month} ${inv.vendorName}`}
        desc={`${sites.data.find((s) => s.id === inv.siteId)?.name ?? ''} · ${inv.source === 'portal' ? '업체 포털 제출' : inv.fileName} · ${won(inv.totalAmount)}원`}
        actions={
          <>
            <Link to="/invoices" className="btn-ghost">
              목록
            </Link>
            {!before && (
              <button className="btn-ghost" onClick={runAuto} disabled={pos.loading || receipts.loading}>
                자동매칭 다시
              </button>
            )}
            {inv.submitted ? (
              <button className="btn-primary" disabled={busy} onClick={() => save(true)}>
                확인 후 투입원장 반영
              </button>
            ) : (
              <button className="btn-primary" disabled={busy || !dirty} onClick={() => save()}>
                저장
              </button>
            )}
          </>
        }
      />
      {before && <div className="mb-4 rounded-xl bg-canvas px-4 py-3 text-muted">기준월({settings.cutoffMonth}) 이전 계산서는 이관 잔액에 이미 들어 있어 매칭하지 않습니다. 기록으로만 보관합니다.</div>}
      {inv.submitted && (
        <div className="mb-4 rounded-xl border border-amber-brand bg-amber-soft px-4 py-3">
          업체가 포털에서 제출한 거래명세입니다. 줄과 금액을 확인하고 <b>투입원장 반영</b>을 누르면 투입집계에 더해집니다. ({inv.uploadedBy}, {inv.submittedAt ? new Date(inv.submittedAt).toLocaleString('ko-KR') : ''})
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="매칭 완료" value={`${sum.ok} / ${sum.total}줄`} accent />
        {(['미발주', '수량초과', '단가차이', '미입고'] as const).map((k) => (
          <Stat key={k} label={k} value={`${sum.issues[k] ?? 0}줄`} sub={ISSUE_TEXT[k]} />
        ))}
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">계산서 줄 {lines.length}</span>
          {dirty && <span className="chip bg-amber-soft text-amber-800">저장 안 됨</span>}
          <label className="ml-auto flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={onlyNoCat} onChange={(e) => (setOnlyNoCat(e.target.checked), setPicked(new Set()))} /> 미분류만
          </label>
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={onlyIssue} onChange={(e) => (setOnlyIssue(e.target.checked), setPicked(new Set()))} /> 문제 있는 줄만
          </label>
        </div>
        {picked.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-soft px-4 py-2 text-[12.5px]">
            <span className="font-semibold">{picked.size}줄 선택</span>
            <span className="text-muted">현장분류 →</span>
            <select className="input h-7 w-48" value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
              <option value="">선택</option>
              <option value="__none__">미분류로 되돌리기</option>
              {siteCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="btn-dark h-7 text-[12px]" disabled={!bulkCat} onClick={() => applyBulk(() => ({ siteCategoryId: bulkCat === '__none__' ? undefined : bulkCat }))}>
              일괄 변경
            </button>
            {!before && canAccept && (
              <button className="btn-ghost h-7 text-[12px]" title="발주가 연결된 문제 줄을 확인하고 그대로 인정" onClick={() => applyBulk((l) => (l.matchStatus === 'unmatched' && l.poId ? { matchStatus: 'manual', matchIssue: undefined } : {}))}>
                일괄 인정
              </button>
            )}
            <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => setPicked(new Set())}>
              선택 해제
            </button>
          </div>
        )}
        {!shown.length ? (
          <Empty>표시할 줄이 없습니다.</Empty>
        ) : (
          <div className="max-h-[calc(100vh-330px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map(({ i }) => i)) : new Set())} />
                  </th>
                  <th>입고일</th>
                  <th>발주일</th>
                  <th>품명</th>
                  <th>규격</th>
                  <th className="num">수량</th>
                  <th className="num">단가</th>
                  <th className="num">금액</th>
                  <th>상태</th>
                  <th>연결 발주</th>
                  <th className="num">발주단가</th>
                  <th className="num">입고/기청구</th>
                  <th>현장분류</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ l, i }) => {
                  const cands = before ? [] : candidatesFor(l, inv, pos.data, receipts.data, billed);
                  const cur = cands.find((c) => c.po.id === l.poId && poLineKey(c.line) === l.poLineKey);
                  const ok = l.matchStatus === 'matched' || l.matchStatus === 'manual';
                  return (
                    <tr key={i} className={picked.has(i) ? 'bg-amber-soft/60' : l.matchStatus === 'unmatched' ? 'bg-red-50/40' : ''}>
                      <td>
                        <input type="checkbox" checked={picked.has(i)} onChange={() => togglePick(i)} />
                      </td>
                      <td className="whitespace-nowrap">{l.receivedDate}</td>
                      <td className="whitespace-nowrap text-muted">{l.orderDate}</td>
                      <td>{l.itemName}</td>
                      <td>{l.spec}</td>
                      <td className="num">{lineQty(l).toLocaleString()}</td>
                      <td className="num">{won(linePrice(l))}</td>
                      <td className="num">{won(l.finalAmount)}</td>
                      <td className="whitespace-nowrap">
                        {l.matchStatus === 'migrated' ? (
                          <span className="chip bg-line text-muted">기록만</span>
                        ) : ok ? (
                          <span className="chip bg-emerald-50 text-emerald-700">{l.matchStatus === 'manual' ? '수동 확인' : '매칭'}</span>
                        ) : (
                          <span className="chip bg-red-50 text-red-600" title={l.matchIssue ? ISSUE_TEXT[l.matchIssue] : ''}>
                            {l.matchIssue ?? '미매칭'}
                          </span>
                        )}
                      </td>
                      <td>
                        {before ? (
                          ''
                        ) : (
                          <div className="flex items-center gap-1">
                            <select
                              className="input h-7 w-56 px-1 text-[12px]"
                              value={cur ? cur.key : ''}
                              onChange={(e) => {
                                const c = cands.find((x) => x.key === e.target.value);
                                setLine(i, c ? { poId: c.po.id, poLineKey: poLineKey(c.line), matchStatus: 'manual', matchIssue: undefined, siteCategoryId: l.siteCategoryId ?? c.line.siteCategoryId } : { poId: undefined, poLineKey: undefined, matchStatus: 'unmatched', matchIssue: '미발주' });
                              }}
                            >
                              <option value="">{cands.length ? '발주 선택' : '후보 없음'}</option>
                              {cands.map((c) => (
                                <option key={c.key} value={c.key}>
                                  {c.po.poNo} · {c.line.qty}
                                  {c.line.unit} · {won(c.line.price)}
                                </option>
                              ))}
                            </select>
                            {l.matchStatus === 'unmatched' && l.poId && (
                              <button className="text-[11px] text-emerald-700 hover:underline" title="문제를 확인하고 그대로 인정" onClick={() => setLine(i, { matchStatus: 'manual', matchIssue: undefined })}>
                                인정
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className={`num ${cur && Math.abs(cur.line.price - linePrice(l)) > settings.priceTolerance ? 'font-semibold text-red-600' : 'text-muted'}`}>{cur ? won(cur.line.price) : ''}</td>
                      <td className="num text-muted">{cur ? `${cur.received} / ${cur.billed}` : ''}</td>
                      <td>
                        <select className={`input h-7 w-36 px-1 text-[12px] ${l.siteCategoryId ? '' : 'border-amber-brand bg-amber-soft'}`} value={l.siteCategoryId ?? ''} onChange={(e) => setLine(i, { siteCategoryId: e.target.value || undefined })}>
                          <option value="">미분류</option>
                          {siteCats.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        {!l.siteCategoryId && l.categoryText && (
                          <div className="text-[10.5px] text-muted">
                            원문: {l.categoryText}
                            {suggestCats(l.categoryText, siteCats, std.data, 2).map((x) => (
                              <button key={x.cat.id} className="ml-1 text-amber-700 hover:underline" title="비슷한 분류로 지정" onClick={() => setLine(i, { siteCategoryId: x.cat.id })}>
                                → {x.cat.name}
                              </button>
                            ))}
                          </div>
                        )}
                        {l.siteCategoryId && catName(l.siteCategoryId) === undefined && <div className="text-[10.5px] text-red-600">삭제된 분류</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        저장하면 이 계산서의 투입원장 금액도 현장분류 기준으로 다시 계산됩니다. 담당: {profile?.name}
      </p>
    </div>
  );
}
