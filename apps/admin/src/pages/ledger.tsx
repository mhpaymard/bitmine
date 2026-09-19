import { BookOpenCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox, formatAtomic, Loading, PageHeader } from '../components/ui';

interface Journal {
  id: string;
  asset: 'BTC' | 'XMR';
  type: string;
  referenceType: string;
  referenceId: string;
  description: string;
  occurredAt: string;
  entries: Array<{
    id: string;
    direction: string;
    amountAtomic: string;
    account: { code: string; name: string };
  }>;
}

interface CustomerBalance {
  customer: { id: string; slug: string; displayName: string };
  asset: 'BTC' | 'XMR';
  confirmedAtomic: string;
  reservedAtomic: string;
  payableAtomic: string;
  pendingAcceptedShares: string;
  pendingAcceptedWork: string;
}

export function LedgerPage() {
  const { t } = useTranslation();
  const [asset, setAsset] = useState('');
  const query = useQuery({
    queryKey: ['ledger', asset],
    queryFn: () => api<Journal[]>(`/api/v1/ledger/transactions${asset ? `?asset=${asset}` : ''}`),
  });
  const balances = useQuery({
    queryKey: ['customer-balances', asset],
    queryFn: () =>
      api<CustomerBalance[]>(`/api/v1/ledger/customer-balances${asset ? `?asset=${asset}` : ''}`),
  });
  if (query.isLoading || balances.isLoading) return <Loading />;
  if (query.error || balances.error)
    return (
      <ErrorBox
        error={query.error ?? balances.error}
        retry={() => {
          void query.refetch();
          void balances.refetch();
        }}
      />
    );
  return (
    <>
      <PageHeader
        title={t('ledger')}
        subtitle="Append-only double-entry journal; atomic units only"
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
        <div className="section-heading">
          <div>
            <h2>{t('customerBalances')}</h2>
            <p>{t('customerBalancesHelp')}</p>
          </div>
        </div>
        {balances.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('customers')}</th>
                  <th>{t('asset')}</th>
                  <th>{t('confirmedBalance')}</th>
                  <th>{t('reservedBalance')}</th>
                  <th>{t('payableBalance')}</th>
                  <th>{t('pendingShares')}</th>
                </tr>
              </thead>
              <tbody>
                {balances.data.map((balance) => (
                  <tr key={`${balance.customer.id}:${balance.asset}`}>
                    <td>
                      <div className="name-cell">
                        <div>
                          <strong>{balance.customer.displayName}</strong>
                          <span dir="ltr">{balance.customer.slug}</span>
                        </div>
                      </div>
                    </td>
                    <td>{balance.asset}</td>
                    <td dir="ltr">{formatAtomic(balance.confirmedAtomic, balance.asset)}</td>
                    <td dir="ltr">{formatAtomic(balance.reservedAtomic, balance.asset)}</td>
                    <td dir="ltr">{formatAtomic(balance.payableAtomic, balance.asset)}</td>
                    <td dir="ltr" title={`work=${balance.pendingAcceptedWork}`}>
                      {balance.pendingAcceptedShares}
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
      <Card>
        {query.data?.length ? (
          <div className="journal-list">
            {query.data.map((journal) => (
              <details key={journal.id}>
                <summary>
                  <div className={`coin coin-${journal.asset.toLowerCase()}`}>
                    <BookOpenCheck size={16} />
                  </div>
                  <div>
                    <strong>{journal.description}</strong>
                    <span>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(journal.occurredAt))}{' '}
                      · {journal.referenceType}
                    </span>
                  </div>
                  <Badge
                    tone={
                      journal.type === 'DEPOSIT'
                        ? 'good'
                        : journal.type === 'PAYOUT'
                          ? 'warn'
                          : 'info'
                    }
                  >
                    {journal.type}
                  </Badge>
                </summary>
                <div className="journal-entries">
                  {journal.entries.map((entry) => (
                    <div key={entry.id}>
                      <span>
                        {entry.account.name}
                        <small>{entry.account.code}</small>
                      </span>
                      <Badge tone={entry.direction === 'DEBIT' ? 'info' : 'neutral'}>
                        {entry.direction}
                      </Badge>
                      <strong dir="ltr">{formatAtomic(entry.amountAtomic, journal.asset)}</strong>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Empty />
        )}
      </Card>
    </>
  );
}
