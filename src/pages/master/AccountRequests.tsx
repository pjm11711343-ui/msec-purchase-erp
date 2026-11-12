// 사용자 › 계정 신청 처리 (초기화면에서 현장소장·현장담당이 신청한 것)
import { useMemo, useState } from 'react';
import { orderBy } from 'firebase/firestore';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, useCollection } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites } from '../../lib/hooks';
import { errMsg, Field, Modal, useToast } from '../../components/ui';
import type { AccountRequest, ErpUser } from '../../types';

export function usePendingRequests(enabled = true) {
  const reqs = useCollection<AccountRequest>(C.accountRequests, [orderBy('createdAt', 'desc')], '', enabled);
  return useMemo(() => reqs.data.filter((r) => r.status === 'pending'), [reqs.data]);
}

export default function AccountRequests() {
  const { profile } = useAuth();
  const reqs = useCollection<AccountRequest>(C.accountRequests, [orderBy('createdAt', 'desc')]);
  const sites = useSites();
  const toast = useToast();
  const [showDone, setShowDone] = useState(false);
  const [edit, setEdit] = useState<{ r: AccountRequest; role: AccountRequest['role']; siteIds: string[]; name: string; position: string } | null>(null);
  const [rej, setRej] = useState<{ r: AccountRequest; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = reqs.data.filter((r) => r.status === 'pending');
  const done = reqs.data.filter((r) => r.status !== 'pending');
  const siteLabel = (id: string, fb?: string) => sites.data.find((s) => s.id === id)?.name ?? fb ?? '?';

  const approve = async () => {
    if (!edit) return;
    if (!edit.siteIds.length) return toast('담당 현장을 하나 이상 고르세요.', 'err');
    if (!edit.name.trim()) return toast('이름을 입력하세요.', 'err');
    setBusy(true);
    try {
      const r = edit.r;
      const user: Omit<ErpUser, 'id'> & { createdAt: number } = {
        name: edit.name.trim(),
        email: r.email,
        loginId: r.loginId,
        role: edit.role,
        siteIds: edit.siteIds,
        active: true,
        ...(edit.position.trim() ? { position: edit.position.trim() } : {}),
        ...(r.phone ? { phone: r.phone } : {}),
        createdAt: Date.now(),
      };
      await commitBatch([
        { type: 'set', col: C.users, id: r.id, data: user, merge: false },
        { type: 'set', col: C.accountRequests, id: r.id, data: { status: 'approved', role: edit.role, siteIds: edit.siteIds, siteNames: edit.siteIds.map((id) => siteLabel(id)), decidedAt: Date.now(), decidedBy: profile?.name ?? '' } },
      ]);
      await audit('계정 신청 승인', r.id, { loginId: r.loginId, role: edit.role });
      toast(`${user.name}(${r.loginId}) 계정을 승인했습니다. 신청한 비밀번호로 바로 로그인됩니다.`);
      setEdit(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!rej) return;
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.accountRequests, id: rej.r.id, data: { status: 'rejected', rejectReason: rej.reason.trim(), decidedAt: Date.now(), decidedBy: profile?.name ?? '' } }]);
      await audit('계정 신청 반려', rej.r.id, { loginId: rej.r.loginId, reason: rej.reason });
      toast('반려했습니다. 신청자가 로그인하면 사유가 보이고, 고쳐서 다시 신청할 수 있습니다.');
      setRej(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!reqs.data.length) return null;
  const row = (r: AccountRequest, act: boolean) => (
    <tr key={r.id}>
      <td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>
        <b>{r.name}</b>
        <div className="text-[11.5px] text-muted">{r.phone}</div>
      </td>
      <td>{r.loginId}</td>
      <td>{r.role === 'siteManager' ? '현장소장' : '현장담당'}</td>
      <td className="text-[12px]">{r.siteIds.map((id, i) => siteLabel(id, r.siteNames[i])).join(', ')}</td>
      <td className="max-w-[220px] text-[12px] text-muted">{r.memo}</td>
      <td className="whitespace-nowrap">
        {act ? (
          <>
            <button className="btn-primary h-7 text-[12px]" onClick={() => setEdit({ r, role: r.role, siteIds: r.siteIds.filter((id) => sites.data.some((s) => s.id === id)), name: r.name, position: '' })}>
              승인
            </button>{' '}
            <button className="btn-ghost h-7 text-[12px] text-red-600" onClick={() => setRej({ r, reason: '' })}>
              반려
            </button>
          </>
        ) : (
          <span className={`chip ${r.status === 'approved' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`} title={r.rejectReason}>
            {r.status === 'approved' ? '승인' : '반려'} · {r.decidedBy}
          </span>
        )}
      </td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th>신청일</th>
        <th>이름</th>
        <th>아이디</th>
        <th>역할</th>
        <th>현장</th>
        <th>메모</th>
        <th></th>
      </tr>
    </thead>
  );

  return (
    <div className={`card mb-4 overflow-hidden ${pending.length ? 'border-amber-300' : ''}`}>
      <div className={`flex items-center gap-2 border-b border-line px-4 py-2.5 ${pending.length ? 'bg-amber-50' : 'bg-[#f7f8fb]'}`}>
        <span className="font-semibold text-navy-950">계정 신청</span>
        {pending.length > 0 && <span className="chip bg-amber-brand text-navy-950">대기 {pending.length}건</span>}
        <span className="flex-1" />
        {done.length > 0 && (
          <button className="text-[12px] text-muted hover:text-ink" onClick={() => setShowDone((v) => !v)}>
            {showDone ? '처리한 신청 숨기기' : `처리한 신청 ${done.length}건 보기`}
          </button>
        )}
      </div>
      {pending.length > 0 ? (
        <table className="tbl text-[12.5px]">
          {head}
          <tbody>{pending.map((r) => row(r, true))}</tbody>
        </table>
      ) : (
        <div className="px-4 py-3 text-[12.5px] text-muted">대기 중인 신청이 없습니다.</div>
      )}
      {showDone && done.length > 0 && (
        <table className="tbl border-t border-line text-[12.5px]">
          {head}
          <tbody>{done.map((r) => row(r, false))}</tbody>
        </table>
      )}

      {edit && (
        <Modal
          open
          title={`계정 승인 · ${edit.r.loginId}`}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setEdit(null)}>
                취소
              </button>
              <button className="btn-primary" disabled={busy} onClick={approve}>
                {busy ? '처리 중…' : '승인하고 사용자 등록'}
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="이름">
                <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="직급 (선택)">
                <input className="input" placeholder="예: 소장, 대리" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} />
              </Field>
            </div>
            <Field label="역할">
              <div className="flex gap-2">
                {(['siteManager', 'siteStaff'] as const).map((k) => (
                  <label key={k} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] ${edit.role === k ? 'border-amber-brand bg-amber-50 font-semibold' : 'border-line'}`}>
                    <input type="radio" checked={edit.role === k} onChange={() => setEdit({ ...edit, role: k })} />
                    {k === 'siteManager' ? '현장소장' : '현장담당'}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="담당 현장">
              <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2">
                {sites.data.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 text-[12.5px]">
                    <input type="checkbox" checked={edit.siteIds.includes(s.id)} onChange={() => setEdit({ ...edit, siteIds: edit.siteIds.includes(s.id) ? edit.siteIds.filter((x) => x !== s.id) : [...edit.siteIds, s.id] })} />
                    <span className={edit.r.siteIds.includes(s.id) ? 'font-semibold' : ''}>{s.name}</span>
                  </label>
                ))}
              </div>
            </Field>
            <div className="text-[12px] text-muted">
              신청 내용: {edit.r.role === 'siteManager' ? '현장소장' : '현장담당'} · {edit.r.siteNames.join(', ')} · {edit.r.phone}
              {edit.r.memo ? ` · ${edit.r.memo}` : ''}
            </div>
          </div>
        </Modal>
      )}
      {rej && (
        <Modal
          open
          title={`계정 신청 반려 · ${rej.r.loginId}`}
          onClose={() => setRej(null)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setRej(null)}>
                취소
              </button>
              <button className="btn-primary" disabled={busy} onClick={reject}>
                반려
              </button>
            </>
          }
        >
          <Field label="반려 사유 (신청자에게 보입니다)">
            <input className="input" autoFocus placeholder="예: 현장을 잘못 골랐습니다. OO현장으로 다시 신청해 주세요." value={rej.reason} onChange={(e) => setRej({ ...rej, reason: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
