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

export function LedgerPage() {
  const { t } = useTranslation();
  const [asset, setAsset] = useState('');
  const query = useQuery({
    queryKey: ['ledger', asset],
    queryFn: () => api<Journal[]>(`/api/v1/ledger/transactions${asset ? `?asset=${asset}` : ''}`),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
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
