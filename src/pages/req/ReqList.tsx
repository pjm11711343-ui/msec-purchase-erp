import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useSites } from '../../lib/hooks';
import { useRequisitions } from '../../lib/reqs';
import { won } from '../../lib/normalize';
import { Empty, PageHeader } from '../../components/ui';
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

export function isMyTurn(r: Requisition, uid?: string, isAdmin?: boolean) {
  return r.status === 'pending' && (r.currentApproverId === uid || (isAdmin && !r.steps[r.currentStep]?.userId));
}

export default function ReqList() {
  const { profile, can } = useAuth();
  const reqs = useRequisitions();
  const sites = useSites();
  const [tab, setTab] = useState<'inbox' | 'mine' | 'all'>('all');
  const [site, setSite] = useState('');
  const [status, setStatus] = useState<'' | ReqStatus>('');
  const [q, setQ] = useState('');

  const inbox = reqs.data.filter((r) => isMyTurn(r, profile?.id, can('admin')));
  const shown = useMemo(() => {
    let l = tab === 'inbox' ? inbox : tab === 'mine' ? reqs.data.filter((r) => r.createdBy === profile?.id) : reqs.data;
    if (site) l = l.filter((r) => r.siteId === site);
    if (status) l = l.filter((r) => r.status === status);
    const k = q.trim().toLowerCase();
    if (k) l = l.filter((r) => [r.docNo, r.siteName, r.createdByName, r.purpose, ...r.lines.map((x) => x.itemName)].join(' ').toLowerCase().includes(k));
    return l;
  }, [tab, inbox, reqs.data, site, status, q, profile?.id]);

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
          <Link to="/req/new" className="btn-primary">
            + 청구서 작성
          </Link>
        }
      />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Tab id="all" label="전체" />
          <Tab id="inbox" label="결재함" n={inbox.length} />
          <Tab id="mine" label="내가 쓴 청구" />
          <div className="ml-auto flex flex-wrap gap-2">
            <select className="input h-7" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
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
        {!shown.length ? (
          <Empty>{reqs.loading ? '불러오는 중…' : tab === 'inbox' ? '결재할 청구서가 없습니다.' : '청구서가 없습니다.'}</Empty>
        ) : (
          <div className="max-h-[calc(100vh-220px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>청구일</th>
                  <th>결의번호</th>
                  <th>현장</th>
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
        )}
      </div>
    </div>
  );
}
