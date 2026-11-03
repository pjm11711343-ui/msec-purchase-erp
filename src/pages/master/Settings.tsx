import { useEffect, useState } from 'react';
import { deleteField } from 'firebase/firestore';
import { audit, commitBatch, saveDoc, useCollection, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { errMsg, Field, PageHeader, useToast } from '../../components/ui';
import { EXEC_MENUS, type ErpUser, type Settings } from '../../types';

/** 메뉴 체크 묶음 (value undefined = 전부 허용) */
function MenuChecks({ value, onChange, disabled }: { value?: string[] | null; onChange: (v: string[]) => void; disabled?: boolean }) {
  const all = EXEC_MENUS.map((x) => x.to);
  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? 'opacity-50' : ''}`}>
      {['현황', '구매 흐름'].map((g) => (
        <div key={g} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="w-16 text-[12px] font-semibold text-muted">{g}</span>
          {EXEC_MENUS.filter((m) => m.group === g).map((m) => (
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
  const execs = users.data.filter((u) => u.role === 'executive').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
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
        <Field label="결재자(대표·사장) 화면에 보일 메뉴" hint="끈 메뉴는 그 결재자의 메뉴에서 사라지고, 주소로 들어가도 열리지 않습니다. 구매청구를 끄면 청구서를 결재할 수 없으니 주의하세요.">
          <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <div>
              <div className="mb-1 text-[12.5px] font-semibold">공통 (개별 설정이 없는 결재자)</div>
              <MenuChecks value={d.execMenus} onChange={(v) => setD({ ...d, execMenus: v })} />
            </div>
            {execs.map((u) => {
              const own = um[u.id] != null;
              return (
                <div key={u.id} className="border-t border-line pt-3">
                  <div className="mb-1 flex items-center gap-3">
                    <span className="text-[12.5px] font-semibold">
                      {u.name} {u.position && <span className="font-normal text-muted">{u.position}</span>}
                    </span>
                    <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
                      <input type="checkbox" checked={own} onChange={(e) => setUm({ ...um, [u.id]: e.target.checked ? (d.execMenus ?? EXEC_MENUS.map((x) => x.to)) : null })} />
                      따로 설정
                    </label>
                  </div>
                  <MenuChecks value={own ? um[u.id] : d.execMenus} disabled={!own} onChange={(v) => setUm({ ...um, [u.id]: v })} />
                </div>
              );
            })}
            {!execs.length && <div className="text-[12px] text-muted">결재자(대표·사장) 역할 사용자가 아직 없습니다. 기준정보 › 사용자에서 만들면 여기서 따로 설정할 수 있습니다.</div>}
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
