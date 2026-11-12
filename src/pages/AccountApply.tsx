// 초기화면 · 현장 계정 신청 (현장소장·현장담당) + 승인 대기 화면
import { useMemo, useState } from 'react';
import { resubmitAccountRequest, submitAccountRequest, usePublicSites, useMyAccountRequest, type PublicSite } from '../lib/accountRequests';
import { errMsg, Field } from '../components/ui';
import type { AccountRequest } from '../types';

type RoleKey = 'siteManager' | 'siteStaff';
const ROLES: [RoleKey, string, string][] = [
  ['siteManager', '현장소장', '담당 현장 · 청구서 결재'],
  ['siteStaff', '현장담당', '담당 현장 · 청구서 작성'],
];

function SitePicker({ value, onChange }: { value: PublicSite[]; onChange: (v: PublicSite[]) => void }) {
  const sites = usePublicSites();
  const [q, setQ] = useState('');
  const shown = useMemo(() => (sites ?? []).filter((s) => !q.trim() || s.name.replace(/\s/g, '').includes(q.replace(/\s/g, ''))), [sites, q]);
  const on = (s: PublicSite) => value.some((x) => x.id === s.id);
  if (sites === null) return <div className="text-[12.5px] text-muted">현장 목록을 불러오는 중…</div>;
  if (!sites.length) return <div className="rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">현장 목록이 아직 준비되지 않았습니다. 자재부에 문의하세요.</div>;
  return (
    <div>
      <input className="input mb-1.5 h-8" placeholder="현장 이름으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-40 overflow-y-auto rounded-md border border-line p-1">
        {shown.map((s) => (
          <label key={s.id} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] ${on(s) ? 'bg-amber-50 font-semibold' : 'hover:bg-canvas'}`}>
            <input type="checkbox" checked={on(s)} onChange={() => onChange(on(s) ? value.filter((x) => x.id !== s.id) : [...value, s])} />
            {s.name}
          </label>
        ))}
        {!shown.length && <div className="px-2 py-1 text-[12.5px] text-muted">맞는 현장이 없습니다.</div>}
      </div>
      {value.length > 0 && <div className="mt-1 text-[12px] text-muted">선택: {value.map((s) => s.name).join(', ')}</div>}
    </div>
  );
}

/** 신청서 (처음 신청 / 반려 후 다시 신청) */
export function AccountApplyForm({ onCancel, again }: { onCancel?: () => void; again?: AccountRequest }) {
  const [role, setRole] = useState<RoleKey>(again?.role ?? 'siteStaff');
  const [sites, setSites] = useState<PublicSite[]>(again ? again.siteIds.map((id, i) => ({ id, name: again.siteNames[i] ?? '' })) : []);
  const [name, setName] = useState(again?.name ?? '');
  const [phone, setPhone] = useState(again?.phone ?? '');
  const [memo, setMemo] = useState(again?.memo ?? '');
  const [loginId, setLoginId] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      if (!sites.length) throw new Error('현장을 하나 이상 고르세요.');
      if (!name.trim()) throw new Error('이름을 입력하세요.');
      if (!/^01[016789][-\s]?\d{3,4}[-\s]?\d{4}$/.test(phone.trim())) throw new Error('휴대폰 번호를 확인하세요. (예: 010-1234-5678)');
      if (!again) {
        if (!/^[a-zA-Z0-9._-]{3,20}$/.test(loginId.trim())) throw new Error('아이디는 영문·숫자 3~20자로 만드세요.');
        if (pw.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다.');
        if (pw !== pw2) throw new Error('비밀번호 확인이 맞지 않습니다.');
      }
      setBusy(true);
      if (again) {
        await resubmitAccountRequest(again.id, { name, phone, memo, role, sites });
        onCancel?.();
      }
      else await submitAccountRequest({ loginId, password: pw, name, phone, memo, role, sites });
    } catch (e2) {
      const m = errMsg(e2);
      setErr(m.includes('이미 등록된') ? '이미 쓰고 있는 아이디입니다. 다른 아이디를 넣어 주세요.' : m);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-6">
      <h2 className="text-[15px] font-semibold">{again ? '계정 다시 신청' : '현장 계정 신청'}</h2>
      <Field label="역할">
        <div className="grid grid-cols-2 gap-2">
          {ROLES.map(([k, label, desc]) => (
            <button key={k} type="button" onClick={() => setRole(k)} className={`rounded-lg border px-3 py-2 text-left ${role === k ? 'border-amber-brand bg-amber-50' : 'border-line hover:bg-canvas'}`}>
              <div className="text-[13.5px] font-semibold">{label}</div>
              <div className="text-[11.5px] text-muted">{desc}</div>
            </button>
          ))}
        </div>
      </Field>
      <Field label="현장 (여러 곳이면 모두 선택)">
        <SitePicker value={sites} onChange={setSites} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="이름">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="휴대폰">
          <input className="input" inputMode="tel" placeholder="010-0000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      {!again && (
        <>
          <Field label="사용할 아이디" hint="영문·숫자 3~20자">
            <input className="input" value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="비밀번호" hint="6자 이상">
              <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="비밀번호 확인">
              <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </>
      )}
      <Field label="메모 (선택)">
        <input className="input" placeholder="예: OO현장 신규 배치, 공무 담당" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </Field>
      {err && <div className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{err}</div>}
      <div className="mt-1 flex gap-2">
        {onCancel && (
          <button type="button" className="btn-ghost h-9 flex-1" onClick={onCancel}>
            {again ? '취소' : '로그인으로'}
          </button>
        )}
        <button className="btn-primary h-9 flex-[2]" disabled={busy}>
          {busy ? '신청 중…' : '관리자에게 발급 요청'}
        </button>
      </div>
      {!again && <p className="text-[11.5px] leading-5 text-muted">비밀번호는 암호화되어 저장되며 관리자도 볼 수 없습니다. 관리자가 승인하면 이 아이디·비밀번호로 바로 로그인됩니다.</p>}
    </form>
  );
}

/** 로그인은 됐지만 ERP 사용자가 아닐 때: 신청 상태를 보여준다 (신청 기록이 없으면 null) */
export function AccountPending({ uid, logout, fallback }: { uid: string; logout: () => void; fallback?: React.ReactNode }) {
  const req = useMyAccountRequest(uid);
  const [again, setAgain] = useState(false);
  if (req === undefined) return <div className="flex h-full items-center justify-center text-muted">불러오는 중…</div>;
  if (req === null) return <>{fallback}</>;
  return (
    <div className="flex h-full items-center justify-center bg-navy-950 p-6">
      <div className="fade-up w-full max-w-md">
        {again ? (
          <AccountApplyForm again={req} onCancel={() => setAgain(false)} />
        ) : (
          <div className="card flex flex-col gap-3 p-6 text-center">
            {req.status === 'rejected' ? (
              <>
                <div className="text-[16px] font-semibold text-red-600">계정 신청이 반려되었습니다</div>
                {req.rejectReason && <div className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">사유: {req.rejectReason}</div>}
                <button className="btn-primary h-9" onClick={() => setAgain(true)}>
                  고쳐서 다시 신청
                </button>
              </>
            ) : (
              <>
                <div className="text-[16px] font-semibold">관리자 승인을 기다리고 있습니다</div>
                <div className="text-[13px] leading-6 text-muted">승인되면 이 화면이 자동으로 바뀝니다. 급하면 자재부에 연락해 주세요.</div>
              </>
            )}
            <div className="rounded-lg bg-canvas px-4 py-3 text-left text-[12.5px] leading-6">
              <div>
                아이디 <b>{req.loginId}</b> · {req.name} · {req.role === 'siteManager' ? '현장소장' : '현장담당'}
              </div>
              <div>현장: {req.siteNames.join(', ')}</div>
              <div className="text-muted">신청 {new Date(req.createdAt).toLocaleString('ko-KR')}</div>
            </div>
            <button className="btn-ghost h-9" onClick={logout}>
              로그아웃
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
