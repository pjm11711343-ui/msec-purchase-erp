import { useEffect, useState } from 'react';
import { audit, saveDoc, useSettings } from '../../lib/db';
import { C } from '../../lib/firebase';
import { errMsg, Field, PageHeader, useToast } from '../../components/ui';
import { EXEC_MENUS, type Settings } from '../../types';

export default function SettingsPage() {
  const s = useSettings();
  const toast = useToast();
  const [d, setD] = useState<Settings>(s);
  useEffect(() => setD(s), [s]);
  const save = async () => {
    try {
      if (!/^\d{4}-\d{2}$/.test(d.cutoffMonth)) throw new Error('기준월은 2026-09 형식으로 입력하세요.');
      await saveDoc(C.settings, 'main', { ...d, priceTolerance: Number(d.priceTolerance) || 0 });
      await audit('설정 변경', 'main', d);
      toast('저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  return (
    <div className="max-w-xl">
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
        <Field label="결재자(대표·사장) 화면에 보일 메뉴" hint="끈 메뉴는 결재자 계정의 메뉴에서 사라지고, 주소로 들어가도 열리지 않습니다. 구매청구를 끄면 결재자가 청구서를 결재할 수 없으니 주의하세요.">
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
            {['현황', '구매 흐름'].map((g) => (
              <div key={g} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="w-16 text-[12px] font-semibold text-muted">{g}</span>
                {EXEC_MENUS.filter((m) => m.group === g).map((m) => {
                  const on = !d.execMenus || d.execMenus.includes(m.to);
                  return (
                    <label key={m.to} className="flex items-center gap-1.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const cur = d.execMenus ?? EXEC_MENUS.map((x) => x.to);
                          setD({ ...d, execMenus: e.target.checked ? [...new Set([...cur, m.to])] : cur.filter((x) => x !== m.to) });
                        }}
                      />
                      {m.label}
                    </label>
                  );
                })}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, execMenus: EXEC_MENUS.map((x) => x.to) })}>
                모두 허용
              </button>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, execMenus: ['/req'] })}>
                구매청구(결재)만
              </button>
            </div>
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
