import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Network,
  ServerCog,
  Users,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox, formatAtomic, Loading, PageHeader } from '../components/ui';

interface Dashboard {
  customers: number;
  workers: number;
  activeConnections: number;
  gateway: { enabled: boolean; activeSockets: number };
  shares24h: { accepted: number; rejected: number; acceptanceRate: number };
  openAlerts: number;
  pendingPayouts: number;
  recentDeposits: Array<{
    id: string;
    asset: 'BTC' | 'XMR';
    amountAtomic: string;
    status: string;
    confirmations: number;
    observedAt: string;
    upstream: { name: string };
  }>;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/api/v1/stats/dashboard'),
    refetchInterval: 15_000,
  });
  if (query.isLoading) return <Loading />;
  if (query.error || !query.data)
    return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const stats = [
    [t('activeCustomers'), data.customers, Users, 'blue'],
    [t('activeWorkers'), data.workers, Activity, 'violet'],
    [t('liveConnections'), data.activeConnections, Network, 'green'],
    [t('accepted24h'), data.shares24h.accepted.toLocaleString(), CheckCircle2, 'cyan'],
    [t('pendingPayouts'), data.pendingPayouts, CircleDollarSign, 'amber'],
    [t('openAlerts'), data.openAlerts, AlertTriangle, 'red'],
  ] as const;
  return (
    <>
      <PageHeader
        title={t('dashboard')}
        subtitle={new Intl.DateTimeFormat(undefined, {
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(new Date())}
        actions={
          <Badge tone={data.gateway.enabled ? 'good' : 'bad'}>
            <span className="pulse-dot" />
            {data.gateway.enabled ? t('online') : t('offline')}
          </Badge>
        }
      />
      <div className="stat-grid">
        {stats.map(([label, value, Icon, color]) => (
          <Card key={label} className="stat-card">
            <div className={`stat-icon ${color}`}>
              <Icon size={21} />
            </div>
            <div>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          </Card>
        ))}
      </div>
      <div className="dashboard-grid">
        <Card>
          <div className="card-title">
            <div>
              <h2>{t('gatewayStatus')}</h2>
              <p>TCP listeners and share acceptance</p>
            </div>
            <ServerCog size={21} />
          </div>
          <div className="acceptance">
            <div
              className="acceptance-ring"
              style={
                {
                  '--rate': `${Math.round(data.shares24h.acceptanceRate * 100)}%`,
                } as React.CSSProperties
              }
            >
              <span>{Math.round(data.shares24h.acceptanceRate * 100)}%</span>
            </div>
            <div className="acceptance-detail">
              <div>
                <span className="legend good" />
                {t('accepted')}
                <strong>{data.shares24h.accepted.toLocaleString()}</strong>
              </div>
              <div>
                <span className="legend bad" />
                {t('rejected')}
                <strong>{data.shares24h.rejected.toLocaleString()}</strong>
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <div className="card-title">
            <div>
              <h2>{t('recentDeposits')}</h2>
              <p>Confirmed pool wallet receipts</p>
            </div>
            <CircleDollarSign size={21} />
          </div>
          {data.recentDeposits.length ? (
            <div className="deposit-list">
              {data.recentDeposits.map((deposit) => (
                <div key={deposit.id}>
                  <div className={`coin coin-${deposit.asset.toLowerCase()}`}>
                    {deposit.asset.slice(0, 1)}
                  </div>
                  <div>
                    <strong>{formatAtomic(deposit.amountAtomic, deposit.asset)}</strong>
                    <span>
                      {deposit.upstream.name} ·{' '}
                      {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                        new Date(deposit.observedAt),
                      )}
                    </span>
                  </div>
                  <Badge tone={deposit.status === 'ALLOCATED' ? 'good' : 'warn'}>
                    {deposit.status}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </Card>
      </div>
    </>
  );
}
