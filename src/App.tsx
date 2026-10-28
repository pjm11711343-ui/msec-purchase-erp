import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Summary from './pages/Summary';
import Invoices from './pages/Invoices';
import InvoiceMatch from './pages/InvoiceMatch';
import ItemLedger from './pages/ItemLedger';
import ReqList from './pages/req/ReqList';
import ReqEdit from './pages/req/ReqEdit';
import PoList from './pages/po/PoList';
import PoDetail from './pages/po/PoDetail';
import ReceiptStatus from './pages/ReceiptStatus';
import VendorPortal from './pages/portal/VendorPortal';
import ImportRequisition from './pages/ImportRequisition';
import Sites from './pages/master/Sites';
import Vendors from './pages/master/Vendors';
import Categories from './pages/master/Categories';
import Prices from './pages/master/Prices';
import Users from './pages/master/Users';
import Approval from './pages/master/Approval';
import SettingsPage from './pages/master/Settings';
import type { Role } from './types';

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { can } = useAuth();
  return can(...roles) ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  const { fbUser, profile, vendor, loading, logout } = useAuth();
  if (loading) return <div className="flex h-full items-center justify-center text-muted">불러오는 중…</div>;
  if (!fbUser) return <Login />;
  if (vendor) return vendor.active ? <VendorPortal /> : <div className="flex h-full flex-col items-center justify-center gap-3"><div className="text-[16px] font-semibold">사용이 중지된 업체 계정입니다.</div><button className="btn-ghost" onClick={logout}>로그아웃</button></div>;
  if (!profile || !profile.active)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-[16px] font-semibold">{profile ? '사용이 중지된 계정입니다.' : 'ERP에 등록되지 않은 계정입니다.'}</div>
        <div className="text-muted">관리자에게 사용자 등록을 요청하세요. ({fbUser.email})</div>
        <button className="btn-ghost" onClick={logout}>
          로그아웃
        </button>
      </div>
    );
  const OFFICE: Role[] = ['admin', 'material'];
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="summary" element={<Summary />} />
        <Route path="req" element={<ReqList />} />
        <Route path="req/:id" element={<ReqEdit />} />
        <Route path="po" element={<PoList />} />
        <Route path="po/:id" element={<PoDetail />} />
        <Route path="receipt" element={<ReceiptStatus />} />
        <Route path="invoices" element={<Guard roles={OFFICE}><Invoices /></Guard>} />
        <Route path="invoices/:id" element={<Guard roles={OFFICE}><InvoiceMatch /></Guard>} />
        <Route path="items" element={<Guard roles={[...OFFICE, 'executive']}><ItemLedger /></Guard>} />
        <Route path="import/requisition" element={<Guard roles={OFFICE}><ImportRequisition /></Guard>} />
        <Route path="master/sites" element={<Guard roles={OFFICE}><Sites /></Guard>} />
        <Route path="master/vendors" element={<Guard roles={OFFICE}><Vendors /></Guard>} />
        <Route path="master/categories" element={<Guard roles={OFFICE}><Categories /></Guard>} />
        <Route path="master/prices" element={<Guard roles={OFFICE}><Prices /></Guard>} />
        <Route path="master/users" element={<Guard roles={['admin']}><Users /></Guard>} />
        <Route path="master/approval" element={<Guard roles={OFFICE}><Approval /></Guard>} />
        <Route path="master/settings" element={<Guard roles={['admin']}><SettingsPage /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
