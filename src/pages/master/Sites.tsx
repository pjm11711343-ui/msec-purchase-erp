import { audit, commitBatch, fetchWhere, newId, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useState } from 'react';
import { useSiteCategories, useSites, useVendors } from '../../lib/hooks';
import { nameKey } from '../../lib/normalize';
import CrudTable, { toList } from '../../components/CrudTable';
import { errMsg, Modal, PageHeader, useToast } from '../../components/ui';
import type { DealerRule, Site, SiteCategory, Vendor } from '../../types';
import TelegramChatFinder from '../../components/TelegramChatFinder';

const FIELDS = [
  { key: 'code', label: '현장코드', required: true, hint: '예: MS-01' },
  { key: 'name', label: '현장 이름', required: true, hint: '목록에 보이는 짧은 이름' },
  { key: 'trade', label: '공종', type: 'select' as const, options: ['기계', '소방', '공통'].map((v) => ({ value: v, label: v })) },
  { key: 'groupName', label: '묶음명', hint: '기계/소방이 나뉜 현장의 공통 이름' },
  { key: 'fullName', label: '정식명' },
  { key: 'contractor', label: '원청사' },
  { key: 'managerContact', label: '소장 연락처' },
  { key: 'officeContact', label: '공무 연락처' },
  { key: 'address', label: '현장 주소' },
  { key: 'households', label: '규모·세대수' },
  { key: 'orderDisplayName', label: '발주서 현장 표기', hint: '발주서 "현장" 칸에 찍히는 이름' },
  {
    key: 'allowReqExcel',
    label: '청구서 엑셀 (불러오기·붙여넣기)',
    type: 'select' as const,
    options: [
      { value: 'false', label: '사용 안 함' },
      { value: 'true', label: '사용' },
    ],
    hint: '현장소장·현장담당이 청구서 작성 때 엑셀 불러오기·붙여넣기를 쓸 수 있는지. 자재부·관리자는 항상 사용',
  },
  { key: 'telegramChatId', label: '텔레그램 단톡방 Chat ID', hint: '발주 발송·입고 등록 알림을 받을 현장 단톡방. 위 "텔레그램 대화방 찾기"에서 복사해 붙여 넣으세요 (예: -1001234567890)' },
  { key: 'aliases', label: '다른 표기 (쉼표로 구분)', type: 'list' as const, hint: '계산서 시트 이름 등. 계산서를 올리면 자동으로 늘어납니다.' },
];

export default function Sites() {
  const sites = useSites();
  const cats = useSiteCategories();
  const settings = useSettings();
  const vendors = useVendors();
  const [dealerSite, setDealerSite] = useState<Site | null>(null);
  const vName = (id: string) => vendors.data.find((v) => v.id === id)?.name ?? '(삭제된 업체)';

  const nextCode = () => {
    const used = new Set(sites.data.map((s) => s.code));
    for (let n = 1; ; n++) {
      const c = `${settings.siteCodePrefix}-${String(n).padStart(2, '0')}`;
      if (!used.has(c)) return c;
    }
  };

  const toSite = (d: Record<string, unknown>, prev?: Site): Partial<Site> => ({
    code: String(d.code ?? '').trim(),
    name: String(d.name ?? '').trim(),
    trade: (d.trade as Site['trade']) || prev?.trade || '기계',
    groupName: String(d.groupName ?? '').trim() || undefined,
    fullName: String(d.fullName ?? '').trim(),
    contractor: String(d.contractor ?? '').trim() || undefined,
    managerContact: String(d.managerContact ?? '').trim() || undefined,
    officeContact: String(d.officeContact ?? '').trim() || undefined,
    address: String(d.address ?? '').trim() || undefined,
    households: String(d.households ?? '').trim() || undefined,
    orderDisplayName: String(d.orderDisplayName ?? '').trim() || undefined,
    aliases: toList(d.aliases),
    allowReqExcel: d.allowReqExcel === true || d.allowReqExcel === 'true',
    telegramChatId: String(d.telegramChatId ?? '').trim() || undefined,
    active: prev?.active ?? true,
  });

  return (
    <div>
      <PageHeader title="현장" desc="기계/소방이 나뉜 현장은 서로 다른 현장으로 등록하고 묶음명으로 이어 둡니다." actions={<TelegramChatFinder />} />
      <CrudTable<Site>
        rows={sites.data}
        loading={sites.loading}
        emptyText="현장이 없습니다. 청구서 파일 이관으로 가져오거나 + 추가로 만드세요."
        search={(s) => [s.code, s.name, s.fullName, s.groupName, ...(s.aliases ?? [])].join(' ')}
        columns={[
          { key: 'code', label: '코드' },
          { key: 'name', label: '이름', render: (s) => <span className="font-medium">{s.name}</span> },
          { key: 'trade', label: '공종' },
          { key: 'groupName', label: '묶음' },
          { key: 'managerContact', label: '소장' },
          {
            key: 'dealerIds',
            label: '대리점',
            render: (s) => (
              <button className="text-left text-[12px] hover:underline" onClick={(e) => (e.stopPropagation(), setDealerSite(s))} title="구매청구 단가 불러올 때 먼저 쓰는 업체 (우선순위)">
                {s.dealerRules?.length || s.dealerIds?.length ? (
                  <span>
                    {s.dealerRules?.length ? <span className="chip mr-1 bg-teal-50 text-teal-700">분류별 {s.dealerRules.length}묶음</span> : null}
                    {s.dealerIds?.length ? `기본: ${s.dealerIds.map((id, i) => `${i + 1}.${vName(id)}`).join(' ')}` : ''}
                  </span>
                ) : (
                  <span className="text-muted">+ 지정</span>
                )}
              </button>
            ),
          },
          { key: 'address', label: '주소' },
          { key: 'cats', label: '분류', className: 'num', render: (s) => cats.data.filter((c) => c.siteId === s.id).length },
          { key: 'aliases', label: '다른 표기', render: (s) => <span className="text-[11.5px] text-muted">{(s.aliases ?? []).join(', ')}</span> },
          { key: 'allowReqExcel', label: '청구 엑셀', render: (s) => (s.allowReqExcel ? <span className="chip bg-emerald-50 text-emerald-700">사용</span> : <span className="text-[11.5px] text-muted">안 함</span>) },
          { key: 'active', label: '상태', render: (s) => (s.active ? '사용' : '중지') },
        ]}
        fields={FIELDS}
        onSave={async (id, d) => {
          const prev = sites.data.find((s) => s.id === id);
          const data = toSite(id ? d : { code: d.code || nextCode(), ...d }, prev);
          const dup = sites.data.find((s) => s.code === data.code && s.id !== id);
          if (dup) throw new Error(`현장코드 ${data.code}는 ${dup.name}에서 쓰고 있습니다.`);
          const sid = id ?? newId(C.sites);
          await commitBatch([{ type: 'set', col: C.sites, id: sid, data: { ...data, ...(id ? {} : { createdAt: Date.now() }) } }]);
          await audit(id ? '현장 수정' : '현장 추가', sid, { name: data.name });
        }}
        onActive={async (ids, active) => commitBatch(ids.map((id) => ({ type: 'set' as const, col: C.sites, id, data: { active } })))}
        extraActions={(sel, clear) =>
          sel.length > 0 && (
            <>
              <button
                className="btn-ghost h-7 text-[12px]"
                onClick={() => commitBatch(sel.map((id) => ({ type: 'set' as const, col: C.sites, id, data: { allowReqExcel: true } }))).then(clear)}
              >
                청구 엑셀 사용
              </button>
              <button
                className="btn-ghost h-7 text-[12px]"
                onClick={() => commitBatch(sel.map((id) => ({ type: 'set' as const, col: C.sites, id, data: { allowReqExcel: false } }))).then(clear)}
              >
                청구 엑셀 안 함
              </button>
            </>
          )
        }
        onDelete={async (ids) => {
          const ops: Parameters<typeof commitBatch>[0] = [];
          for (const id of ids) {
            ops.push({ type: 'delete', col: C.sites, id });
            for (const col of [C.siteCategories, C.ledger, C.invoices]) {
              const rows = await fetchWhere<{ id: string }>(col, 'siteId', id);
              rows.forEach((r) => ops.push({ type: 'delete', col, id: r.id }));
            }
            ops.push({ type: 'delete', col: C.approvalLines, id });
          }
          await commitBatch(ops);
          await audit('현장 삭제', ids.join(','));
        }}
        paste={{
          keys: ['code', 'name', 'trade', 'fullName', 'managerContact', 'officeContact', 'address'],
          example: '현장코드 ⇥ 이름 ⇥ 공종(기계/소방) ⇥ 정식명 ⇥ 소장 연락처 ⇥ 공무 연락처 ⇥ 주소   (코드가 비면 자동 부여)',
          onAdd: async (rows) => {
            const used = new Set(sites.data.map((s) => s.code));
            let n = 1;
            const gen = () => {
              for (; ; n++) {
                const c = `${settings.siteCodePrefix}-${String(n).padStart(2, '0')}`;
                if (!used.has(c)) return (used.add(c), c);
              }
            };
            const ops = rows
              .filter((r) => r.name)
              .map((r) => {
                const ex = sites.data.find((s) => nameKey(s.name) === nameKey(r.name));
                const data = ex
                  ? Object.fromEntries(Object.entries(r).filter(([k, v]) => v && !(ex as unknown as Record<string, unknown>)[k]))
                  : { ...toSite(r), code: r.code || gen(), createdAt: Date.now() };
                if (!ex && r.code) used.add(r.code);
                return { type: 'set' as const, col: C.sites, id: ex?.id ?? newId(C.sites), data };
              });
            await commitBatch(ops);
            await audit('현장 일괄 등록', `${ops.length}건`);
          },
        }}
      />
      {dealerSite && <DealerModal site={dealerSite} vendors={vendors.data} cats={cats.data} onClose={() => setDealerSite(null)} />}
    </div>
  );
}

/** 순위 목록 편집 (업체 추가·↑↓·빼기) */
function RankList({ ids, setIds, vendors }: { ids: string[]; setIds: (v: string[]) => void; vendors: Vendor[] }) {
  const opts = vendors.filter((v) => v.active !== false && !ids.includes(v.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const n = [...ids];
    [n[i], n[j]] = [n[j], n[i]];
    setIds(n);
  };
  return (
    <div>
      {ids.length > 0 && (
        <ol className="mb-1.5 divide-y divide-line rounded-lg border border-line bg-white">
          {ids.map((id, i) => (
            <li key={id} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
              <span className="w-11 text-[12px] font-bold text-amber-700">{i + 1}순위</span>
              <span className="flex-1 font-medium">{vendors.find((v) => v.id === id)?.name ?? '(삭제된 업체)'}</span>
              <button className="btn-ghost h-6 px-1.5" disabled={!i} onClick={() => move(i, -1)} title="위로">↑</button>
              <button className="btn-ghost h-6 px-1.5" disabled={i === ids.length - 1} onClick={() => move(i, 1)} title="아래로">↓</button>
              <button className="btn-ghost h-6 px-1.5 text-red-600" onClick={() => setIds(ids.filter((y) => y !== id))} title="빼기">✕</button>
            </li>
          ))}
        </ol>
      )}
      <select className="input h-8 text-[12.5px]" value="" onChange={(e) => e.target.value && setIds([...ids, e.target.value])}>
        <option value="">+ 업체 추가{ids.length ? ` (${ids.length + 1}순위)` : ' (1순위)'}</option>
        {opts.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 현장 대리점 지정: 자재분류별 (우선순위) + 기본 */
function DealerModal({ site, vendors, cats, onClose }: { site: Site; vendors: Vendor[]; cats: SiteCategory[]; onClose: () => void }) {
  const toast = useToast();
  const [rules, setRules] = useState<DealerRule[]>(site.dealerRules?.length ? site.dealerRules.map((r) => ({ catIds: [...r.catIds], dealerIds: [...r.dealerIds] })) : []);
  const [base, setBase] = useState<string[]>(site.dealerIds ?? []);
  const [busy, setBusy] = useState(false);
  const [openCat, setOpenCat] = useState<number | null>(rules.length ? null : null);
  const siteCats = cats.filter((c) => c.siteId === site.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ko'));
  const catName = (id: string) => siteCats.find((c) => c.id === id)?.name ?? '(삭제된 분류)';
  const usedBy = (cid: string) => rules.findIndex((r) => r.catIds.includes(cid));
  const setRule = (i: number, r: DealerRule) => setRules((x) => x.map((y, j) => (j === i ? r : y)));

  const save = async () => {
    const clean = rules.filter((r) => r.catIds.length && r.dealerIds.length);
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.sites, id: site.id, data: { dealerRules: clean, dealerIds: base } }]);
      await audit('현장 대리점 지정', site.id, { rules: clean.length, base: base.length });
      toast(`${site.name} 대리점을 저장했습니다.`);
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={`대리점 지정 · ${site.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>취소</button>
          <button className="btn-primary" disabled={busy} onClick={save}>저장</button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-5 text-muted">
        구매청구서에서 단가를 불러올 때 <b>현장 지정단가 다음</b>으로 이 업체들 단가를 먼저 찾습니다. 줄의 <b>자재분류</b>에 맞는 대리점을 1순위부터 찾고(단가관리시스템 → ERP 품목·단가), 없으면 지금처럼 계산서 → 단가표 → 직전 발주 순서입니다.
      </p>

      <div className="space-y-3">
        {rules.map((r, i) => (
          <div key={i} className="rounded-xl border border-line bg-canvas/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <b className="text-[13px]">자재분류</b>
              <div className="flex flex-1 flex-wrap gap-1">
                {r.catIds.map((cid) => (
                  <span key={cid} className="chip bg-navy-950 text-white">
                    {catName(cid)}
                    <button className="ml-1 text-white/60 hover:text-white" onClick={() => setRule(i, { ...r, catIds: r.catIds.filter((x) => x !== cid) })}>✕</button>
                  </span>
                ))}
                <button className="chip border border-dashed border-line bg-white text-muted hover:text-ink" onClick={() => setOpenCat(openCat === i ? null : i)}>
                  {openCat === i ? '분류 고르기 닫기' : '+ 분류 고르기'}
                </button>
              </div>
              <button className="btn-ghost h-7 px-2 text-[12px] text-red-600" onClick={() => setRules((x) => x.filter((_, j) => j !== i))}>묶음 삭제</button>
            </div>
            {openCat === i && (
              <div className="mb-2 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-line bg-white p-2 sm:grid-cols-3">
                {siteCats.map((c) => {
                  const u = usedBy(c.id);
                  const on = r.catIds.includes(c.id);
                  return (
                    <label key={c.id} className={`flex items-center gap-1.5 text-[12.5px] ${u >= 0 && u !== i ? 'text-muted' : ''}`} title={u >= 0 && u !== i ? '다른 묶음에 들어 있습니다 (고르면 이 묶음으로 옮깁니다)' : ''}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setRules((x) =>
                            x.map((y, j) =>
                              j === i ? { ...y, catIds: on ? y.catIds.filter((z) => z !== c.id) : [...y.catIds, c.id] } : { ...y, catIds: y.catIds.filter((z) => z !== c.id) },
                            ),
                          )
                        }
                      />
                      {c.name}
                      {u >= 0 && u !== i && <span className="text-[10.5px]">(묶음 {u + 1})</span>}
                    </label>
                  );
                })}
                {!siteCats.length && <div className="col-span-full text-[12px] text-muted">이 현장에 투입집계 분류가 없습니다.</div>}
              </div>
            )}
            <RankList ids={r.dealerIds} setIds={(v) => setRule(i, { ...r, dealerIds: v })} vendors={vendors} />
          </div>
        ))}
        <button className="btn-ghost h-9 w-full border-dashed" onClick={() => (setRules((x) => [...x, { catIds: [], dealerIds: [] }]), setOpenCat(rules.length))}>
          + 자재분류별 대리점 추가
        </button>

        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="mb-2 text-[13px]">
            <b>기본 대리점</b> <span className="text-[12px] text-muted">— 자재분류를 아직 안 골랐거나, 위에서 따로 정하지 않은 분류</span>
          </div>
          <RankList ids={base} setIds={setBase} vendors={vendors} />
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-muted">분류도 업체도 비어 있는 묶음은 저장할 때 빠집니다.</p>
    </Modal>
  );
}
