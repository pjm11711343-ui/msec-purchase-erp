import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useSites } from '../../lib/hooks';
import { purgeReq, restoreReq, useRequisitions } from '../../lib/reqs';
import { audit } from '../../lib/db';
import { won } from '../../lib/normalize';
import { Empty, errMsg, PageHeader, useToast } from '../../components/ui';
import { REQ_STATUS_LABEL, type ReqStatus, type Requisition } from '../../types';

const STATUS_COLOR: Record<ReqStatus, string> = {
  draft: 'bg-line text-muted',
  pending: 'bg-amber-soft text-amber-800',
  approved: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-600',
};

export function StatusChip({ s }: { s: ReqStatus }) {
  return <span className={`chip ${STATUS_COLOR[s]}`}>{REQ_STATUS_LABEL[s]}</span>;
}

/** 현장 소장 칸: 승인하면 앞쪽 현장 결재가 끝난 것으로 본다 */
export const isSiteHead = (label: string) => /소장/.test(label);
/** 본사 팀장 칸: 본사 담당 승인 전에도 먼저 결재(전결) 가능 */
export const isTeamLead = (label: string) => /팀장/.test(label);
/** 대표 칸: 승인하면 문서가 바로 최종 승인 */
export const isCeo = (label: string) => /대표/.test(label);

/** from 이후 결재자가 지정돼 있고 아직 결과가 없는 첫 칸 (-1 = 없음) */
export function nextActive(steps: Requisition['steps'], from: number): number {
  for (let i = from; i < steps.length; i++) if (steps[i].userId && !steps[i].result) return i;
  return -1;
}

/** 내가 지금 결재할 수 있는 칸 (-1 = 없음). 내 차례이거나, 뒤쪽 소장·팀장·대표 칸이 나라면 전결 */
export function myDecideStep(r: Requisition, uid?: string, isAdmin?: boolean): number {
  if (r.status !== 'pending' || !uid) return -1;
  const cur = r.currentStep;
  if (r.steps[cur]?.userId === uid) return cur;
  if (isAdmin && !r.steps[cur]?.userId) return cur;
  for (let j = cur + 1; j < r.steps.length; j++) {
    const s = r.steps[j];
    if (s.userId === uid && !s.result && (isSiteHead(s.label) || isTeamLead(s.label) || isCeo(s.label))) return j;
  }
  return -1;
}

export function isMyTurn(r: Requisition, uid?: string, isAdmin?: boolean) {
  return myDecideStep(r, uid, isAdmin) >= 0;
}

export default function ReqList() {
  const { profile, can, readOnly } = useAuth();
  const reqs = useRequisitions();
  const toast = useToast();
  const sites = useSites();
  const [tab, setTab] = useState<'inbox' | 'mine' | 'all' | 'trash'>('all');
  const [busyId, setBusyId] = useState('');
  const [site, setSite] = useState('');
  const [status, setStatus] = useState<'' | ReqStatus>('');
  const [q, setQ] = useState('');
  const [proc, setProc] = useState(''); // 공정 이름 필터

  const inbox = reqs.data.filter((r) => isMyTurn(r, profile?.id, can('admin')));
  const shown = useMemo(() => {
    let l = tab === 'inbox' ? inbox : tab === 'mine' ? reqs.data.filter((r) => r.createdBy === profile?.id) : reqs.data;
    if (site) l = l.filter((r) => r.siteId === site);
    if (status) l = l.filter((r) => r.status === status);
    if (proc) l = l.filter((r) => (proc === '-' ? !r.processName : (r.processName ?? '').startsWith(proc)));
    const k = q.trim().toLowerCase();
    if (k) l = l.filter((r) => [r.docNo, r.siteName, r.processName, r.createdByName, r.purpose, ...r.lines.map((x) => x.itemName)].join(' ').toLowerCase().includes(k));
    return l;
  }, [tab, inbox, reqs.data, site, status, q, profile?.id, proc]);
  const procNames = useMemo(() => [...new Set(reqs.data.filter((r) => !site || r.siteId === site).map((r) => r.processName).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'ko')), [reqs.data, site]);
  const trashShown = useMemo(() => {
    let l = reqs.trash;
    if (site) l = l.filter((r) => r.siteId === site);
    const k = q.trim().toLowerCase();
    if (k) l = l.filter((r) => [r.docNo, r.siteName, r.createdByName, r.deletedByName, r.purpose, ...r.lines.map((x) => x.itemName)].join(' ').toLowerCase().includes(k));
    return l;
  }, [reqs.trash, site, q]);

  const Tab = ({ id, label, n }: { id: typeof tab; label: string; n?: number }) => (
    <button
      className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${tab === id ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas'}`}
      onClick={() => setTab(id)}
    >
      {label}
      {n ? <span className="ml-1.5 rounded-full bg-amber-brand px-1.5 text-[11px] text-navy-950">{n}</span> : null}
    </button>
  );

  return (
    <div>
      <PageHeader
        title="구매청구"
        desc="현장에서 청구서를 작성해 결재에 올리고, 결재가 끝나면 3단계에서 업체별 발주로 넘어갑니다."
        actions={
          !readOnly && (
            <>
              <Link to="/process" className="btn-ghost">
                공정별 청구 현황
              </Link>
              <Link to="/req/new" className="btn-primary">
                + 청구서 작성
              </Link>
            </>
          )
        }
      />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Tab id="all" label="전체" />
          <Tab id="inbox" label="결재함" n={inbox.length} />
          <Tab id="mine" label="내가 쓴 청구" />
          <Tab id="trash" label={`휴지통${reqs.trash.length ? ` ${reqs.trash.length}` : ''}`} />
          <div className="ml-auto flex flex-wrap gap-2">
            <select className="input h-7" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="input h-7" value={proc} onChange={(e) => setProc(e.target.value)}>
              <option value="">전체 공정</option>
              {procNames.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value="-">(공정 없음)</option>
            </select>
            <select className="input h-7" value={status} onChange={(e) => setStatus(e.target.value as ReqStatus | '')}>
              <option value="">전체 상태</option>
              {(Object.keys(REQ_STATUS_LABEL) as ReqStatus[]).map((s) => (
                <option key={s} value={s}>
                  {REQ_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <input className="input h-7 w-48" placeholder="결의번호·품명 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {tab === 'trash' ? (
          !trashShown.length ? (
            <Empty>휴지통이 비어 있습니다. 청구서를 삭제하면 여기로 옮겨지고, 다시 복원할 수 있습니다.</Empty>
          ) : (
            <div className="max-h-[calc(100vh-220px)] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>삭제일</th>
                    <th>삭제한 사람</th>
                    <th>청구일</th>
                    <th>결의번호</th>
                    <th>현장</th>
                    <th>품목</th>
                    <th className="num">금액</th>
                    <th>삭제 전 상태</th>
                    <th>작성자</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {trashShown.map((r) => (
                    <tr key={r.id} className="text-muted">
                      <td className="whitespace-nowrap">{r.deletedAt ? new Date(r.deletedAt).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</td>
                      <td>{r.deletedByName}</td>
                      <td className="whitespace-nowrap">{r.requestDate}</td>
                      <td>
                        <Link to={`/req/${r.id}`} className="font-semibold text-navy-900 hover:underline">
                          {r.docNo || '(번호 없음)'}
                        </Link>
                      </td>
                      <td>{r.siteName}</td>
                      <td className="max-w-[260px] truncate">
                        {r.lines[0]?.itemName}
                        {r.lines.length > 1 && ` 외 ${r.lines.length - 1}건`}
                      </td>
                      <td className="num">{won(r.totalAmount)}</td>
                      <td>
                        <StatusChip s={r.status} />
                      </td>
                      <td>{r.createdByName}</td>
                      <td className="whitespace-nowrap text-right">
                        {!readOnly && (r.deletedBy === profile?.id || can('admin', 'material')) && (
                          <button
                            className="btn-ghost h-7 text-[12px]"
                            disabled={busyId === r.id}
                            onClick={async () => {
                              setBusyId(r.id);
                              try {
                                await restoreReq(r, profile?.name ?? '');
                                await audit('구매청구 복원', r.id, { docNo: r.docNo });
                                toast('복원했습니다.');
                              } catch (e) {
                                toast(errMsg(e), 'err');
                              } finally {
                                setBusyId('');
                              }
                            }}
                          >
                            복원
                          </button>
                        )}
                        {can('admin') && (
                          <button
                            className="ml-1 h-7 px-2 text-[12px] text-red-600 hover:underline"
                            disabled={busyId === r.id}
                            onClick={async () => {
                              if (!confirm(`${r.siteName} ${r.docNo || r.requestDate} 청구서를 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;
                              setBusyId(r.id);
                              try {
                                await purgeReq(r);
                                await audit('구매청구 영구 삭제', r.id, { docNo: r.docNo });
                                toast('영구 삭제했습니다.');
                              } catch (e) {
                                toast(errMsg(e), 'err');
                              } finally {
                                setBusyId('');
                              }
                            }}
                          >
                            영구 삭제
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !shown.length ? (
          <Empty>{reqs.loading ? '불러오는 중…' : tab === 'inbox' ? '결재할 청구서가 없습니다.' : '청구서가 없습니다.'}</Empty>
        ) : (
          <>
          {/* 폰: 카드 목록 */}
          <div className="flex flex-col gap-2 bg-canvas p-2 md:hidden">
            {shown.map((r) => {
              const mine = isMyTurn(r, profile?.id, can('admin'));
              return (
                <Link key={r.id} to={`/req/${r.id}`} className="flex flex-col gap-1.5 rounded-xl border border-line bg-white p-3 active:bg-amber-soft/40">
                  <div className="flex items-center gap-2">
                    <StatusChip s={r.status} />
                    {mine && <span className="chip bg-amber-brand text-navy-950">내 차례</span>}
                    <span className="ml-auto text-[11.5px] text-muted">{r.requestDate}</span>
                  </div>
                  <div className="text-[14.5px] font-bold text-navy-950">
                    {r.siteName} · {r.docNo || '(번호 없음)'}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                    {r.processName && <span className="chip bg-navy-950/5 text-navy-900">{r.processName}</span>}
                    <span className="truncate">
                      {r.lines[0]?.itemName}
                      {r.lines.length > 1 && ` 외 ${r.lines.length - 1}건`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11.5px] text-muted">
                      {r.createdByName}
                      {r.status === 'pending' && ` · ${r.steps[r.currentStep]?.label ?? ''} ${r.steps[r.currentStep]?.userName ?? ''}`}
                    </span>
                    <span className="text-[14px] font-bold">{won(r.totalAmount)}원</span>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="hidden max-h-[calc(100vh-220px)] overflow-auto md:block">
            <table className="tbl">
              <thead>
                <tr>
                  <th>청구일</th>
                  <th>결의번호</th>
                  <th>현장</th>
                  <th>공정</th>
                  <th>품목</th>
                  <th className="num">금액</th>
                  <th>상태</th>
                  <th>결재 진행</th>
                  <th>작성자</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{r.requestDate}</td>
                    <td>
                      <Link to={`/req/${r.id}`} className="font-semibold text-navy-900 hover:text-amber-700 hover:underline">
                        {r.docNo || '(번호 없음)'}
                      </Link>
                    </td>
                    <td>{r.siteName}</td>
                    <td className="whitespace-nowrap">{r.processName ? <span className="chip bg-navy-950/5 text-navy-900">{r.processName}</span> : <span className="text-muted">-</span>}</td>
                    <td className="max-w-[320px] truncate text-muted">
                      {r.lines[0]?.itemName}
                      {r.lines.length > 1 && ` 외 ${r.lines.length - 1}건`}
                    </td>
                    <td className="num">{won(r.totalAmount)}</td>
                    <td>
                      <StatusChip s={r.status} />
                    </td>
                    <td>
                      <div className="flex gap-0.5">
                        {r.steps.map((s, i) => (
                          <span
                            key={i}
                            title={`${s.label} ${s.userName ?? ''}`}
                            className={`h-2 w-5 rounded-full ${s.result === 'approved' ? 'bg-emerald-500' : s.result === 'rejected' ? 'bg-red-500' : r.status === 'pending' && i === r.currentStep ? 'bg-amber-brand' : 'bg-line'}`}
                          />
                        ))}
                      </div>
                      {r.status === 'pending' && <div className="mt-0.5 text-[11px] text-muted">{r.steps[r.currentStep]?.label} {r.steps[r.currentStep]?.userName}</div>}
                    </td>
                    <td className="text-muted">{r.createdByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
