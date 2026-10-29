import { useMemo, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { createAccount } from '../../lib/accounts';
import { deleteField, orderBy } from 'firebase/firestore';
import { audit, commitBatch, useCollection } from '../../lib/db';
import { prepareSign } from '../../lib/sign';
import TelegramChatFinder from '../../components/TelegramChatFinder';
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
  sign: string; // 싸인 이미지 ('' = 없음)
  telegram: string; // 개인 텔레그램 Chat ID
}

/** 사용자 화면 칸 순서와 설명 */
const ROLE_ORDER: Role[] = ['admin', 'material', 'executive', 'siteManager', 'siteStaff'];
const ROLE_DESC: Record<Role, string> = {
  admin: '모든 메뉴·사용자 관리',
  material: '전체 현장 · 발주·계산서·기준정보',
  executive: '결재와 열람만',
  siteManager: '담당 현장 · 청구서 결재',
  siteStaff: '담당 현장 · 청구서 작성',
};

const EMPTY: Form = { id: null, name: '', position: '', loginType: 'id', login: '', password: '', role: 'siteStaff', siteIds: [], active: true, sign: '', telegram: '' };

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
        ...(form.sign ? { signImage: form.sign } : form.id ? { signImage: deleteField() as unknown as string } : {}),
        ...(form.telegram.trim() ? { telegramChatId: form.telegram.trim() } : form.id ? { telegramChatId: deleteField() as unknown as string } : {}),
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

  const sorted = useMemo(() => [...users.data].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ko')), [users.data]);
  const [tab, setTab] = useState<'all' | Role>('all');

  const table = (list: ErpUser[]) => (
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>직급</th>
                <th>로그인</th>
                <th>역할</th>
                <th>담당 현장</th>
                <th>싸인</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'text-muted'}>
                  <td className="font-medium">{u.name}</td>
                  <td>{u.position}</td>
                  <td>{u.loginId ? `아이디 ${u.loginId}` : u.email}</td>
                  <td>
                    <span className="chip bg-navy-950/5 text-navy-900">{ROLE_LABEL[u.role]}</span>
                  </td>
                  <td className="text-[12px]">{needsSites(u.role) ? (u.siteIds ?? []).map(siteName).join(', ') || <span className="text-amber-700">지정 필요</span> : '전체'}</td>
                  <td>{u.signImage ? <img src={u.signImage} alt={`${u.name} 싸인`} className="h-7 max-w-[90px] object-contain" /> : <span className="text-[11px] text-muted">없음</span>}</td>
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
                          sign: u.signImage ?? '',
                          telegram: u.telegramChatId ?? '',
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
  );

  return (
    <div>
      <PageHeader
        title="사용자"
        desc="현장소장·현장담당은 담당 현장의 데이터만 볼 수 있습니다. 관리자·자재부는 전체를 봅니다."
        actions={
          <div className="flex gap-2">
            <TelegramChatFinder />
            <button className="btn-primary" onClick={() => setForm({ ...EMPTY })}>
              + 사용자 추가
            </button>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
        {(['all', ...ROLE_ORDER] as const).map((k) => {
          const n = k === 'all' ? sorted.length : sorted.filter((u) => u.role === k).length;
          return (
            <button
              key={k}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${tab === k ? 'bg-navy-950 text-white' : 'text-muted hover:bg-canvas hover:text-ink'}`}
              onClick={() => setTab(k)}
            >
              {k === 'all' ? '전체' : ROLE_LABEL[k]}
              <span className={`ml-1.5 rounded-full px-1.5 text-[11px] ${tab === k ? 'bg-white/20' : 'bg-canvas'}`}>{n}</span>
            </button>
          );
        })}
      </div>
      {!sorted.length ? (
        <div className="card overflow-hidden">
          <Empty>{users.loading ? '불러오는 중…' : '사용자가 없습니다.'}</Empty>
        </div>
      ) : (
        (tab === 'all' ? ROLE_ORDER : [tab]).map((r) => {
          const list = sorted.filter((u) => u.role === r);
          if (tab === 'all' && !list.length) return null;
          return (
            <div key={r} className="card mb-4 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line bg-[#f7f8fb] px-4 py-2.5">
                <span className="font-semibold text-navy-950">{ROLE_LABEL[r]}</span>
                <span className="text-[12px] text-muted">
                  {list.length}명 · {ROLE_DESC[r]}
                </span>
                <button className="btn-ghost ml-auto h-7 text-[12px]" onClick={() => setForm({ ...EMPTY, role: r })}>
                  + {ROLE_LABEL[r]} 추가
                </button>
              </div>
              {list.length ? table(list) : <Empty>{ROLE_LABEL[r]} 사용자가 없습니다.</Empty>}
            </div>
          );
        })
      )}

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
            <div className="col-span-2">
              <Field label="텔레그램 Chat ID (개인)" hint="결재 차례가 되면 개인 텔레그램으로 알림. 이 사람이 ERP 알림 봇에게 아무 말이나 보낸 뒤, 사용자 화면 위 '텔레그램 대화방 찾기'에서 복사해 붙여 넣으세요.">
                <input className="input" placeholder="예: 123456789" value={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="결재 싸인" hint="흰 종이에 쓴 싸인을 찍은 사진·스캔(JPG·PNG). 바탕은 자동으로 지우고 싸인 부분만 잘라 저장합니다. 결재 승인하면 청구서·발주서 결재란에 들어갑니다.">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex h-16 w-44 items-center justify-center rounded-md border border-dashed border-line bg-[repeating-conic-gradient(#f3f4f6_0%_25%,#fff_0%_50%)] bg-[length:12px_12px]">
                    {form.sign ? <img src={form.sign} alt="싸인 미리보기" className="max-h-14 max-w-40 object-contain" /> : <span className="text-[12px] text-muted">싸인 없음</span>}
                  </div>
                  <label className="btn-ghost h-8 cursor-pointer text-[12px]">
                    {form.sign ? '다른 이미지로 바꾸기' : '싸인 이미지 첨부'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f) return;
                        try {
                          const sign = await prepareSign(f);
                          setForm((x) => x && { ...x, sign });
                        } catch (err) {
                          toast(errMsg(err), 'err');
                        }
                      }}
                    />
                  </label>
                  {form.sign && (
                    <button className="text-[12px] text-muted hover:text-red-600" onClick={() => setForm({ ...form, sign: '' })}>
                      싸인 지우기
                    </button>
                  )}
                </div>
              </Field>
            </div>
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
