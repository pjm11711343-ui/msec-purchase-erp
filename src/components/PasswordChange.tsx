// 내 비밀번호 바꾸기 (직원·협력업체 공용): 지금 비밀번호 확인 → 새 비밀번호
import { useState } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Field, Modal, useToast } from './ui';

export default function PasswordChange({ onClose, label = '비밀번호' }: { onClose: () => void; label?: string }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr('');
    if (pw.length < 6) return setErr(`새 ${label}는 6자 이상이어야 합니다.`);
    if (pw !== pw2) return setErr(`새 ${label} 두 칸이 서로 다릅니다.`);
    if (pw === cur) return setErr(`지금 ${label}와 다르게 정하세요.`);
    const u = auth.currentUser;
    if (!u?.email) return setErr('로그인 정보를 찾을 수 없습니다. 다시 로그인하세요.');
    setBusy(true);
    try {
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur));
      await updatePassword(u, pw);
      toast(`${label}를 바꿨습니다. 다음 로그인부터 새 ${label}를 쓰세요.`);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      setErr(
        code.includes('wrong-password') || code.includes('invalid-credential')
          ? `지금 ${label}가 맞지 않습니다.`
          : code.includes('too-many-requests')
            ? '여러 번 틀려 잠시 막혔습니다. 몇 분 뒤 다시 하세요.'
            : code.includes('weak-password')
              ? `새 ${label}가 너무 쉽습니다. 더 길게 정하세요.`
              : `바꾸지 못했습니다 (${code || (e as Error).message})`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${label} 변경`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" disabled={busy || !cur || !pw || !pw2} onClick={run}>
            {busy ? '바꾸는 중…' : '바꾸기'}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), run())}>
        <Field label={`지금 ${label}`}>
          <input className="input w-full" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
        </Field>
        <Field label={`새 ${label} (6자 이상)`}>
          <input className="input w-full" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label={`새 ${label} 한 번 더`}>
          <input className="input w-full" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        {err && <div className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{err}</div>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
