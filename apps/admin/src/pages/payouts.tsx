import { CheckCheck, Play, Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, post } from '../api';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  formatAtomic,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';

interface Payout {
  id: string;
  asset: 'BTC' | 'XMR';
  kind: 'CUSTOMER' | 'OPERATOR';
  state: string;
  totalGrossAtomic: string;
  totalFeeAtomic: string;
  totalNetAtomic: string;
  transactionIds: string[];
  scheduledFor: string;
  errorMessage?: string;
  items: Array<{
    id: string;
    destination: string;
    grossAtomic: string;
    netAtomic: string;
    customer?: { displayName: string };
  }>;
}

export function PayoutsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [approveId, setApproveId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['payouts'],
    queryFn: () => api<Payout[]>('/api/v1/payouts'),
    refetchInterval: 15_000,
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onSuccess: async () => {
      setApproveId(null);
      await client.invalidateQueries({ queryKey: ['payouts'] });
    },
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      <PageHeader
        title={t('payouts')}
        subtitle={t('securityNote')}
        actions={
          <div className="button-row">
            <Button
              variant="secondary"
              onClick={() =>
                action.mutate({ path: '/api/v1/payouts/plan', body: { asset: 'BTC' } })
              }
            >
              <Plus size={16} />
              BTC
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                action.mutate({ path: '/api/v1/payouts/plan', body: { asset: 'XMR' } })
              }
            >
              <Plus size={16} />
              XMR
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                action.mutate({ path: '/api/v1/payouts/operator/plan', body: { asset: 'BTC' } })
              }
            >
              {t('operatorPayout')} BTC
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                action.mutate({ path: '/api/v1/payouts/operator/plan', body: { asset: 'XMR' } })
              }
            >
              {t('operatorPayout')} XMR
            </Button>
          </div>
        }
      />
      {action.error && <ErrorBox error={action.error} />}
      <Card>
        {query.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('asset')}</th>
                  <th>{t('type')}</th>
                  <th>{t('state')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('fee')}</th>
                  <th>{t('date')}</th>
                  <th>{t('txid')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <Badge tone={batch.asset === 'BTC' ? 'warn' : 'info'}>{batch.asset}</Badge>
                    </td>
                    <td>{batch.kind}</td>
                    <td>
                      <Badge tone={tone(batch.state)}>{batch.state}</Badge>
                      {batch.errorMessage && (
                        <small className="bad-text block">{batch.errorMessage}</small>
                      )}
                    </td>
                    <td dir="ltr">{formatAtomic(batch.totalGrossAtomic, batch.asset)}</td>
                    <td dir="ltr">{formatAtomic(batch.totalFeeAtomic, batch.asset)}</td>
                    <td>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(batch.scheduledFor))}
                    </td>
                    <td className="truncate mono">{batch.transactionIds.join(', ') || '—'}</td>
                    <td>
                      <div className="button-row">
                        {batch.state === 'APPROVAL_REQUIRED' && (
                          <Button variant="ghost" onClick={() => setApproveId(batch.id)}>
                            <CheckCheck size={15} />
                            {t('approve')}
                          </Button>
                        )}
                        {['AUTO_APPROVED', 'SIGNED', 'FAILED'].includes(batch.state) && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              action.mutate({ path: `/api/v1/payouts/${batch.id}/execute` })
                            }
                          >
                            <Play size={15} />
                            {t('execute')}
                          </Button>
                        )}
                      </div>
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
      {approveId && (
        <ApproveModal
          close={() => setApproveId(null)}
          submit={(totpCode) =>
            action.mutate({ path: `/api/v1/payouts/${approveId}/approve`, body: { totpCode } })
          }
          busy={action.isPending}
          error={action.error}
        />
      )}
    </>
  );
}

function tone(state: string): 'good' | 'warn' | 'bad' | 'neutral' | 'info' {
  if (state === 'CONFIRMED') return 'good';
  if (state === 'FAILED') return 'bad';
  if (state === 'BROADCAST' || state === 'SIGNED') return 'info';
  if (state === 'APPROVAL_REQUIRED') return 'warn';
  return 'neutral';
}
function ApproveModal({
  close,
  submit,
  busy,
  error,
}: {
  close: () => void;
  submit: (code: string) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  return (
    <Modal title={t('approve')} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(code);
        }}
      >
        <Field label={t('totp')}>
          <input
            dir="ltr"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            minLength={6}
            maxLength={6}
            required
          />
        </Field>
        {Boolean(error) && (
          <div className="form-error">{error instanceof Error ? error.message : String(error)}</div>
        )}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('approve')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
