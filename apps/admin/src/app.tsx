import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/layout';
import { Loading } from './components/ui';
import { AlertsPage } from './pages/alerts';
import { AuditPage } from './pages/audit';
import { CustomersPage } from './pages/customers';
import { DashboardPage } from './pages/dashboard';
import { LedgerPage } from './pages/ledger';
import { LoginPage } from './pages/login';
import { PayoutsPage } from './pages/payouts';
import { SettingsPage } from './pages/settings';
import { UpstreamsPage } from './pages/upstreams';
import { WalletsPage } from './pages/wallets';
import { WorkersPage } from './pages/workers';

function Protected() {
  const { admin, loading } = useAuth();
  if (loading) return <Loading />;
  return admin ? <Layout /> : <Navigate to="/login" replace />;
}
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route index element={<DashboardPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="workers" element={<WorkersPage />} />
        <Route path="upstreams" element={<UpstreamsPage />} />
        <Route path="ledger" element={<LedgerPage />} />
        <Route path="payouts" element={<PayoutsPage />} />
        <Route path="wallets" element={<WalletsPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
