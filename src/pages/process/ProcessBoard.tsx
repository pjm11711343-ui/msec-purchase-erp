// 구매 흐름 › 공정별 청구
//  - 현황판: 구역 × 공종 표. 칸마다 내역 품목 수·계약금액·기반입률·청구 차수, 새 청구서 바로 만들기
//  - 기본 청구서: 공정별 내역 품목표 (실행수량·이관 기반입 입력, 품목 빼기·더하기, 엑셀)
//  - 공정 설정: 현장에서 쓰는 칸 켜고 끄기
//  - 내역 가져오기: 공정분리 툴 → 구역·공종 맞춤 → 기본 청구서
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories } from '../../lib/hooks';
import { itemKey } from '../../lib/itemMaster';
import { useItemCatalog } from '../../lib/itemCatalog';
import { resolveCat } from '../../lib/catMatch';
import { nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { useRequisitions } from '../../lib/reqs';
import {
  baseLineKey,
  cellKey,
  defaultCells,
  isLumpText,
  listSepProjects,
  loadSepProject,
  mapKeyOf,
  processLabel,
  processPriorMap,
  sectionNames,
  sheetId,
  sortedTrades,
  sortedZones,
  suggestTarget,
  tradeName,
  useBaseSheets,
  useProcessMaster,
  useSiteProcess,
  zoneName,
  type BaseLine,
  type BaseSheet,
  type MapTarget,
  type ProcessMaster,
  type SepItem,
  type SepProject,
  type SiteProcess,
} from '../../lib/process';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';
import type { Requisition, SiteCategory } from '../../types';

type Tab = 'board' | 'sheet' | 'setup' | 'import';
type Toast = ReturnType<typeof useToast>;

/** 기본 청구서 한 칸의 집계 */
function cellStats(sheet: BaseSheet | undefined, prior: Map<string, number>) {
  let contract = 0;
  let exec = 0;
  let done = 0;
  let items = 0;
  for (const l of sheet?.lines ?? []) {
    if (l.off) continue;
    items++;
    const price = l.execPrice || l.contractPrice;
    const pq = (prior.get(itemKey(l.itemName, l.spec)) ?? 0) + (l.priorStart ?? 0);
    contract += l.contractAmount || l.contractQty * l.contractPrice;
    const base = l.execQty || l.contractQty;
    exec += l.lump ? l.contractAmount : base * price;
    done += l.lump ? 0 : Math.min(pq, base || pq) * price;
  }
  return { contract, exec, done, items, rate: exec ? done / exec : 0 };
}

export default function ProcessBoard() {
  const { profile, can } = useAuth();
  const office = can('admin', 'material');
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const sites = useSites();
  const pm = useProcessMaster();
  const reqs = useRequisitions();
  const siteId = sp.get('site') || sites.data[0]?.id || '';
  const tab = (sp.get('tab') as Tab) || 'board';
  const cell = sp.get('cell') || '';
  const set = (p: Record<string, string>) => {
    const n = new URLSearchParams(sp);
    Object.entries(p).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k)));
    setSp(n, { replace: true });
  };
  const sproc = useSiteProcess(siteId);
  const sheets = useBaseSheets(siteId);
  const site = sites.data.find((s) => s.id === siteId);
  const m = pm.master;
  const cells = sproc.data?.cells ?? defaultCells(m);
  const who = profile?.name ?? '';

  const tabs: [Tab, string][] = [
    ['board', '현황판'],
    ['sheet', '기본 청구서'],
    ...(office ? ([['setup', '공정 설정'], ['import', '공정분리 툴에서 내역 가져오기']] as [Tab, string][]) : []),
  ];

  return (
    <div>
      <PageHeader
        title="공정별 청구"
        desc="현장 청구서를 공정(구역 × 공종)마다 따로 관리합니다. 공정마다 기본 청구서(내역 품목)가 있고, 새 청구서는 기본 청구서를 불러와 금회청구 수량만 넣습니다. 계약·실행·기반입·잔여는 같은 공정끼리만 계산합니다."
        actions={
          <select className="input w-56" value={siteId} onChange={(e) => set({ site: e.target.value, cell: '' })}>
            {sites.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name}
              </option>
            ))}
          </select>
        }
      />
      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
        {tabs.map(([k, label]) => (
          <button key={k} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${tab === k ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas hover:text-ink'}`} onClick={() => set({ tab: k })}>
            {label}
          </button>
        ))}
        {sproc.data?.source && (
          <span className="ml-auto self-center pr-2 text-[11.5px] text-muted">
            내역: 공정분리 툴 “{sproc.data.source.projectName}” · {new Date(sproc.data.source.importedAt).toLocaleDateString('ko-KR')} {sproc.data.source.byName}
          </span>
        )}
      </div>
      {!siteId ? (
        <div className="card">
          <Empty>현장이 없습니다.</Empty>
        </div>
      ) : tab === 'board' ? (
        <Board m={m} siteId={siteId} cells={cells} sheets={sheets.data} reqs={reqs.data} hasSetup={!!sproc.data} office={office} onOpen={(c) => set({ tab: 'sheet', cell: c })} onNew={(z, t) => nav(`/req/new?site=${siteId}&zone=${z}&trade=${t}`)} />
      ) : tab === 'sheet' ? (
        <SheetTab key={siteId} m={m} siteId={siteId} cells={cells} cell={cell} setCell={(c) => set({ cell: c })} sheets={sheets.data} reqs={reqs.data} office={office} who={who} toast={toast} onNew={(z, t) => nav(`/req/new?site=${siteId}&zone=${z}&trade=${t}`)} />
      ) : tab === 'setup' ? (
        <SetupTab key={siteId} m={m} siteId={siteId} sproc={sproc.data} sheets={sheets.data} toast={toast} />
      ) : (
        <ImportTab key={siteId} m={m} siteId={siteId} siteName={site?.name ?? ''} sproc={sproc.data} sheets={sheets.data} who={who} toast={toast} onDone={() => set({ tab: 'board' })} />
      )}
    </div>
  );
}

/* ───────── 현황판 ───────── */
function Board({ m, siteId, cells, sheets, reqs, hasSetup, office, onOpen, onNew }: { m: ProcessMaster; siteId: string; cells: string[]; sheets: BaseSheet[]; reqs: Requisition[]; hasSetup: boolean; office: boolean; onOpen: (c: string) => void; onNew: (z: string, t: string) => void }) {
  const zones = sortedZones(m);
  const trades = sortedTrades(m);
  const siteReqs = reqs.filter((r) => r.siteId === siteId);
  const noProc = siteReqs.filter((r) => !r.zoneId).length;
  const total = { contract: 0, exec: 0, done: 0 };
  const stat = (z: string, t: string) => {
    const s = cellStats(
      sheets.find((x) => x.zoneId === z && x.tradeId === t),
      processPriorMap(reqs, siteId, z, t),
    );
    total.contract += s.contract;
    total.exec += s.exec;
    total.done += s.done;
    return s;
  };
  const rows = zones.filter((z) => trades.some((t) => cells.includes(cellKey(z.id, t.id))));
  return (
    <div className="space-y-3">
      {!hasSetup && (
        <div className="rounded-lg border border-amber-200 bg-amber-soft px-3 py-2 text-[12.5px] text-amber-800">
          이 현장은 아직 공정 설정을 하지 않아 회사 기본 칸으로 보입니다. {office ? '"공정분리 툴에서 내역 가져오기"로 내역을 넣으면 쓰는 칸이 자동으로 켜집니다.' : '자재부에 내역 등록을 요청하세요.'}
        </div>
      )}
      <div className="card overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-32">구역 \ 공종</th>
              {trades.map((t) => (
                <th key={t.id} className="text-center">
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((z) => (
              <tr key={z.id}>
                <td className="font-semibold">
                  {z.name}
                  {z.subs?.length ? <div className="text-[10.5px] font-normal text-muted">{z.subs.join('·')}</div> : null}
                </td>
                {trades.map((t) => {
                  const on = cells.includes(cellKey(z.id, t.id));
                  if (!on) return <td key={t.id} className="bg-canvas/60" />;
                  const s = stat(z.id, t.id);
                  const rs = siteReqs.filter((r) => r.zoneId === z.id && r.tradeId === t.id);
                  const pend = rs.filter((r) => r.status === 'pending').length;
                  const over = s.rate > 1.0001;
                  return (
                    <td key={t.id} className="min-w-[150px] align-top">
                      <button className="block w-full rounded-md p-1 text-left hover:bg-canvas" onClick={() => onOpen(cellKey(z.id, t.id))}>
                        {s.items ? (
                          <>
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-[11.5px] text-muted">품목 {s.items}</span>
                              <span className={`font-semibold ${over ? 'text-red-600' : ''}`}>{Math.round(s.rate * 100)}%</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded bg-line">
                              <div className={`h-full ${over ? 'bg-red-500' : 'bg-amber-brand'}`} style={{ width: `${Math.min(100, s.rate * 100)}%` }} />
                            </div>
                            <div className="mt-1 text-[11px] text-muted">실행 {won(s.exec)}</div>
                          </>
                        ) : (
                          <div className="text-[11.5px] text-muted">내역 없음</div>
                        )}
                        <div className="mt-0.5 text-[11px] text-muted">
                          청구 {rs.length}건{pend ? <span className="text-amber-700"> · 결재중 {pend}</span> : ''}
                        </div>
                      </button>
                      <button className="mt-1 text-[11.5px] text-sky-700 hover:underline" onClick={() => onNew(z.id, t.id)}>
                        + 새 청구서
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-4 border-t border-line px-4 py-2 text-[12px] text-muted">
          <span>
            계약 <b className="text-ink">{won(total.contract)}</b>
          </span>
          <span>
            실행 <b className="text-ink">{won(total.exec)}</b>
          </span>
          <span>
            기반입(실행단가 기준) <b className="text-ink">{won(total.done)}</b> ({total.exec ? Math.round((total.done / total.exec) * 100) : 0}%)
          </span>
          {noProc > 0 && <span className="text-amber-700">공정이 지정되지 않은 청구서 {noProc}건 (예전 방식)</span>}
          <span className="ml-auto">기반입률 = 승인된 청구의 발주수량(+이관 기반입) ÷ 실행수량(없으면 계약수량), 금액 기준</span>
        </div>
      </div>
    </div>
  );
}

/* ───────── 기본 청구서 ───────── */
function SheetTab({ m, siteId, cells, cell, setCell, sheets, reqs, office, who, toast, onNew }: { m: ProcessMaster; siteId: string; cells: string[]; cell: string; setCell: (c: string) => void; sheets: BaseSheet[]; reqs: Requisition[]; office: boolean; who: string; toast: Toast; onNew: (z: string, t: string) => void }) {
  const zones = sortedZones(m);
  const trades = sortedTrades(m);
  const ordered = zones.flatMap((z) => trades.filter((t) => cells.includes(cellKey(z.id, t.id))).map((t) => cellKey(z.id, t.id)));
  const cur = cell && ordered.includes(cell) ? cell : ordered[0] ?? '';
  const [zoneId, tradeId] = cur.split('|');
  const sheet = sheets.find((s) => s.zoneId === zoneId && s.tradeId === tradeId);
  const siteCats = useSiteCategories().data.filter((c) => c.siteId === siteId);
  const catalog = useItemCatalog();
  const [lines, setLines] = useState<BaseLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [add, setAdd] = useState<{ itemName: string; spec: string; unit: string; siteCategoryId: string; lump: boolean; contractAmount: number } | null>(null);
  useEffect(() => {
    if (!dirty) setLines(structuredClone(sheet?.lines ?? []));
  }, [sheet, dirty, cur]);
  useEffect(() => setDirty(false), [cur]);
  const prior = useMemo(() => processPriorMap(reqs, siteId, zoneId, tradeId), [reqs, siteId, zoneId, tradeId]);
  const cellReqs = reqs.filter((r) => r.siteId === siteId && r.zoneId === zoneId && r.tradeId === tradeId);
  const catName = (id?: string) => siteCats.find((c) => c.id === id)?.name ?? '';
  const upd = (key: string, p: Partial<BaseLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
    setDirty(true);
  };
  const shown = lines.filter((l) => (showOff || !l.off) && (!q || nameKey(`${l.itemName} ${l.spec}`).includes(nameKey(q))));
  const save = async () => {
    try {
      await commitBatch([{ type: 'set', col: C.baseSheets, id: sheetId(siteId, zoneId, tradeId), data: { siteId, zoneId, tradeId, lines, updatedAt: Date.now(), updatedByName: who }, merge: true }]);
      await audit('기본 청구서 저장', `${siteId} ${processLabel(m, { zoneId, tradeId })}`, { n: lines.length });
      setDirty(false);
      toast('저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  const addLine = () => {
    if (!add || !add.itemName.trim()) return toast('품명을 입력하세요.', 'err');
    const key = baseLineKey(add.itemName, add.spec, add.unit);
    if (lines.some((l) => l.key === key)) return toast('이미 있는 품목입니다.', 'err');
    setLines([...lines, { key, itemName: add.itemName.trim(), spec: add.spec.trim(), unit: add.unit.trim(), contractQty: 0, contractPrice: 0, contractAmount: add.lump ? add.contractAmount : 0, execQty: 0, added: true, ...(add.lump ? { lump: true } : {}), ...(add.siteCategoryId ? { siteCategoryId: add.siteCategoryId } : {}) }]);
    setDirty(true);
    setAdd(null);
  };
  const exportExcel = () => {
    const aoa = [
      ['품명', '규격', '단위', '계약수량', '계약단가', '계약금액', '실행수량', '실행단가', '이관 기반입', '기반입(청구)', '잔여', '자재분류', '1식', '사용', '구분'],
      ...lines.map((l) => {
        const pq = (prior.get(itemKey(l.itemName, l.spec)) ?? 0) + (l.priorStart ?? 0);
        return [l.itemName, l.spec, l.unit, l.contractQty, l.contractPrice, l.contractAmount, l.execQty || '', l.execPrice || '', l.priorStart || '', pq || '', (l.execQty || l.contractQty) - pq, catName(l.siteCategoryId) || l.catText || '', l.lump ? '1식' : '', l.off ? '뺌' : '', l.added ? '추가' : '내역'];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [26, 18, 6, 10, 10, 12, 10, 10, 10, 10, 10, 16, 5, 5, 6].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '기본청구서');
    XLSX.writeFile(wb, `기본청구서_${processLabel(m, { zoneId, tradeId })}.xlsx`);
  };
  /** 엑셀로 실행수량·실행단가·이관 기반입 한꺼번에 (품명·규격·단위로 맞춤) */
  const importExcel = async (file?: File) => {
    if (!file) return;
    try {
      const wb = readWorkbook(await file.arrayBuffer());
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const hi = aoa.findIndex((r) => r.some((c) => /품\s*명/.test(String(c))));
      if (hi < 0) return toast('"품명" 머리글을 찾지 못했습니다.', 'err');
      const h = aoa[hi].map((c) => String(c).replace(/\s/g, ''));
      const col = (re: RegExp) => h.findIndex((c) => re.test(c));
      const [ci, cs, cu, ce, cp, cb] = [col(/^품명/), col(/^규격/), col(/^단위/), col(/^실행수량|^실행량/), col(/^실행단가/), col(/이관/)];
      if (ce < 0 && cb < 0) return toast('"실행수량" 또는 "이관 기반입" 열이 없습니다.', 'err');
      let hit = 0;
      const miss: string[] = [];
      const next = [...lines];
      for (const r of aoa.slice(hi + 1)) {
        const item = String(r[ci] ?? '').trim();
        if (!item) continue;
        const spec = cs >= 0 ? String(r[cs] ?? '').trim() : '';
        const unit = cu >= 0 ? String(r[cu] ?? '').trim() : '';
        const i = next.findIndex((l) => l.key === baseLineKey(item, spec, unit)) ?? -1;
        const j = i >= 0 ? i : next.findIndex((l) => itemKey(l.itemName, l.spec) === itemKey(item, spec));
        if (j < 0) {
          miss.push(`${item} ${spec}`);
          continue;
        }
        next[j] = { ...next[j], ...(ce >= 0 && r[ce] !== '' ? { execQty: num(r[ce]) } : {}), ...(cp >= 0 && r[cp] !== '' ? { execPrice: num(r[cp]) } : {}), ...(cb >= 0 && r[cb] !== '' ? { priorStart: num(r[cb]) } : {}) };
        hit++;
      }
      setLines(next);
      setDirty(true);
      toast(`${hit}줄 반영 (저장을 눌러야 저장됩니다).${miss.length ? ` 못 맞춘 품목 ${miss.length}건: ${miss.slice(0, 5).join(', ')}` : ''}`, miss.length ? 'err' : undefined);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  if (!ordered.length) return <div className="card"><Empty>켜진 공정이 없습니다. 공정 설정에서 칸을 켜세요.</Empty></div>;
  const tot = cellStats({ ...(sheet as BaseSheet), lines }, prior);
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select className="input h-8 w-56 font-semibold" value={cur} onChange={(e) => (dirty && !confirm('저장하지 않은 변경이 있습니다. 다른 공정으로 갈까요?') ? null : setCell(e.target.value))}>
          {zones.map((z) => (
            <optgroup key={z.id} label={z.name}>
              {trades
                .filter((t) => cells.includes(cellKey(z.id, t.id)))
                .map((t) => (
                  <option key={t.id} value={cellKey(z.id, t.id)}>
                    {z.name} {t.name}
                    {sheets.some((s) => s.zoneId === z.id && s.tradeId === t.id && s.lines.length) ? '' : ' (내역 없음)'}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <input className="input h-7 w-44" placeholder="품명·규격 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1 text-[12px] text-muted">
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> 뺀 품목도 보기
        </label>
        <span className="text-[12px] text-muted">
          품목 {tot.items} · 계약 {won(tot.contract)} · 실행 {won(tot.exec)} · 청구 {cellReqs.length}건
        </span>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost h-7 text-[12px]" onClick={exportExcel}>
            엑셀 내려받기
          </button>
          {office && (
            <>
              <label className="btn-ghost h-7 cursor-pointer text-[12px]" title="품명·규격·단위 + 실행수량·실행단가·이관 기반입 열">
                실행수량 엑셀 올리기
                <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => (importExcel(e.target.files?.[0]), (e.target.value = ''))} />
              </label>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setAdd({ itemName: '', spec: '', unit: '', siteCategoryId: '', lump: false, contractAmount: 0 })}>
                + 품목 추가
              </button>
              <button className="btn-primary h-7 text-[12px]" disabled={!dirty} onClick={save}>
                저장
              </button>
            </>
          )}
          <button className="btn-dark h-7 text-[12px]" onClick={() => onNew(zoneId, tradeId)}>
            이 공정 새 청구서
          </button>
        </div>
      </div>
      {!lines.length ? (
        <Empty>{office ? '이 공정에 내역이 없습니다. "공정분리 툴에서 내역 가져오기" 또는 "+ 품목 추가"로 기본 청구서를 만드세요.' : '이 공정에 내역이 없습니다.'}</Empty>
      ) : (
        <div className="max-h-[calc(100vh-270px)] overflow-auto">
          <table className="tbl text-[12px]">
            <thead>
              <tr>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th className="num">계약수량</th>
                <th className="num">계약단가</th>
                <th className="num">계약금액</th>
                <th className="num">실행수량</th>
                <th className="num">이관 기반입</th>
                <th className="num">기반입 계</th>
                <th className="num">잔여</th>
                <th>자재분류</th>
                {office && <th className="text-center">기본 청구서에</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const pq = (prior.get(itemKey(l.itemName, l.spec)) ?? 0) + (l.priorStart ?? 0);
                const base = l.execQty || l.contractQty;
                const remain = base - pq;
                return (
                  <tr key={l.key} className={l.off ? 'text-muted line-through' : ''}>
                    <td className="font-medium">
                      {l.itemName}
                      {l.added && <span className="chip ml-1 bg-sky-50 text-sky-700">추가</span>}
                      {l.lump && <span className="chip ml-1 bg-canvas text-muted">1식</span>}
                    </td>
                    <td>{l.spec}</td>
                    <td>{l.unit}</td>
                    <td className="num">{l.lump ? '' : l.contractQty.toLocaleString()}</td>
                    <td className="num">{l.lump ? '' : won(l.contractPrice)}</td>
                    <td className="num">{won(l.contractAmount)}</td>
                    <td className="num">
                      {office && !l.lump ? <NumInput className="input h-7 w-20 px-1 text-right" value={l.execQty} onChange={(n) => upd(l.key, { execQty: n })} /> : l.execQty ? l.execQty.toLocaleString() : ''}
                    </td>
                    <td className="num">{office && !l.lump ? <NumInput className="input h-7 w-16 px-1 text-right" value={l.priorStart ?? 0} onChange={(n) => upd(l.key, { priorStart: n })} /> : l.priorStart || ''}</td>
                    <td className="num">{l.lump ? '' : pq ? pq.toLocaleString() : ''}</td>
                    <td className={`num font-semibold ${!l.lump && remain < 0 ? 'text-red-600' : ''}`}>{l.lump ? '' : remain.toLocaleString()}</td>
                    <td>
                      {office ? (
                        <select className="input h-7 w-32 px-1 text-[12px]" value={l.siteCategoryId ?? ''} onChange={(e) => upd(l.key, { siteCategoryId: e.target.value || undefined })}>
                          <option value="">{l.catText ? `(${l.catText})` : '-'}</option>
                          {siteCats.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        catName(l.siteCategoryId) || l.catText
                      )}
                    </td>
                    {office && (
                      <td className="whitespace-nowrap text-center">
                        <input type="checkbox" checked={!l.off} title="끄면 새 청구서에 깔리지 않습니다 (내역에는 남음)" onChange={(e) => upd(l.key, { off: !e.target.checked || undefined })} />
                        {l.added && (
                          <button className="ml-2 text-[11.5px] text-muted hover:text-red-600" onClick={() => (setLines(lines.filter((x) => x.key !== l.key)), setDirty(true))}>
                            지우기
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={!!add}
        title={`품목 추가 · ${processLabel(m, { zoneId, tradeId })}`}
        onClose={() => setAdd(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setAdd(null)}>
              취소
            </button>
            <button className="btn-primary" onClick={addLine}>
              추가
            </button>
          </>
        }
      >
        {add && (
          <div className="grid grid-cols-2 gap-3">
            <datalist id="base-items">
              {[...new Set(catalog.items.map((c) => c.i))].slice(0, 3000).map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
            <div className="col-span-2">
              <Field label="품명 *" hint="내역에 없는 추가·대체 자재. 품목·단가 목록에서 고르거나 직접 입력">
                <input className="input" list="base-items" value={add.itemName} onChange={(e) => setAdd({ ...add, itemName: e.target.value })} />
              </Field>
            </div>
            <Field label="규격">
              <input className="input" value={add.spec} onChange={(e) => setAdd({ ...add, spec: e.target.value })} />
            </Field>
            <Field label="단위">
              <input className="input" value={add.unit} onChange={(e) => setAdd({ ...add, unit: e.target.value })} />
            </Field>
            <Field label="자재분류">
              <select className="input" value={add.siteCategoryId} onChange={(e) => setAdd({ ...add, siteCategoryId: e.target.value })}>
                <option value="">-</option>
                {siteCats.map((c: SiteCategory) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="1식 (수량 없이 금액)">
              <label className="flex h-8 items-center gap-2">
                <input type="checkbox" checked={add.lump} onChange={(e) => setAdd({ ...add, lump: e.target.checked })} /> 1식 품목
              </label>
            </Field>
            {add.lump && (
              <div className="col-span-2">
                <Field label="1식 계약금액">
                  <NumInput className="input" value={add.contractAmount} onChange={(n) => setAdd({ ...add, contractAmount: n })} />
                </Field>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ───────── 공정 설정 ───────── */
function SetupTab({ m, siteId, sproc, sheets, toast }: { m: ProcessMaster; siteId: string; sproc?: SiteProcess; sheets: BaseSheet[]; toast: Toast }) {
  const [cells, setCells] = useState<string[]>(sproc?.cells ?? defaultCells(m));
  const zones = sortedZones(m);
  const trades = sortedTrades(m);
  const toggle = (k: string) => setCells((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  const save = async () => {
    try {
      await commitBatch([{ type: 'set', col: C.siteProcess, id: siteId, data: { cells, map: sproc?.map ?? {}, updatedAt: Date.now() }, merge: true }]);
      toast('저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  return (
    <div className="card max-w-3xl overflow-hidden">
      <div className="flex items-center border-b border-line px-4 py-2.5">
        <span className="font-semibold">이 현장에서 쓰는 공정</span>
        <button className="btn-primary ml-auto h-7 text-[12px]" onClick={save}>
          저장
        </button>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>구역</th>
            {trades.map((t) => (
              <th key={t.id} className="text-center">
                {t.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => (
            <tr key={z.id}>
              <td className="font-medium">{z.name}</td>
              {trades.map((t) => {
                const k = cellKey(z.id, t.id);
                const n = sheets.find((s) => s.zoneId === z.id && s.tradeId === t.id)?.lines.length ?? 0;
                return (
                  <td key={t.id} className="text-center">
                    <input type="checkbox" checked={cells.includes(k)} onChange={() => toggle(k)} />
                    {n > 0 && <div className="text-[10.5px] text-muted">내역 {n}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-line px-4 py-2 text-[12px] text-muted">끈 칸은 현황판·청구서 공정 목록에서 빠집니다. 내역과 지난 청구서는 지워지지 않습니다.</div>
    </div>
  );
}

/* ───────── 공정분리 툴에서 내역 가져오기 ───────── */
interface Pair {
  key: string;
  l6: string;
  l8: string;
  l10: string; // 6자리 이름으로 구역을 알 수 없을 때만 (예: 소방배관공사 → 세부 위치)
  n: number;
  amount: number;
}
function ImportTab({ m, siteId, siteName, sproc, sheets, who, toast, onDone }: { m: ProcessMaster; siteId: string; siteName: string; sproc?: SiteProcess; sheets: BaseSheet[]; who: string; toast: Toast; onDone: () => void }) {
  const [projects, setProjects] = useState<SepProject[] | null>(null);
  const [pid, setPid] = useState(sproc?.source?.projectId ?? '');
  const [loaded, setLoaded] = useState<{ project: SepProject; items: SepItem[] } | null>(null);
  const [map, setMap] = useState<Record<string, MapTarget | null>>({});
  const [busy, setBusy] = useState(false);
  const siteCats = useSiteCategories().data.filter((c) => c.siteId === siteId);
  const std = useStandardCategories().data;
  const zones = sortedZones(m);
  const trades = sortedTrades(m);

  const loadList = async () => {
    setBusy(true);
    try {
      const ps = await listSepProjects();
      setProjects(ps);
      if (!pid) {
        const k = nameKey(siteName);
        const guess = ps.find((p) => nameKey(p.name).includes(k) || k.includes(nameKey(p.name)));
        if (guess) setPid(guess.id);
      }
    } catch (e) {
      toast(`공정분리 툴을 읽지 못했습니다: ${errMsg(e)}`, 'err');
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    if (!pid) return;
    setBusy(true);
    try {
      const r = await loadSepProject(pid);
      setLoaded(r);
      const codes = new Map((r.project.processCodes ?? []).map((c) => [c.code, c.name]));
      const next: Record<string, MapTarget | null> = {};
      for (const it of r.items) {
        const n = sectionNames(it, codes);
        const k = mapKeyOf(m, n);
        if (k in next) continue;
        next[k] = sproc?.map?.[k] ?? suggestTarget(m, n.l6, n.l8, n.l10);
      }
      setMap(next);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const codes = useMemo(() => new Map((loaded?.project.processCodes ?? []).map((c) => [c.code, c.name])), [loaded]);
  const pairs = useMemo(() => {
    const p = new Map<string, Pair>();
    for (const it of loaded?.items ?? []) {
      const nm = sectionNames(it, codes);
      const k = mapKeyOf(m, nm);
      const x = p.get(k) ?? { key: k, l6: nm.l6, l8: nm.l8, l10: k.split('|')[2] ?? '', n: 0, amount: 0 };
      x.n++;
      x.amount += it.materialAmount || 0;
      p.set(k, x);
    }
    return [...p.values()];
  }, [loaded, codes, m]);

  /** 맞춤표대로 공정별 품목 만들기 (평형별 같은 품목은 합산, 노무비만 있는 줄은 뺌) */
  const built = useMemo(() => {
    const out = new Map<string, Map<string, BaseLine>>();
    if (!loaded) return out;
    for (const it of loaded.items) {
      const t = map[mapKeyOf(m, sectionNames(it, codes))];
      if (!t || t === 'skip' || !t.zoneId || !t.tradeId) continue;
      if (!it.name || (!it.materialAmount && !it.materialUnitPrice)) continue;
      const ck = cellKey(t.zoneId, t.tradeId);
      const lines = out.get(ck) ?? new Map<string, BaseLine>();
      const lump = it.unit === '식' || isLumpText(it.category) || isLumpText(it.name);
      const key = baseLineKey(it.name, it.specification, it.unit);
      const x = lines.get(key) ?? { key, itemName: it.name, spec: it.specification, unit: it.unit, contractQty: 0, contractPrice: 0, contractAmount: 0, execQty: 0, catText: it.category, ...(lump ? { lump: true } : {}), srcSections: [] };
      x.contractQty += it.quantity || 0;
      x.contractAmount += it.materialAmount || Math.round((it.quantity || 0) * (it.materialUnitPrice || 0));
      x.contractPrice = x.contractQty ? Math.round(x.contractAmount / x.contractQty) : it.materialUnitPrice;
      const sec = it.section.replace(/^\d+\s*/, '');
      if (sec && !x.srcSections!.includes(sec) && x.srcSections!.length < 6) x.srcSections!.push(sec);
      lines.set(key, x);
      out.set(ck, lines);
    }
    return out;
  }, [loaded, map, codes, m]);

  const unset = pairs.filter((p) => {
    const t = map[p.key];
    return !t || (t !== 'skip' && (!t.zoneId || !t.tradeId));
  });

  const apply = async () => {
    if (unset.length && !confirm(`구역·공종을 정하지 않은 공종 ${unset.length}개는 빼고 가져옵니다. 계속할까요?`)) return;
    const now = Date.now();
    const ops: Parameters<typeof commitBatch>[0] = [];
    let changed = 0;
    for (const [ck, lineMap] of built) {
      const [z, t] = ck.split('|');
      const old = sheets.find((s) => s.zoneId === z && s.tradeId === t);
      const oldMap = new Map((old?.lines ?? []).map((l) => [l.key, l]));
      const lines: BaseLine[] = [...lineMap.values()].map((l) => {
        const o = oldMap.get(l.key);
        const cat = o?.siteCategoryId || resolveCat(l.catText ?? '', siteCats, std) || undefined;
        return { ...l, contractQty: Math.round(l.contractQty * 1000) / 1000, execQty: o?.execQty ?? 0, ...(o?.execPrice ? { execPrice: o.execPrice } : {}), ...(o?.priorStart ? { priorStart: o.priorStart } : {}), ...(o?.off ? { off: true } : {}), ...(cat ? { siteCategoryId: cat } : {}) };
      });
      // 자재부가 추가한 품목은 그대로 남긴다
      for (const o of old?.lines ?? []) if (o.added && !lineMap.has(o.key)) lines.push(o);
      ops.push({ type: 'set', col: C.baseSheets, id: sheetId(siteId, z, t), data: { siteId, zoneId: z, tradeId: t, lines, updatedAt: now, updatedByName: who, importedAt: now }, merge: false });
      changed++;
    }
    const usedCells = [...built.keys()];
    const cells = [...new Set([...(sproc?.cells ?? []), ...usedCells])];
    const cleanMap = Object.fromEntries(Object.entries(map).filter(([, v]) => v)) as Record<string, MapTarget>;
    ops.push({ type: 'set', col: C.siteProcess, id: siteId, data: { cells, map: { ...(sproc?.map ?? {}), ...cleanMap }, source: { projectId: loaded!.project.id, projectName: loaded!.project.name, importedAt: now, byName: who }, updatedAt: now }, merge: true });
    setBusy(true);
    try {
      await commitBatch(ops);
      await audit('공정 내역 가져오기', `${siteName} ← ${loaded!.project.name}`, { cells: changed });
      toast(`${changed}개 공정의 기본 청구서를 만들었습니다. 실행수량·자재분류를 확인하세요.`);
      onDone();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const setTarget = (k: string, v: MapTarget | null) => setMap((x) => ({ ...x, [k]: v }));
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="공정분리 툴 현장">
          <div className="flex gap-2">
            <select className="input w-72" value={pid} onChange={(e) => setPid(e.target.value)} onFocus={() => !projects && !busy && loadList()}>
              <option value="">{projects ? '현장 선택' : '눌러서 목록 불러오기'}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.status === 'completed' ? '· 내역분리 완료' : '· 작업 중'} {p.itemCount ? `(${p.itemCount}줄)` : ''}
                </option>
              ))}
              {!projects && pid && <option value={pid}>{sproc?.source?.projectName ?? pid}</option>}
            </select>
            {!projects && (
              <button className="btn-ghost" disabled={busy} onClick={loadList}>
                목록
              </button>
            )}
          </div>
        </Field>
        <button className="btn-dark" disabled={!pid || busy} onClick={load}>
          {busy ? '읽는 중…' : '내역 읽기'}
        </button>
        {projects?.find((p) => p.id === pid)?.status === 'working' && <span className="text-[12px] text-amber-700">⚠ 공정분리 툴에서 아직 작업 중인 현장입니다. 분리가 끝난 뒤 가져오는 것을 권합니다.</span>}
        <div className="ml-auto text-[12px] text-muted">
          노무비만 있는 줄은 빼고, 평형별로 나뉜 같은 품목은 합산합니다.
          <br />
          다시 가져와도 ERP에서 넣은 실행수량·이관 기반입·뺀 품목·추가 품목은 유지됩니다.
        </div>
      </div>

      {loaded && (
        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <div className="card overflow-hidden">
            <div className="flex items-center border-b border-line px-4 py-2.5">
              <span className="font-semibold">공정 맞춤표</span>
              <span className="ml-2 text-[12px] text-muted">
                공정분리 툴 공종 {pairs.length}개 · 품목 {loaded.items.length}줄{unset.length ? <span className="text-amber-700"> · 미지정 {unset.length}</span> : ''}
              </span>
            </div>
            <div className="max-h-[calc(100vh-330px)] overflow-auto">
              <table className="tbl text-[12.5px]">
                <thead>
                  <tr>
                    <th>6자리 (중공종)</th>
                    <th>8자리 (소공종)</th>
                    <th className="num">줄</th>
                    <th className="num">재료비</th>
                    <th>구역</th>
                    <th>공종</th>
                    <th>제외</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p) => {
                    const t = map[p.key];
                    const skip = t === 'skip';
                    const tg = t && t !== 'skip' ? t : { zoneId: '', tradeId: '' };
                    const bad = !skip && (!tg.zoneId || !tg.tradeId);
                    return (
                      <tr key={p.key} className={skip ? 'text-muted' : ''}>
                        <td>{p.l6}</td>
                        <td>
                          {p.l8}
                          {p.l10 && <div className="text-[11px] text-muted">{p.l10}</div>}
                        </td>
                        <td className="num">{p.n}</td>
                        <td className="num">{won(p.amount)}</td>
                        <td>
                          <select className={`input h-7 w-28 px-1 ${bad && !tg.zoneId ? 'border-amber-400' : ''}`} disabled={skip} value={tg.zoneId} onChange={(e) => setTarget(p.key, { ...tg, zoneId: e.target.value })}>
                            <option value="">-</option>
                            {zones.map((z) => (
                              <option key={z.id} value={z.id}>
                                {z.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select className={`input h-7 w-20 px-1 ${bad && !tg.tradeId ? 'border-amber-400' : ''}`} disabled={skip} value={tg.tradeId} onChange={(e) => setTarget(p.key, { ...tg, tradeId: e.target.value })}>
                            <option value="">-</option>
                            {trades.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="text-center">
                          <input type="checkbox" checked={skip} title="외주 등 공정 관리에서 뺌" onChange={(e) => setTarget(p.key, e.target.checked ? 'skip' : suggestTarget(m, p.l6, p.l8, p.l10) === 'skip' ? null : suggestTarget(m, p.l6, p.l8, p.l10))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card self-start overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 font-semibold">미리보기 · 공정별 기본 청구서</div>
            <table className="tbl text-[12.5px]">
              <thead>
                <tr>
                  <th>공정</th>
                  <th className="num">품목</th>
                  <th className="num">재료비</th>
                </tr>
              </thead>
              <tbody>
                {zones.flatMap((z) =>
                  trades
                    .filter((t) => built.has(cellKey(z.id, t.id)))
                    .map((t) => {
                      const ls = [...built.get(cellKey(z.id, t.id))!.values()];
                      return (
                        <tr key={cellKey(z.id, t.id)}>
                          <td>
                            {zoneName(m, z.id)} {tradeName(m, t.id)}
                          </td>
                          <td className="num">{ls.length}</td>
                          <td className="num">{won(ls.reduce((a, l) => a + l.contractAmount, 0))}</td>
                        </tr>
                      );
                    }),
                )}
              </tbody>
            </table>
            <div className="border-t border-line p-3">
              <button className="btn-primary w-full" disabled={busy || !built.size} onClick={apply}>
                기본 청구서로 저장
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
