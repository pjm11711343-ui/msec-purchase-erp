import { useState } from 'react';
import { isConfigured } from '../lib/firebase';
import { useAuth } from '../auth/AuthContext';
import { errMsg, Field } from '../components/ui';

export default function Login() {
  const { login, vendorLogin } = useAuth();
  const [mode, setMode] = useState<'login' | 'vendor'>(() => (new URLSearchParams(location.search).has('vendor') ? 'vendor' : 'login'));
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (mode === 'login') await login(id, pw);
      else await vendorLogin(id, pw);
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-navy-950 p-6">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-[12px] font-medium tracking-[0.3em] text-amber-brand">MYUNGSIN</div>
          <div className="mt-1 text-[22px] font-bold text-white">구매관리 ERP</div>
        </div>
        {!isConfigured && (
          <div className="mb-4 rounded-lg bg-red-500/15 px-4 py-3 text-[12.5px] text-red-200">
            Firebase 설정이 비어 있습니다. 프로젝트 폴더의 .env 파일에 값을 넣고 다시 실행하세요. (README 2번 참고)
          </div>
        )}
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-white/10 p-1">
          {(['login', 'vendor'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`rounded-lg py-1.5 text-[13px] font-semibold transition ${mode === m ? 'bg-amber-brand text-navy-950' : 'text-white/70 hover:text-white'}`}
              onClick={() => (setMode(m), setErr(''))}
            >
              {m === 'login' ? '명신기공 직원' : '협력업체'}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="card flex flex-col gap-3 p-6">
          <h2 className="text-[15px] font-semibold">{mode === 'login' ? '직원 로그인' : '협력업체 로그인'}</h2>
          <Field label={mode === 'vendor' ? '업체코드' : '아이디 또는 이메일'}>
            <input className="input" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus />
          </Field>
          <Field label={mode === 'vendor' ? '접속코드' : '비밀번호'} hint={mode === 'vendor' ? '명신기공 자재부에서 받은 업체코드와 접속코드를 넣으세요' : '계정이 없으면 관리자에게 요청하세요'}>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </Field>
          {err && <div className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{err}</div>}
          <button className="btn-primary mt-1 h-9" disabled={busy || !id || !pw}>
            {busy ? '처리 중…' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}
