import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL, type Role } from '../types';
import { usePurchaseOrders } from '../lib/pos';
import { usePoPriceSync } from '../lib/poPrices';

/** 업체가 기입한 빈 단가를 발주서에 옮겨 적는다 (자재부·관리자 화면이 열려 있을 때) */
function PoPriceSync() {
  const pos = usePurchaseOrders();
  usePoPriceSync(pos.data, !pos.loading);
  return null;
}

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
      { to: '/process', label: '공정별 청구', roles: ALL },
      { to: '/req', label: '구매청구', roles: ALL },
      { to: '/rfq', label: '견적 의뢰', roles: OFFICE },
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
      { to: '/master/processes', label: '구역·공종', roles: OFFICE },
      { to: '/master/items-prices', label: '품목·단가', roles: OFFICE },
      { to: '/master/prices', label: '단가관리 단가 조회', roles: OFFICE },
      { to: '/master/req-alias', label: '품명 다른 표기', roles: OFFICE },
      { to: '/master/users', label: '사용자', roles: ['admin'] },
      { to: '/master/approval', label: '결재선', roles: OFFICE },
      { to: '/master/settings', label: '설정', roles: ['admin'] },
    ],
  },
];

export default function Layout() {
  const { profile, logout } = useAuth();
  const role = profile?.role;
  const loc = useLocation();
  // 구매청구서 작성 화면은 열이 많아 화면 가로 전체를 쓴다
  const wide = /^\/req\/./.test(loc.pathname);
  // 폰·태블릿 세로: 메뉴는 ☰로 여닫는 서랍 / PC: 왼쪽 고정 (접기 가능)
  const [open, setOpen] = useState(false);
  const [mini, setMini] = useState(() => {
    try {
      return localStorage.getItem('erp.navMini') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => setOpen(false), [loc.pathname, loc.search]);
  const toggleMini = () => {
    setMini((v) => {
      try {
        localStorage.setItem('erp.navMini', v ? '0' : '1');
      } catch {
        /* 저장 못 해도 동작은 그대로 */
      }
      return !v;
    });
  };
  const curLabel = GROUPS.flatMap((g) => g.items).find((i) => (i.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(i.to)))?.label ?? '';
  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* 폰·태블릿 위쪽 막대 */}
      <header className="no-print sticky top-0 z-30 flex items-center gap-2 bg-navy-950 px-3 py-2 text-white lg:hidden">
        <button className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/8" aria-label="메뉴 열기" onClick={() => setOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] tracking-[0.18em] text-amber-brand">MYUNGSIN ERP</div>
          <div className="truncate text-[15px] font-bold">{curLabel || '구매관리 ERP'}</div>
        </div>
        <span className="text-[12px] text-white/70">{profile?.name}</span>
      </header>
      {open && <div className="no-print fixed inset-0 z-40 bg-navy-950/45 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-50 flex w-[260px] shrink-0 flex-col bg-navy-950 text-white/80 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        } ${mini ? 'lg:w-[64px]' : 'lg:w-[212px]'}`}
      >
        <div className={`flex items-start justify-between pb-4 pt-5 ${mini ? 'lg:px-2' : 'px-5'} px-5`}>
          <div className={mini ? 'lg:hidden' : ''}>
            <div className="text-[11px] font-medium tracking-[0.2em] text-amber-brand">MYUNGSIN</div>
            <div className="mt-0.5 text-[15px] font-bold text-white">구매관리 ERP</div>
          </div>
          <button className="flex h-9 w-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/8 lg:hidden" aria-label="메뉴 닫기" onClick={() => setOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <button className="hidden h-8 w-8 items-center justify-center rounded-lg text-white/60 hover:bg-white/8 hover:text-white lg:flex" title={mini ? '메뉴 펼치기' : '메뉴 접기'} aria-label={mini ? '메뉴 펼치기' : '메뉴 접기'} onClick={toggleMini}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {mini ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
            </svg>
          </button>
        </div>
        <nav className={`flex-1 overflow-y-auto pb-4 px-3 ${mini ? 'lg:px-1.5' : ''}`}>
          {GROUPS.map((g) => {
            const items = g.items.filter((i) => i.soon || (role && (!i.roles || i.roles.includes(role))));
            if (!items.length) return null;
            return (
              <div key={g.title} className="mb-4">
                <div className={`px-2 pb-1 text-[11px] font-semibold text-white/35 ${mini ? 'lg:hidden' : ''}`}>{g.title}</div>
                {mini && <div className="mx-2 mb-1 hidden border-t border-white/10 lg:block" />}
                {items.map((i) =>
                  i.soon ? (
                    <div key={i.to} className={`flex items-center justify-between rounded-md px-2 py-1.5 text-white/30 ${mini ? 'lg:hidden' : ''}`}>
                      {i.label}
                      <span className="text-[10px]">{i.soon}</span>
                    </div>
                  ) : (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      end={i.to === '/'}
                      title={i.label}
                      className={({ isActive }) =>
                        `block rounded-md px-2 py-2.5 text-[14px] transition lg:py-1.5 lg:text-[13px] ${mini ? 'lg:truncate lg:px-1 lg:text-center lg:text-[11px]' : ''} ${
                          isActive ? 'bg-amber-brand font-semibold text-navy-950' : 'hover:bg-white/8 hover:text-white'
                        }`
                      }
                    >
                      <span className={mini ? 'lg:hidden' : ''}>{i.label}</span>
                      {mini && <span className="hidden lg:inline">{i.label.replace(/\s/g, '').slice(0, 2)}</span>}
                    </NavLink>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className={`border-t border-white/10 px-4 py-3 ${mini ? 'lg:px-1 lg:text-center' : ''}`}>
          <div className={`text-[13px] font-semibold text-white ${mini ? 'lg:truncate lg:text-[11px]' : ''}`}>{profile?.name}</div>
          <div className={`text-[11.5px] text-white/50 ${mini ? 'lg:hidden' : ''}`}>{role ? ROLE_LABEL[role] : ''}</div>
          <button className="mt-2 text-[12px] text-amber-brand hover:underline" onClick={logout}>
            로그아웃
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={`mx-auto px-2.5 py-3 sm:px-4 sm:py-4 lg:px-6 lg:py-5 ${wide ? 'max-w-none' : 'max-w-[1480px]'}`}>
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
          {(role === 'admin' || role === 'material') && <PoPriceSync />}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
