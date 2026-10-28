import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL, type Role } from '../types';

interface Item {
  to: string;
  label: string;
  roles?: Role[];
  soon?: string; // 아직 만들지 않은 단계
}

const ALL: Role[] = ['admin', 'material', 'executive', 'siteManager', 'siteStaff'];
const OFFICE: Role[] = ['admin', 'material'];

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: '현황',
    items: [
      { to: '/', label: '대시보드', roles: ALL },
      { to: '/summary', label: '투입집계', roles: ALL },
      { to: '/items', label: '월별 품목', roles: [...OFFICE, 'executive'] },
    ],
  },
  {
    title: '구매 흐름',
    items: [
      { to: '/req', label: '구매청구', roles: ALL },
      { to: '/po', label: '발주', roles: ALL },
      { to: '/receipt', label: '입고 현황', roles: ALL },
      { to: '/invoices', label: '계산서', roles: OFFICE },
    ],
  },
  {
    title: '이관',
    items: [{ to: '/import/requisition', label: '청구서 파일 이관', roles: OFFICE }],
  },
  {
    title: '기준정보',
    items: [
      { to: '/master/sites', label: '현장', roles: OFFICE },
      { to: '/master/vendors', label: '업체', roles: OFFICE },
      { to: '/master/categories', label: '분류', roles: OFFICE },
      { to: '/master/prices', label: '단가 조회', roles: OFFICE },
      { to: '/master/users', label: '사용자', roles: ['admin'] },
      { to: '/master/approval', label: '결재선', roles: OFFICE },
      { to: '/master/settings', label: '설정', roles: ['admin'] },
    ],
  },
];

export default function Layout() {
  const { profile, logout } = useAuth();
  const role = profile?.role;
  // 구매청구서 작성 화면은 열이 많아 화면 가로 전체를 쓴다
  const wide = /^\/req\/./.test(useLocation().pathname);
  return (
    <div className="flex h-full">
      <aside className="flex w-[212px] shrink-0 flex-col bg-navy-950 text-white/80">
        <div className="px-5 pb-4 pt-5">
          <div className="text-[11px] font-medium tracking-[0.2em] text-amber-brand">MYUNGSIN</div>
          <div className="mt-0.5 text-[15px] font-bold text-white">구매관리 ERP</div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {GROUPS.map((g) => {
            const items = g.items.filter((i) => i.soon || (role && (!i.roles || i.roles.includes(role))));
            if (!items.length) return null;
            return (
              <div key={g.title} className="mb-4">
                <div className="px-2 pb-1 text-[11px] font-semibold text-white/35">{g.title}</div>
                {items.map((i) =>
                  i.soon ? (
                    <div key={i.to} className="flex items-center justify-between rounded-md px-2 py-1.5 text-white/30">
                      {i.label}
                      <span className="text-[10px]">{i.soon}</span>
                    </div>
                  ) : (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      end={i.to === '/'}
                      className={({ isActive }) =>
                        `block rounded-md px-2 py-1.5 transition ${
                          isActive ? 'bg-amber-brand font-semibold text-navy-950' : 'hover:bg-white/8 hover:text-white'
                        }`
                      }
                    >
                      {i.label}
                    </NavLink>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
          <div className="text-[13px] font-semibold text-white">{profile?.name}</div>
          <div className="text-[11.5px] text-white/50">{role ? ROLE_LABEL[role] : ''}</div>
          <button className="mt-2 text-[12px] text-amber-brand hover:underline" onClick={logout}>
            로그아웃
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={`mx-auto px-6 py-5 ${wide ? 'max-w-none' : 'max-w-[1480px]'}`}>
          {new URLSearchParams(location.search).has('vendor') && (
            <div className="no-print mb-4 flex items-center justify-between rounded-2xl border border-amber-brand bg-amber-soft px-4 py-3">
              <span>
                지금 <b>직원({profile?.name})</b>으로 로그인돼 있어서 업체 화면이 아니라 ERP가 열렸습니다. 업체로 들어가려면 먼저 로그아웃하세요.
              </span>
              <button className="btn-dark" onClick={() => logout()}>
                로그아웃하고 업체 로그인
              </button>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
