import { FlaskConical, Plus, Server } from 'lucide-react';
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

interface Upstream {
  id: string;
  accountKey: string;
  asset: 'BTC' | 'XMR';
  protocol: string;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  priority: number;
  enabled: boolean;
  usernameTemplate: string;
  receiveAddress?: string;
  lastHealthOk?: boolean;
  lastHealthMessage?: string;
}

export function UpstreamsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['upstreams'],
    queryFn: () => api<Upstream[]>('/api/v1/upstreams'),
  });
  const create = useMutation({
    mutationFn: (body: unknown) => post('/api/v1/upstreams', body),
    onSuccess: async () => {
      setOpen(false);
      await client.invalidateQueries({ queryKey: ['upstreams'] });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      post<{ ok: boolean; message: string; latencyMs: number }>(`/api/v1/upstreams/${id}/test`),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['upstreams'] }),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      <PageHeader
        title={t('upstreams')}
        subtitle="Priority-ordered public pool endpoints with failover cooldown"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus size={17} />
            {t('addUpstream')}
          </Button>
        }
      />
      <div className="pool-grid">
        {query.data?.length ? (
          query.data.map((pool) => (
            <Card key={pool.id} className="pool-card">
              <div className="pool-heading">
                <div className={`coin coin-${pool.asset.toLowerCase()}`}>
                  <Server size={17} />
                </div>
                <div>
                  <dt>Pool account</dt>
                  <dd dir="ltr">{pool.accountKey}</dd>
                </div>
                <div>
                  <h2>{pool.name}</h2>
                  <span>
                    {pool.asset} · {pool.protocol}
                  </span>
                </div>
                <Badge
                  tone={
                    pool.lastHealthOk === true
                      ? 'good'
                      : pool.lastHealthOk === false
                        ? 'bad'
                        : 'neutral'
                  }
                >
                  {pool.lastHealthOk === true
                    ? t('online')
                    : pool.lastHealthOk === false
                      ? t('offline')
                      : 'NEW'}
                </Badge>
              </div>
              <dl>
                <div>
                  <dt>{t('host')}</dt>
                  <dd dir="ltr">
                    {pool.tls ? 'tls://' : 'tcp://'}
                    {pool.host}:{pool.port}
                  </dd>
                </div>
                <div>
                  <dt>{t('priority')}</dt>
                  <dd>{pool.priority}</dd>
                </div>
                <div>
                  <dt>{t('username')}</dt>
                  <dd dir="ltr">{pool.usernameTemplate}</dd>
                </div>
                <div>
                  <dt>{t('receiveAddress')}</dt>
                  <dd className="truncate" dir="ltr">
                    {pool.receiveAddress ?? '—'}
                  </dd>
                </div>
              </dl>
              {pool.lastHealthMessage && <p className="pool-message">{pool.lastHealthMessage}</p>}
              <Button
                variant="secondary"
                onClick={() => test.mutate(pool.id)}
                disabled={test.isPending}
              >
                <FlaskConical size={16} />
                {t('test')}
              </Button>
            </Card>
          ))
        ) : (
          <Card>
            <Empty />
          </Card>
        )}
      </div>
      {open && (
        <UpstreamForm
          close={() => setOpen(false)}
          submit={(body) => create.mutate(body)}
          busy={create.isPending}
          error={create.error}
        />
      )}
    </>
  );
}

function UpstreamForm({
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
  const [asset, setAsset] = useState('BTC');
  const [accountKey, setAccountKey] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(3333);
  const [tls, setTls] = useState(false);
  const [priority, setPriority] = useState(100);
  const [template, setTemplate] = useState('{customer}.{worker}');
  const [password, setPassword] = useState('x');
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<unknown>(null);
  const [generating, setGenerating] = useState(false);
  const generateAddress = async () => {
    setGenerating(true);
    setAddressError(null);
    try {
      const result = await post<{ address: string }>('/api/v1/wallets/receive-address', {
        asset,
        label: `upstream:${name || 'new'}`,
      });
      setAddress(result.address);
    } catch (reason) {
      setAddressError(reason);
    } finally {
      setGenerating(false);
    }
  };
  return (
    <Modal title={t('addUpstream')} onClose={close}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit({
            asset,
            accountKey: accountKey || undefined,
            protocol: asset === 'BTC' ? 'BITCOIN_STRATUM_V1' : 'MONERO_JSON_RPC',
            name,
            host,
            port,
            tls,
            priority,
            usernameTemplate: template,
            password,
            receiveAddress: address || undefined,
          });
        }}
      >
        <div className="form-grid">
          <Field label={t('asset')}>
            <select
              value={asset}
              onChange={(e) => {
                setAsset(e.target.value);
                setPort(3333);
                setAddress('');
              }}
            >
              <option>BTC</option>
              <option>XMR</option>
            </select>
          </Field>
          <Field label={t('name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label={t('host')}>
            <input dir="ltr" value={host} onChange={(e) => setHost(e.target.value)} required />
          </Field>
          <Field label={t('port')}>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              min={1}
              max={65535}
              required
            />
          </Field>
          <Field label={t('priority')}>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <Field label="TLS">
            <select value={tls ? 'yes' : 'no'} onChange={(e) => setTls(e.target.value === 'yes')}>
              <option value="no">TCP</option>
              <option value="yes">TLS</option>
            </select>
          </Field>
        </div>
        <Field label="Username template">
          <input dir="ltr" value={template} onChange={(e) => setTemplate(e.target.value)} />
        </Field>
        <Field
          label="Pool account key"
          hint="Use the same key for every failover endpoint of one pool account"
        >
          <input
            dir="ltr"
            value={accountKey}
            onChange={(e) => setAccountKey(e.target.value.toLowerCase())}
            placeholder="viabtc-main"
          />
        </Field>
        <Field label="Upstream password">
          <input dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={t('receiveAddress')}>
          <div className="input-action">
            <input dir="ltr" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button
              type="button"
              variant="secondary"
              onClick={() => void generateAddress()}
              disabled={generating}
            >
              {t('generateAddress')}
            </Button>
          </div>
        </Field>
        {Boolean(addressError) && (
          <div className="form-error">
            {addressError instanceof Error ? addressError.message : String(addressError)}
          </div>
        )}
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
