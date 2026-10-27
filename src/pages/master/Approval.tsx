import { useEffect, useState } from 'react';
import { orderBy } from 'firebase/firestore';
import { audit, commitBatch, useCollection } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites } from '../../lib/hooks';
import { Empty, errMsg, PageHeader, useToast } from '../../components/ui';
import { ROLE_LABEL, type ApprovalLine, type ErpUser } from '../../types';

const TEMPLATES: Record<ApprovalLine['type'], string[]> = {
  '2단계': ['현장소장', '자재부'],
  '6칸': ['현장 담당', '현장 소장', '본사 담당', '본사 팀장', '본사 임원', '본사 대표'],
};
const DEFAULT_ID = '_default';

type Draft = Record<string, ApprovalLine>;

export default function Approval() {
  const sites = useSites();
  const lines = useCollection<ApprovalLine>(C.approvalLines);
  const users = useCollection<ErpUser>(C.users, [orderBy('name')]);
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  useEffect(() => {
    const d: Draft = {};
    lines.data.forEach((l) => (d[l.id] = l));
    setDraft(d);
    setDirty(new Set());
  }, [lines.data]);

  const get = (id: string): ApprovalLine =>
    draft[id] ??
    (id === DEFAULT_ID
      ? { id, siteId: DEFAULT_ID, type: '2단계', steps: TEMPLATES['2단계'].map((label) => ({ label })) }
      : { ...(draft[DEFAULT_ID] ?? { type: '2단계', steps: TEMPLATES['2단계'].map((label) => ({ label })) }), id, siteId: id });

  const set = (id: string, l: ApprovalLine) => {
    setDraft((d) => ({ ...d, [id]: l }));
    setDirty((s) => new Set(s).add(id));
  };

  const save = async () => {
    try {
      await commitBatch(
        [...dirty].map((id) => {
          const { id: _id, ...data } = get(id);
          void _id;
          return { type: 'set' as const, col: C.approvalLines, id, data, merge: false };
        }),
      );
      await audit('결재선 저장', [...dirty].join(','));
      toast(`${dirty.size}개 결재선을 저장했습니다.`);
      setDirty(new Set());
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const row = (id: string, title: string, sub?: string) => {
    const l = get(id);
    return (
      <tr key={id} className={dirty.has(id) ? 'bg-amber-soft/60' : ''}>
        <td className="whitespace-nowrap">
          <div className="font-medium">{title}</div>
          {sub && <div className="text-[11.5px] text-muted">{sub}</div>}
        </td>
        <td>
          <select
            className="input h-7"
            value={l.type}
            onChange={(e) => {
              const type = e.target.value as ApprovalLine['type'];
              set(id, { ...l, type, steps: TEMPLATES[type].map((label) => ({ label })) });
            }}
          >
            <option>2단계</option>
            <option>6칸</option>
          </select>
        </td>
        <td>
          <div className="flex flex-wrap gap-2">
            {l.steps.map((s, i) => (
              <label key={i} className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted">
                  {i + 1}. {s.label}
                </span>
                <select
                  className="input h-7 w-32"
                  value={s.userId ?? ''}
                  onChange={(e) =>
                    set(id, { ...l, steps: l.steps.map((x, j) => (j === i ? { ...x, userId: e.target.value || undefined } : x)) })
                  }
                >
                  <option value="">미지정</option>
                  {users.data
                    .filter((u) => u.active)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({ROLE_LABEL[u.role]})
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div>
      <PageHeader
        title="결재선"
        desc="현장마다 기본 결재선을 정해 두면 구매청구서(2단계)에 자동으로 들어가고, 청구서마다 바꿀 수 있습니다. 담당자는 언제든 바꿀 수 있습니다."
        actions={
          <button className="btn-primary" disabled={!dirty.size} onClick={save}>
            저장 {dirty.size ? `(${dirty.size})` : ''}
          </button>
        }
      />
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>현장</th>
              <th>유형</th>
              <th>단계별 결재자</th>
            </tr>
          </thead>
          <tbody>
            {row(DEFAULT_ID, '회사 기본값', '현장 결재선을 따로 정하지 않으면 이 값을 씁니다')}
            {sites.data.map((s) => row(s.id, s.name, s.code))}
          </tbody>
        </table>
        {!sites.data.length && <Empty>현장을 먼저 등록하세요.</Empty>}
      </div>
    </div>
  );
}
