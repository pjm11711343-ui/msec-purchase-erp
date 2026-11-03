import { useEffect, useState } from 'react';
import { deleteField } from 'firebase/firestore';
import { audit, commitBatch, saveDoc, useCollection, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { errMsg, Field, PageHeader, useToast } from '../../components/ui';
import { MENU_ROLES, menusForRole, ROLE_LABEL, roleMenusOf, type ErpUser, type Role, type Settings } from '../../types';

/** 메뉴 체크 묶음 (value undefined = 전부 허용) */
function MenuChecks({ value, onChange, disabled, role }: { value?: string[] | null; onChange: (v: string[]) => void; disabled?: boolean; role: Role }) {
  const list = menusForRole(role);
  const all = list.map((x) => x.to);
  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? 'opacity-50' : ''}`}>
      {['현황', '구매 흐름'].map((g) => (
        <div key={g} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="w-16 text-[12px] font-semibold text-muted">{g}</span>
          {list.filter((m) => m.group === g).map((m) => (
            <label key={m.to} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                disabled={disabled}
                checked={!value || value.includes(m.to)}
                onChange={(e) => {
                  const cur = value ?? all;
                  onChange(e.target.checked ? [...new Set([...cur, m.to])] : cur.filter((x) => x !== m.to));
                }}
              />
              {m.label}
            </label>
          ))}
        </div>
      ))}
      {!disabled && (
        <div className="flex gap-2 pt-0.5">
          <button className="btn-ghost h-7 text-[12px]" onClick={() => onChange(all)}>
            모두 허용
          </button>
          <button className="btn-ghost h-7 text-[12px]" onClick={() => onChange(['/req'])}>
            구매청구(결재)만
          </button>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const toast = useToast();
  const [d, setD] = useState<Settings>(s);
  useEffect(() => setD(s), [s]);
  // 결재자별 메뉴 (대표이사·사장 따로): 개별 설정이 없으면 공통값
  const users = useCollection<ErpUser>(C.users);
  const execs = users.data.filter((u) => MENU_ROLES.includes(u.role) && u.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const [menuRole, setMenuRole] = useState<Role>('executive');
  const setRoleMenus = (r: Role, v: string[]) => (r === 'executive' ? setD({ ...d, execMenus: v }) : setD({ ...d, roleMenus: { ...(d.roleMenus ?? {}), [r]: v } }));
  const [um, setUm] = useState<Record<string, string[] | null>>({}); // uid → 메뉴 (null = 공통 따르기)
  useEffect(() => setUm(Object.fromEntries(execs.map((u) => [u.id, u.menus ?? null]))), [users.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try {
      if (!/^\d{4}-\d{2}$/.test(d.cutoffMonth)) throw new Error('기준월은 2026-09 형식으로 입력하세요.');
      const changed = execs.filter((u) => JSON.stringify(u.menus ?? null) !== JSON.stringify(um[u.id] ?? null));
      if (changed.length) await commitBatch(changed.map((u) => ({ type: 'set' as const, col: C.users, id: u.id, data: { menus: um[u.id] ?? deleteField() } })));
      await saveDoc(C.settings, 'main', { ...d, priceTolerance: Number(d.priceTolerance) || 0 });
      await audit('설정 변경', 'main', d);
      toast('저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  return (
    <div className="max-w-2xl">
      <PageHeader title="설정" />
      <div className="card flex flex-col gap-4 p-5">
        <Field label="이관 기준월" hint="청구서 파일의 투입금액이 이 달까지 반영된 값입니다. 이 달 이후 계산서만 투입원장에 더해집니다.">
          <input className="input w-40" type="month" value={d.cutoffMonth} onChange={(e) => setD({ ...d, cutoffMonth: e.target.value })} />
        </Field>
        <Field label="단가 허용 오차 (원)" hint="5단계 계산서 매칭에서 이 금액 이하 차이는 같은 단가로 봅니다.">
          <input className="input w-40" type="number" value={d.priceTolerance} onChange={(e) => setD({ ...d, priceTolerance: Number(e.target.value) })} />
        </Field>
        <Field label="현장코드 접두어" hint="새 현장에 MS-01, MS-02 … 순서로 코드를 붙입니다.">
          <input className="input w-40" value={d.siteCodePrefix} onChange={(e) => setD({ ...d, siteCodePrefix: e.target.value.trim().toUpperCase() })} />
        </Field>
        <Field label="역할별 화면에 보일 메뉴 (결재자 · 현장소장 · 현장담당)" hint="끈 메뉴는 그 사람의 메뉴에서 사라지고, 주소로 들어가도 열리지 않습니다. 구매청구를 끄면 청구서 작성·결재를 할 수 없으니 주의하세요.">
          <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <div className="flex flex-wrap gap-1">
              {MENU_ROLES.map((r) => (
                <button key={r} className={`rounded-md px-3 py-1 text-[12.5px] ${menuRole === r ? 'bg-navy-950 text-white' : 'border border-line text-muted hover:text-ink'}`} onClick={() => setMenuRole(r)}>
                  {ROLE_LABEL[r]} {execs.filter((u) => u.role === r).length ? `(${execs.filter((u) => u.role === r).length})` : ''}
                </button>
              ))}
            </div>
            <div>
              <div className="mb-1 text-[12.5px] font-semibold">{ROLE_LABEL[menuRole]} 공통 (따로 설정하지 않은 사람)</div>
              <MenuChecks role={menuRole} value={roleMenusOf(d, menuRole)} onChange={(v) => setRoleMenus(menuRole, v)} />
            </div>
            {execs
              .filter((u) => u.role === menuRole)
              .map((u) => {
                const own = um[u.id] != null;
                const common = roleMenusOf(d, menuRole);
                return (
                  <div key={u.id} className="border-t border-line pt-3">
                    <div className="mb-1 flex items-center gap-3">
                      <span className="text-[12.5px] font-semibold">
                        {u.name} {u.position && <span className="font-normal text-muted">{u.position}</span>}
                      </span>
                      <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
                        <input type="checkbox" checked={own} onChange={(e) => setUm({ ...um, [u.id]: e.target.checked ? (common ?? menusForRole(menuRole).map((x) => x.to)) : null })} />
                        따로 설정
                      </label>
                    </div>
                    <MenuChecks role={menuRole} value={own ? um[u.id] : common} disabled={!own} onChange={(v) => setUm({ ...um, [u.id]: v })} />
                  </div>
                );
              })}
            {!execs.some((u) => u.role === menuRole) && <div className="text-[12px] text-muted">{ROLE_LABEL[menuRole]} 역할 사용자가 아직 없습니다.</div>}
          </div>
        </Field>
        <div>
          <button className="btn-primary" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
