import { audit, commitBatch, fetchWhere, newId, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useState } from 'react';
import { useSiteCategories, useSites, useVendors } from '../../lib/hooks';
import { nameKey } from '../../lib/normalize';
import CrudTable, { toList } from '../../components/CrudTable';
import { errMsg, Modal, PageHeader, useToast } from '../../components/ui';
import type { Site, Vendor } from '../../types';
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
                {s.dealerIds?.length ? s.dealerIds.map((id, i) => `${i + 1}.${vName(id)}`).join(' ') : <span className="text-muted">+ 지정</span>}
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
      {dealerSite && <DealerModal site={dealerSite} vendors={vendors.data} onClose={() => setDealerSite(null)} />}
    </div>
  );
}

/** 현장 대리점 지정 (우선순위) */
function DealerModal({ site, vendors, onClose }: { site: Site; vendors: Vendor[]; onClose: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState<string[]>(site.dealerIds ?? []);
  const [busy, setBusy] = useState(false);
  const opts = vendors.filter((v) => v.active !== false && !ids.includes(v.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const move = (i: number, d: number) => setIds((x) => {
    const n = [...x];
    const j = i + d;
    if (j < 0 || j >= n.length) return x;
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });
  const save = async () => {
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.sites, id: site.id, data: { dealerIds: ids } }]);
      await audit('현장 대리점 지정', site.id, { dealerIds: ids });
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
      title={`대리점 지정 · ${site.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" disabled={busy} onClick={save}>
            저장
          </button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-5 text-muted">
        구매청구서에서 품명으로 단가를 불러올 때 <b>현장 지정단가 다음</b>으로 이 업체들 단가를 먼저 찾습니다. 1순위 업체에 단가가 없으면 2순위 … 순서로 찾고, 어디에도 없으면 지금처럼 계산서 → 단가표 → 직전 발주 순서입니다. (단가관리시스템 단가 → ERP 품목·단가 순)
      </p>
      {ids.length ? (
        <ol className="mb-3 divide-y divide-line rounded-lg border border-line">
          {ids.map((id, i) => (
            <li key={id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <span className="w-12 font-bold text-amber-700">{i + 1}순위</span>
              <span className="flex-1 font-medium">{vendors.find((v) => v.id === id)?.name ?? '(삭제된 업체)'}</span>
              <button className="btn-ghost h-7 px-2" disabled={!i} onClick={() => move(i, -1)} title="위로">
                ↑
              </button>
              <button className="btn-ghost h-7 px-2" disabled={i === ids.length - 1} onClick={() => move(i, 1)} title="아래로">
                ↓
              </button>
              <button className="btn-ghost h-7 px-2 text-red-600" onClick={() => setIds((x) => x.filter((y) => y !== id))} title="빼기">
                ✕
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-muted">지정한 대리점이 없습니다.</div>
      )}
      <select className="input" value="" onChange={(e) => e.target.value && setIds((x) => [...x, e.target.value])}>
        <option value="">+ 대리점 추가 (업체 고르기)</option>
        {opts.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </Modal>
  );
}
