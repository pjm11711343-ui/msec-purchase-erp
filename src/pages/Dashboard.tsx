import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../lib/db';
import { summarize, useLedger, useSiteCategories, useSites } from '../lib/hooks';
import { pct, won } from '../lib/normalize';
import { Empty, PageHeader, RateBar, Stat } from '../components/ui';
import { useRequisitions } from '../lib/reqs';
import { pendingLines, usePurchaseOrders } from '../lib/pos';
import { isMyTurn } from './req/ReqList';

export default function Dashboard() {
  const { profile, can } = useAuth();
  const settings = useSettings();
  const sites = useSites();
  const cats = useSiteCategories();
  const ledger = useLedger();
  const reqs = useRequisitions();
  const inbox = reqs.data.filter((r) => isMyTurn(r, profile?.id, can('admin')));
  const pending = reqs.data.filter((r) => r.status === 'pending').length;
  const pos = usePurchaseOrders();
  const waitLines = pendingLines(reqs.data, pos.data);
  const approvedWait = new Set(waitLines.map((p) => p.req.id)).size;
  const unsent = pos.data.filter((p) => p.status === 'issued').length;

  const cards = useMemo(
    () =>
      sites.data
        .filter((s) => s.active)
        .map((s) => {
          const { rows, months } = summarize(
            cats.data.filter((c) => c.siteId === s.id),
            ledger.data.filter((e) => e.siteId === s.id),
          );
          const exec = rows.reduce((a, r) => a + r.cat.execAmount, 0);
          const input = rows.reduce((a, r) => a + r.input, 0);
          const lastMonth = months.at(-1);
          const last = lastMonth ? rows.reduce((a, r) => a + (r.byMonth[lastMonth] ?? 0), 0) : 0;
          const over = rows.filter((r) => r.cat.execAmount && r.rate > 1).length;
          const unassigned = rows.filter((r) => !r.cat.standardCategoryId).length;
          return { s, exec, input, rate: exec ? input / exec : 0, lastMonth, last, over, unassigned, count: rows.length };
        }),
    [sites.data, cats.data, ledger.data],
  );
  const exec = cards.reduce((a, c) => a + c.exec, 0);
  const input = cards.reduce((a, c) => a + c.input, 0);
  const overSites = cards.filter((c) => c.over > 0).length;

  return (
    <div>
      <PageHeader title={`${profile?.name ?? ''}님, 안녕하세요`} desc={`이관 기준월 ${settings.cutoffMonth} · 진행 현장 ${cards.length}곳`} />
      {inbox.length > 0 && (
        <Link to="/req" className="fade-up mb-4 flex items-center justify-between rounded-2xl border border-amber-brand bg-amber-soft px-4 py-3 transition hover:shadow-md">
          <span className="font-semibold text-navy-950">결재할 구매청구서가 {inbox.length}건 있습니다</span>
          <span className="text-[12px] text-amber-800">결재함 열기 →</span>
        </Link>
      )}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="결재중 청구" value={`${pending}건`} />
        <Stat label="발주 대기" value={`${waitLines.length}줄`} sub={`승인된 청구서 ${approvedWait}건`} />
        <Stat label="미발송 발주서" value={`${unsent}건`} sub="발주서를 보낸 뒤 '발송 완료'로 표시" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="실행금액 합계" value={won(exec)} />
        <Stat label="투입금액 합계" value={won(input)} />
        <Stat label="실행 대비 투입률" value={pct(input, exec)} accent sub={<RateBar rate={exec ? input / exec : 0} />} />
        <Stat label="실행 초과 분류가 있는 현장" value={`${overSites}곳`} sub="분류 하나라도 투입이 실행을 넘은 현장" />
      </div>
      {cards.length === 0 ? (
        <div className="card">
          <Empty>
            {sites.loading
              ? '불러오는 중…'
              : can('admin', 'material')
                ? '아직 현장이 없습니다. 왼쪽 "청구서 파일 이관"에서 기존 현장을 가져오세요.'
                : '담당 현장이 없습니다. 관리자에게 담당 현장 지정을 요청하세요.'}
          </Empty>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <Link
              key={c.s.id}
              to={`/summary?site=${c.s.id}`}
              className="card fade-up group px-4 py-3.5 transition hover:-translate-y-0.5 hover:border-amber-brand hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] font-medium text-muted">
                    {c.s.code} · {c.s.trade}
                  </div>
                  <div className="text-[15px] font-semibold text-navy-950">{c.s.name}</div>
                </div>
                <div className={`text-[18px] font-bold tabular-nums ${c.rate > 1 ? 'text-red-600' : 'text-navy-950'}`}>{pct(c.input, c.exec)}</div>
              </div>
              <div className="my-2">
                <RateBar rate={c.rate} />
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-[12px]">
                <span className="text-muted">실행</span>
                <span className="text-right tabular-nums">{won(c.exec)}</span>
                <span className="text-muted">투입</span>
                <span className="text-right tabular-nums">{won(c.input)}</span>
                <span className="text-muted">{c.lastMonth ? `${c.lastMonth} 투입` : '이후 계산서'}</span>
                <span className="text-right tabular-nums">{c.lastMonth ? won(c.last) : '없음'}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {c.over > 0 && <span className="chip bg-red-50 text-red-600">실행 초과 {c.over}개 분류</span>}
                {c.unassigned > 0 && can('admin', 'material') && (
                  <span className="chip bg-amber-soft text-amber-800">표준분류 미지정 {c.unassigned}개</span>
                )}
                {c.count === 0 && <span className="chip bg-line text-muted">분류 없음</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
