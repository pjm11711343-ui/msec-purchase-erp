import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../auth/AuthContext';
import { audit, commitBatch, useSettings } from '../lib/db';
import { C } from '../lib/firebase';
import { summarize, useLedger, useSiteCategories, useSites, useStandardCategories } from '../lib/hooks';
import { num, pct, won } from '../lib/normalize';
import { Empty, errMsg, PageHeader, RateBar, Stat, useToast } from '../components/ui';

type Editable = 'contractAmount' | 'changeAmount' | 'execAmount' | 'migratedInput';

export default function Summary() {
  const { can } = useAuth();
  const settings = useSettings();
  const sites = useSites();
  const cats = useSiteCategories();
  const ledger = useLedger();
  const std = useStandardCategories();
  const toast = useToast();
  const [siteId, setSiteId] = useState(() => new URLSearchParams(location.search).get('site') ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, Partial<Record<Editable, string>>>>({});
  const [showMonths, setShowMonths] = useState(true);

  useEffect(() => {
    if (!siteId && sites.data.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);

  const site = sites.data.find((s) => s.id === siteId);
  const { rows, months } = useMemo(
    () =>
      summarize(
        cats.data.filter((c) => c.siteId === siteId),
        ledger.data.filter((e) => e.siteId === siteId),
      ),
    [cats.data, ledger.data, siteId],
  );
  const tot = rows.reduce(
    (a, r) => ({
      contract: a.contract + r.cat.contractAmount,
      change: a.change + r.cat.changeAmount,
      exec: a.exec + r.cat.execAmount,
      migrated: a.migrated + r.migrated,
      after: a.after + r.afterCutoff,
      input: a.input + r.input,
    }),
    { contract: 0, change: 0, exec: 0, migrated: 0, after: 0, input: 0 },
  );
  const monthTotal = (m: string) => rows.reduce((a, r) => a + (r.byMonth[m] ?? 0), 0);
  const stdName = (id?: string) => std.data.find((s) => s.id === id)?.name;
  const canEdit = can('admin', 'material');

  const exportExcel = () => {
    if (!site) return;
    const wb = XLSX.utils.book_new();
    const main: (string | number)[][] = [['품명', '도급금액', '변경예상금액', '실행금액', '투입금액']];
    rows.forEach((r) => main.push([r.cat.name, r.cat.contractAmount, r.cat.changeAmount, r.cat.execAmount, r.input]));
    main.push(['합   계', tot.contract, tot.change, tot.exec, tot.input]);
    const ws1 = XLSX.utils.aoa_to_sheet(main);
    ws1['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws1, '투입집계');
    const head = ['품명', '표준분류', `이관(~${settings.cutoffMonth})`, ...months, '투입 합계', '실행금액', '실행 대비', '실행 잔여'];
    const detail: (string | number)[][] = [head];
    rows.forEach((r) =>
      detail.push([
        r.cat.name,
        stdName(r.cat.standardCategoryId) ?? '',
        r.migrated,
        ...months.map((m) => r.byMonth[m] ?? 0),
        r.input,
        r.cat.execAmount,
        r.cat.execAmount ? Number((r.rate * 100).toFixed(1)) : 0,
        r.remain,
      ]),
    );
    detail.push(['합   계', '', tot.migrated, ...months.map(monthTotal), tot.input, tot.exec, tot.exec ? Number(((tot.input / tot.exec) * 100).toFixed(1)) : 0, tot.exec - tot.input]);
    const ws2 = XLSX.utils.aoa_to_sheet(detail);
    ws2['!cols'] = head.map((_, i) => ({ wch: i === 0 ? 30 : 14 }));
    XLSX.utils.book_append_sheet(wb, ws2, '월별 투입');
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `투입집계_${site.name}_${today}.xlsx`);
  };

  const saveEdits = async () => {
    try {
      const ops = Object.entries(draft).map(([id, d]) => ({
        type: 'set' as const,
        col: C.siteCategories,
        id,
        data: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(num(v))])),
      }));
      if (ops.length) {
        await commitBatch(ops);
        await audit('투입집계 금액 수정', siteId, { count: ops.length });
        toast(`${ops.length}개 분류 금액을 저장했습니다.`);
      }
      setEditing(false);
      setDraft({});
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const cellInput = (id: string, k: Editable, v: number) =>
    editing ? (
      <input
        className="input h-7 w-28 text-right"
        value={draft[id]?.[k] ?? String(v)}
        onChange={(e) => setDraft((d) => ({ ...d, [id]: { ...d[id], [k]: e.target.value } }))}
      />
    ) : (
      won(v)
    );

  return (
    <div>
      <PageHeader
        title="투입집계"
        desc={`실행금액 대비 투입금액. 투입 = 이관 시작 잔액(~${settings.cutoffMonth}) + 이후 월 계산서`}
        actions={
          <>
            <select className="input w-64" value={siteId} onChange={(e) => (setSiteId(e.target.value), setEditing(false), setDraft({}))}>
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.name}
                </option>
              ))}
            </select>
            <button className="btn-ghost" onClick={() => setShowMonths((v) => !v)}>
              {showMonths ? '월별 숨기기' : '월별 보기'}
            </button>
            {canEdit &&
              (editing ? (
                <>
                  <button className="btn-ghost" onClick={() => (setEditing(false), setDraft({}))}>
                    취소
                  </button>
                  <button className="btn-primary" onClick={saveEdits}>
                    금액 저장
                  </button>
                </>
              ) : (
                <button className="btn-ghost" onClick={() => setEditing(true)} disabled={!rows.length}>
                  금액 수정
                </button>
              ))}
            <button className="btn-dark" onClick={exportExcel} disabled={!rows.length}>
              엑셀 다운로드
            </button>
          </>
        }
      />
      {!site ? (
        <div className="card">
          <Empty>{sites.loading ? '불러오는 중…' : '볼 수 있는 현장이 없습니다. 관리자에게 담당 현장 지정을 요청하세요.'}</Empty>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="도급금액" value={won(tot.contract)} sub={tot.change ? `변경예상 ${won(tot.change)}` : undefined} />
            <Stat label="실행금액" value={won(tot.exec)} />
            <Stat label="투입금액" value={won(tot.input)} sub={`이관 ${won(tot.migrated)} + 이후 ${won(tot.after)}`} />
            <Stat label="실행 대비 투입률" value={pct(tot.input, tot.exec)} accent sub={<RateBar rate={tot.exec ? tot.input / tot.exec : 0} />} />
            <Stat label="실행 잔여" value={won(tot.exec - tot.input)} />
          </div>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>분류</th>
                    <th>표준분류</th>
                    <th className="num">도급</th>
                    <th className="num">변경예상</th>
                    <th className="num">실행</th>
                    <th className="num">이관(~{settings.cutoffMonth})</th>
                    {showMonths && months.map((m) => <th key={m} className="num">{m}</th>)}
                    <th className="num">투입 합계</th>
                    <th className="w-40">실행 대비</th>
                    <th className="num">실행 잔여</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.cat.id}>
                      <td className="font-medium">{r.cat.name}</td>
                      <td className="text-muted">{stdName(r.cat.standardCategoryId) ?? <span className="text-amber-700">미지정</span>}</td>
                      <td className="num">{cellInput(r.cat.id, 'contractAmount', r.cat.contractAmount)}</td>
                      <td className="num">{cellInput(r.cat.id, 'changeAmount', r.cat.changeAmount)}</td>
                      <td className="num">{cellInput(r.cat.id, 'execAmount', r.cat.execAmount)}</td>
                      <td className="num">{cellInput(r.cat.id, 'migratedInput', r.migrated)}</td>
                      {showMonths &&
                        months.map((m) => (
                          <td key={m} className="num">
                            {r.byMonth[m] ? won(r.byMonth[m]) : ''}
                          </td>
                        ))}
                      <td className="num font-semibold">{won(r.input)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className={`w-12 text-right text-[12px] tabular-nums ${r.rate > 1 ? 'font-semibold text-red-600' : ''}`}>
                            {r.cat.execAmount ? pct(r.input, r.cat.execAmount) : '-'}
                          </span>
                          <RateBar rate={r.rate} />
                        </div>
                      </td>
                      <td className={`num ${r.remain < 0 ? 'text-red-600' : ''}`}>{won(r.remain)}</td>
                    </tr>
                  ))}
                  <tr className="bg-[#f7f8fb] font-semibold">
                    <td>합계</td>
                    <td></td>
                    <td className="num">{won(tot.contract)}</td>
                    <td className="num">{won(tot.change)}</td>
                    <td className="num">{won(tot.exec)}</td>
                    <td className="num">{won(tot.migrated)}</td>
                    {showMonths && months.map((m) => <td key={m} className="num">{won(monthTotal(m))}</td>)}
                    <td className="num">{won(tot.input)}</td>
                    <td className="text-right tabular-nums">{pct(tot.input, tot.exec)}</td>
                    <td className="num">{won(tot.exec - tot.input)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {!rows.length && <Empty>이 현장에는 분류가 없습니다. 청구서 파일 이관에서 가져오세요.</Empty>}
          </div>
        </>
      )}
    </div>
  );
}
