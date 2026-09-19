import { KeyRound, Plus, UserRoundCog } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, post } from '../api';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';

interface Customer {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  notes?: string;
  createdAt: string;
  _count: { workers: number };
  splitPolicies: Array<{ asset: string; customerBps: number; operatorBps: number }>;
  portalCredential?: { tokenPrefix: string; createdAt: string; revokedAt?: string } | null;
}

interface PortalCredential {
  customerSlug: string;
  accessCode: string;
  portalPath: string;
}

export function CustomersPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [workerCustomer, setWorkerCustomer] = useState<Customer | null>(null);
  const [credential, setCredential] = useState<{ username: string; password: string } | null>(null);
  const [portalCredential, setPortalCredential] = useState<PortalCredential | null>(null);
  const query = useQuery({
    queryKey: ['customers'],
    queryFn: () => api<Customer[]>('/api/v1/customers'),
  });
  const createCustomer = useMutation({
    mutationFn: (body: unknown) => post('/api/v1/customers', body),
    onSuccess: async () => {
      setOpen(false);
      await client.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const createWorker = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      post<{ credentials: { username: string; password: string } }>(
        `/api/v1/customers/${id}/workers`,
        body,
      ),
    onSuccess: async (data) => {
      setWorkerCustomer(null);
      setCredential(data.credentials);
      await client.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const rotatePortal = useMutation({
    mutationFn: (id: string) =>
      post<PortalCredential>(`/api/v1/customers/${id}/portal-access/rotate`, {}),
    onSuccess: async (data) => {
      setPortalCredential(data);
      await client.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      <PageHeader
        title={t('customers')}
        subtitle="Multi-tenant identities, workers and versioned revenue policies"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus size={17} />
            {t('addCustomer')}
          </Button>
        }
      />
      <Card>
        {query.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th>{t('status')}</th>
                  <th>{t('workers')}</th>
                  <th>BTC</th>
                  <th>XMR</th>
                  <th>{t('date')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <div className="name-cell">
                        <div className="avatar small">{customer.displayName.slice(0, 1)}</div>
                        <div>
                          <strong>{customer.displayName}</strong>
                          <span dir="ltr">{customer.slug}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={customer.status === 'ACTIVE' ? 'good' : 'neutral'}>
                        {customer.status}
                      </Badge>
                    </td>
                    <td>{customer._count.workers}</td>
                    <td>{split(customer, 'BTC')}</td>
                    <td>{split(customer, 'XMR')}</td>
                    <td>
                      {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                        new Date(customer.createdAt),
                      )}
                    </td>
                    <td>
                      <Button variant="ghost" onClick={() => setWorkerCustomer(customer)}>
                        <UserRoundCog size={16} />
                        {t('addWorker')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={rotatePortal.isPending}
                        onClick={() => rotatePortal.mutate(customer.id)}
                      >
                        <KeyRound size={16} />
                        {customer.portalCredential
                          ? t('rotatePortalAccess')
                          : t('createPortalAccess')}
                      </Button>
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
      {open && (
        <CustomerForm
          busy={createCustomer.isPending}
          error={createCustomer.error}
          close={() => setOpen(false)}
          submit={(body) => createCustomer.mutate(body)}
        />
      )}
      {workerCustomer && (
        <WorkerForm
          customer={workerCustomer}
          busy={createWorker.isPending}
          error={createWorker.error}
          close={() => setWorkerCustomer(null)}
          submit={(body) => createWorker.mutate({ id: workerCustomer.id, body })}
        />
      )}
      {credential && (
        <Modal title={t('token')} onClose={() => setCredential(null)}>
          <div className="credential-box">
            <KeyRound size={26} />
            <strong>{t('credentialWarning')}</strong>
            <label>
              {t('username')}
              <code dir="ltr">{credential.username}</code>
            </label>
            <label>
              {t('token')}
              <code dir="ltr">{credential.password}</code>
            </label>
            <Button
              onClick={() =>
                void navigator.clipboard.writeText(`${credential.username}\n${credential.password}`)
              }
            >
              {t('copied')}
            </Button>
          </div>
        </Modal>
      )}
      {portalCredential && (
        <Modal title={t('portalAccess')} onClose={() => setPortalCredential(null)}>
          <div className="credential-box">
            <KeyRound size={26} />
            <strong>{t('credentialWarning')}</strong>
            <label>
              {t('portalUrl')}
              <code dir="ltr">{`${window.location.origin}${portalCredential.portalPath}`}</code>
            </label>
            <label>
              {t('customerId')}
              <code dir="ltr">{portalCredential.customerSlug}</code>
            </label>
            <label>
              {t('portalAccessCode')}
              <code dir="ltr">{portalCredential.accessCode}</code>
            </label>
            <Button
              onClick={() =>
                void navigator.clipboard.writeText(
                  `${window.location.origin}${portalCredential.portalPath}\n${portalCredential.customerSlug}\n${portalCredential.accessCode}`,
                )
              }
            >
              {t('copied')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function split(customer: Customer, asset: string): string {
  const policy = customer.splitPolicies.find((item) => item.asset === asset);
  return policy ? `${policy.customerBps / 100}% / ${policy.operatorBps / 100}%` : '—';
}

function CustomerForm({
  close,
  submit,
  busy,
  error,
}: {
  close: () => void;
  submit: (body: unknown) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <Modal title={t('addCustomer')} onClose={close}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit({ displayName: name, slug, notes: notes || undefined });
        }}
      >
        <Field label={t('name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </Field>
        <Field label={t('slug')} hint="lowercase-letters-and-numbers">
          <input
            dir="ltr"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9-]+[a-z0-9]"
            required
          />
        </Field>
        <Field label={t('notes')}>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
        {Boolean(error) && (
          <div className="form-error">{error instanceof Error ? error.message : String(error)}</div>
        )}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function WorkerForm({
  customer,
  close,
  submit,
  busy,
  error,
}: {
  customer: Customer;
  close: () => void;
  submit: (body: unknown) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState('');
  const [asset, setAsset] = useState('BTC');
  const [max, setMax] = useState(1);
  return (
    <Modal title={`${t('addWorker')} · ${customer.displayName}`} onClose={close}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit({ slug, asset, maxConnections: max, allowedIps: [] });
        }}
      >
        <Field label={t('slug')}>
          <input dir="ltr" value={slug} onChange={(e) => setSlug(e.target.value)} required />
        </Field>
        <Field label={t('asset')}>
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option>BTC</option>
            <option>XMR</option>
          </select>
        </Field>
        <Field label="Maximum connections">
          <input
            type="number"
            min={1}
            max={100}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
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
            {t('create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
