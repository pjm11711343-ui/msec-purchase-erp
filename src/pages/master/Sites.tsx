import { audit, commitBatch, fetchWhere, newId, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites } from '../../lib/hooks';
import { nameKey } from '../../lib/normalize';
import CrudTable, { toList } from '../../components/CrudTable';
import { PageHeader } from '../../components/ui';
import type { Site } from '../../types';

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
  { key: 'aliases', label: '다른 표기 (쉼표로 구분)', type: 'list' as const, hint: '계산서 시트 이름 등. 계산서를 올리면 자동으로 늘어납니다.' },
];

export default function Sites() {
  const sites = useSites();
  const cats = useSiteCategories();
  const settings = useSettings();

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
    active: prev?.active ?? true,
  });

  return (
    <div>
      <PageHeader title="현장" desc="기계/소방이 나뉜 현장은 서로 다른 현장으로 등록하고 묶음명으로 이어 둡니다." />
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
          { key: 'address', label: '주소' },
          { key: 'cats', label: '분류', className: 'num', render: (s) => cats.data.filter((c) => c.siteId === s.id).length },
          { key: 'aliases', label: '다른 표기', render: (s) => <span className="text-[11.5px] text-muted">{(s.aliases ?? []).join(', ')}</span> },
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
    </div>
  );
}
