import { RefreshCw, Wallet } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, post } from '../api';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  formatAtomic,
  Loading,
  PageHeader,
} from '../components/ui';

interface Deposit {
  id: string;
  asset: 'BTC' | 'XMR';
  txid: string;
  amountAtomic: string;
  confirmations: number;
  locked: boolean;
  status: string;
  observedAt: string;
  upstream: { name: string };
}
interface WalletStatus {
  asset: 'BTC' | 'XMR';
  ok: boolean;
  status?: Record<string, unknown>;
  error?: string;
}

export function WalletsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const deposits = useQuery({
    queryKey: ['deposits'],
    queryFn: () => api<Deposit[]>('/api/v1/wallets/deposits'),
    refetchInterval: 30_000,
  });
  const statuses = useQuery({
    queryKey: ['wallet-status'],
    queryFn: () => api<WalletStatus[]>('/api/v1/wallets/status'),
    refetchInterval: 30_000,
  });
  const scan = useMutation({
    mutationFn: () => post('/api/v1/wallets/scan'),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['deposits'] }),
        client.invalidateQueries({ queryKey: ['wallet-status'] }),
      ]);
    },
  });
  if (deposits.isLoading || statuses.isLoading) return <Loading />;
  if (deposits.error || statuses.error)
    return <ErrorBox error={deposits.error ?? statuses.error} />;
  return (
    <>
      <PageHeader
        title={t('wallets')}
        subtitle="Local node RPC health, confirmed receipts and allocation state"
        actions={
          <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
            <RefreshCw size={16} className={scan.isPending ? 'spin' : ''} />
            {t('scanWallets')}
          </Button>
        }
      />
      <div className="wallet-grid">
        {statuses.data?.map((wallet) => (
          <Card key={wallet.asset} className="wallet-card">
            <div className={`coin coin-${wallet.asset.toLowerCase()}`}>
              <Wallet size={18} />
            </div>
            <div>
              <h2>{wallet.asset}</h2>
              <span>{wallet.ok ? 'RPC connected and responding' : wallet.error}</span>
            </div>
            <Badge tone={wallet.ok ? 'good' : 'bad'}>
              {wallet.ok ? t('online') : t('offline')}
            </Badge>
          </Card>
        ))}
      </div>
      <Card>
        <div className="card-title">
          <h2>{t('recentDeposits')}</h2>
        </div>
        {deposits.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('asset')}</th>
                  <th>{t('upstream')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('confirmations')}</th>
                  <th>{t('state')}</th>
                  <th>{t('txid')}</th>
                  <th>{t('date')}</th>
                </tr>
              </thead>
              <tbody>
                {deposits.data.map((deposit) => (
                  <tr key={deposit.id}>
                    <td>
                      <Badge tone={deposit.asset === 'BTC' ? 'warn' : 'info'}>
                        {deposit.asset}
                      </Badge>
                    </td>
                    <td>{deposit.upstream.name}</td>
                    <td dir="ltr">{formatAtomic(deposit.amountAtomic, deposit.asset)}</td>
                    <td>{deposit.confirmations}</td>
                    <td>
                      <Badge
                        tone={
                          deposit.status === 'ALLOCATED'
                            ? 'good'
                            : deposit.status === 'REORGED'
                              ? 'bad'
                              : 'warn'
                        }
                      >
                        {deposit.status}
                      </Badge>
                    </td>
                    <td className="truncate mono">{deposit.txid}</td>
                    <td>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(deposit.observedAt))}
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
