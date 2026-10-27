import { useMemo, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { createAccount } from '../../lib/accounts';
import { orderBy } from 'firebase/firestore';
import { audit, commitBatch, useCollection } from '../../lib/db';
import { auth, C, idToEmail, ID_LOGIN_DOMAIN } from '../../lib/firebase';
import { useSites } from '../../lib/hooks';
import { Empty, errMsg, Field, Modal, PageHeader, useToast } from '../../components/ui';
import { ROLE_LABEL, type ErpUser, type Role } from '../../types';

interface Form {
  id: string | null;
  name: string;
  position: string;
  loginType: 'id' | 'email';
  login: string;
  password: string;
  role: Role;
  siteIds: string[];
  active: boolean;
}

const EMPTY: Form = { id: null, name: '', position: '', loginType: 'id', login: '', password: '', role: 'siteStaff', siteIds: [], active: true };

export default function Users() {
  const users = useCollection<ErpUser>(C.users, [orderBy('name')]);
  const sites = useSites();
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  const siteName = (id: string) => sites.data.find((s) => s.id === id)?.name ?? '?';
  const needsSites = (r: Role) => r === 'siteManager' || r === 'siteStaff';

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      if (!form.name.trim()) throw new Error('이름을 입력하세요.');
      let uid = form.id;
      let email = '';
      let loginId: string | undefined;
      if (!uid) {
        const login = form.login.trim();
        if (!login) throw new Error(form.loginType === 'id' ? '아이디를 입력하세요.' : '이메일을 입력하세요.');
        if (form.loginType === 'id' && !/^[a-zA-Z0-9._-]{3,}$/.test(login)) throw new Error('아이디는 영문·숫자 3자 이상으로 만드세요.');
        if (form.password.length < 6) throw new Error('초기 비밀번호는 6자 이상이어야 합니다.');
        email = form.loginType === 'id' ? idToEmail(login) : login;
        loginId = form.loginType === 'id' ? login.toLowerCase() : undefined;
        uid = await createAccount(email, form.password);
      }
      const data: Partial<ErpUser> & { createdAt?: number } = {
        name: form.name.trim(),
        position: form.position.trim() || undefined,
        role: form.role,
        siteIds: needsSites(form.role) ? form.siteIds : [],
        active: form.active,
        ...(form.id ? {} : { email, loginId, createdAt: Date.now() }),
      };
      await commitBatch([{ type: 'set', col: C.users, id: uid, data }]);
      await audit(form.id ? '사용자 수정' : '사용자 추가', uid, { name: data.name, role: data.role });
      toast('저장했습니다.');
      setForm(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (u: ErpUser) => {
    if (u.loginId || u.email.endsWith(`@${ID_LOGIN_DOMAIN}`)) {
      toast('아이디 로그인 사용자는 메일을 받을 수 없습니다. Firebase 콘솔 > Authentication에서 비밀번호를 바꾸거나, 계정을 중지하고 새로 만드세요.', 'err');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, u.email);
      toast(`${u.email}로 비밀번호 재설정 메일을 보냈습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const sorted = useMemo(() => [...users.data].sort((a, b) => Number(b.active) - Number(a.active)), [users.data]);

  return (
    <div>
      <PageHeader
        title="사용자"
        desc="현장소장·현장담당은 담당 현장의 데이터만 볼 수 있습니다. 관리자·자재부는 전체를 봅니다."
        actions={
          <button className="btn-primary" onClick={() => setForm({ ...EMPTY })}>
            + 사용자 추가
          </button>
        }
      />
      <div className="card overflow-hidden">
        {!sorted.length ? (
          <Empty>{users.loading ? '불러오는 중…' : '사용자가 없습니다.'}</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>직급</th>
                <th>로그인</th>
                <th>역할</th>
                <th>담당 현장</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'text-muted'}>
                  <td className="font-medium">{u.name}</td>
                  <td>{u.position}</td>
                  <td>{u.loginId ? `아이디 ${u.loginId}` : u.email}</td>
                  <td>
                    <span className="chip bg-navy-950/5 text-navy-900">{ROLE_LABEL[u.role]}</span>
                  </td>
                  <td className="text-[12px]">{needsSites(u.role) ? (u.siteIds ?? []).map(siteName).join(', ') || <span className="text-amber-700">지정 필요</span> : '전체'}</td>
                  <td>{u.active ? '사용' : '중지'}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost h-7 text-[12px]" onClick={() => reset(u)}>
                      비밀번호 재설정
                    </button>{' '}
                    <button
                      className="btn-ghost h-7 text-[12px]"
                      onClick={() =>
                        setForm({
                          id: u.id,
                          name: u.name,
                          position: u.position ?? '',
                          loginType: u.loginId ? 'id' : 'email',
                          login: u.loginId ?? u.email,
                          password: '',
                          role: u.role,
                          siteIds: u.siteIds ?? [],
                          active: u.active,
                        })
                      }
                    >
                      수정
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={!!form}
        title={form?.id ? '사용자 수정' : '사용자 추가'}
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>
              취소
            </button>
            <button className="btn-primary" disabled={busy} onClick={save}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </>
        }
      >
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="이름 *">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="직급">
              <input className="input" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
            </Field>
            {!form.id ? (
              <>
                <Field label="로그인 방식">
                  <select className="input" value={form.loginType} onChange={(e) => setForm({ ...form, loginType: e.target.value as Form['loginType'] })}>
                    <option value="id">아이디</option>
                    <option value="email">이메일</option>
                  </select>
                </Field>
                <Field label={form.loginType === 'id' ? '아이디 *' : '이메일 *'}>
                  <input className="input" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
                </Field>
                <Field label="초기 비밀번호 *" hint="6자 이상. 사용자에게 따로 알려주세요.">
                  <input className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="로그인">
                <input className="input bg-canvas" value={form.login} disabled />
              </Field>
            )}
            <Field label="역할">
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            {form.id && (
              <Field label="상태">
                <select className="input" value={form.active ? '1' : '0'} onChange={(e) => setForm({ ...form, active: e.target.value === '1' })}>
                  <option value="1">사용</option>
                  <option value="0">중지</option>
                </select>
              </Field>
            )}
            {needsSites(form.role) && (
              <div className="col-span-2">
                <Field label={`담당 현장 (${form.siteIds.length}곳)`}>
                  <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2">
                    {sites.data.map((s) => (
                      <label key={s.id} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={form.siteIds.includes(s.id)}
                          onChange={(e) =>
                            setForm({ ...form, siteIds: e.target.checked ? [...form.siteIds, s.id] : form.siteIds.filter((x) => x !== s.id) })
                          }
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                </Field>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
