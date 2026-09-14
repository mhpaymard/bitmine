import { Activity, Cpu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import {
  Badge,
  Card,
  Empty,
  ErrorBox,
  formatHashrate,
  Loading,
  PageHeader,
} from '../components/ui';

interface WorkerStat {
  id: string;
  slug: string;
  asset: 'BTC' | 'XMR';
  status: string;
  customer: { slug: string; displayName: string };
  connected: boolean;
  activeConnections: number;
  upstreamName: string | null;
  lastSeenAt: string | null;
  hashrate1m: number;
  hashrate5m: number;
  hashrate15m: number;
  accepted15m: string;
  rejected15m: string;
}

export function WorkersPage() {
  const { t } = useTranslation();
  const [asset, setAsset] = useState('');
  const query = useQuery({
    queryKey: ['workers', asset],
    queryFn: () => api<WorkerStat[]>(`/api/v1/stats/workers${asset ? `?asset=${asset}` : ''}`),
    refetchInterval: 10_000,
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      <PageHeader
        title={t('workers')}
        subtitle="Live normalized work rate and upstream state"
        actions={
          <div className="segmented">
            <button className={!asset ? 'active' : ''} onClick={() => setAsset('')}>
              ALL
            </button>
            <button className={asset === 'BTC' ? 'active' : ''} onClick={() => setAsset('BTC')}>
              BTC
            </button>
            <button className={asset === 'XMR' ? 'active' : ''} onClick={() => setAsset('XMR')}>
              XMR
            </button>
          </div>
        }
      />
      <Card>
        {query.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('workers')}</th>
                  <th>{t('status')}</th>
                  <th>{t('hashrate')} 1m</th>
                  <th>5m</th>
                  <th>15m</th>
                  <th>
                    {t('accepted')} / {t('rejected')}
                  </th>
                  <th>{t('upstream')}</th>
                  <th>{t('lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((worker) => (
                  <tr key={worker.id}>
                    <td>
                      <div className="name-cell">
                        <div className={`coin coin-${worker.asset.toLowerCase()}`}>
                          <Cpu size={16} />
                        </div>
                        <div>
                          <strong dir="ltr">
                            {worker.customer.slug}.{worker.slug}
                          </strong>
                          <span>
                            {worker.customer.displayName} · {worker.asset}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={worker.connected ? 'good' : 'neutral'}>
                        <Activity size={12} />
                        {worker.connected
                          ? `${t('online')} · ${worker.activeConnections}`
                          : t('offline')}
                      </Badge>
                    </td>
                    <td className="mono">{formatHashrate(worker.hashrate1m)}</td>
                    <td className="mono">{formatHashrate(worker.hashrate5m)}</td>
                    <td className="mono">{formatHashrate(worker.hashrate15m)}</td>
                    <td>
                      <span className="good-text">{worker.accepted15m}</span> /{' '}
                      <span className="bad-text">{worker.rejected15m}</span>
                    </td>
                    <td>{worker.upstreamName ?? '—'}</td>
                    <td>
                      {worker.lastSeenAt
                        ? new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          }).format(new Date(worker.lastSeenAt))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty />
        )}
      </Card>
    </>
  );
}
