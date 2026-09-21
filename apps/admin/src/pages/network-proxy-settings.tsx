import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, put } from '../api';
import { Badge, Button, Card, ErrorBox, Field, Loading } from '../components/ui';

type ProxyMode = 'ALWAYS_ON' | 'FAILOVER';
type ProxyProtocol = 'SOCKS5' | 'HTTP';
type VpnConfigType = 'NONE' | 'OPENVPN' | 'WIREGUARD';

interface ProxySettings {
  enabled: boolean;
  mode: ProxyMode;
  applyToGateway: boolean;
  applyToSystem: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  healthCheckHost: string;
  healthCheckPort: number;
  healthCheckIntervalSeconds: number;
  healthCheckFailureThreshold: number;
  vpnConfigType: VpnConfigType;
  hasVpnConfig: boolean;
}

interface ProxyStatus {
  directUp: boolean;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
}

interface ProxyResponse {
  settings: ProxySettings;
  status: ProxyStatus;
}

export function NetworkProxySettings() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['network-proxy'],
    queryFn: () => api<ProxyResponse>('/api/v1/network/proxy'),
  });
  return (
    <Card className="settings-card">
      <div className="section-heading">
        <div>
          <h2>{t('networkProxy')}</h2>
          <p>{t('networkProxyHelp')}</p>
        </div>
      </div>
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <NetworkProxyForm data={query.data} />
      ) : null}
    </Card>
  );
}

function NetworkProxyForm({ data }: { data: ProxyResponse }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { settings, status } = data;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [mode, setMode] = useState<ProxyMode>(settings.mode);
  const [applyToGateway, setApplyToGateway] = useState(settings.applyToGateway);
  const [applyToSystem, setApplyToSystem] = useState(settings.applyToSystem);
  const [protocol, setProtocol] = useState<ProxyProtocol>(settings.protocol);
  const [host, setHost] = useState(settings.host);
  const [port, setPort] = useState(settings.port);
  const [username, setUsername] = useState(settings.username ?? '');
  const [password, setPassword] = useState('');
  const [healthCheckHost, setHealthCheckHost] = useState(settings.healthCheckHost);
  const [healthCheckPort, setHealthCheckPort] = useState(settings.healthCheckPort);
  const [healthCheckIntervalSeconds, setHealthCheckIntervalSeconds] = useState(
    settings.healthCheckIntervalSeconds,
  );
  const [healthCheckFailureThreshold, setHealthCheckFailureThreshold] = useState(
    settings.healthCheckFailureThreshold,
  );
  const [vpnConfigType, setVpnConfigType] = useState<VpnConfigType>(settings.vpnConfigType);
  const [vpnConfig, setVpnConfig] = useState('');

  const update = useMutation({
    mutationFn: (body: unknown) => put('/api/v1/network/proxy', body),
    onSuccess: async () => {
      setPassword('');
      setVpnConfig('');
      await client.invalidateQueries({ queryKey: ['network-proxy'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({
      enabled,
      mode,
      applyToGateway,
      applyToSystem,
      protocol,
      host,
      port,
      username: username || undefined,
      password: password || undefined,
      healthCheckHost,
      healthCheckPort,
      healthCheckIntervalSeconds,
      healthCheckFailureThreshold,
      vpnConfigType,
      vpnConfig: vpnConfig || undefined,
    });
  };

  return (
    <form className="form-grid" onSubmit={submit}>
      <Field label={t('proxyStatus')}>
        <div>
          <Badge tone={status.directUp ? 'good' : 'warn'}>
            {status.directUp ? t('proxyStatusDirect') : t('proxyStatusProxy')}
          </Badge>
          {status.lastCheckedAt && (
            <small>
              {' '}
              {t('proxyLastChecked')}:{' '}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'short',
                timeStyle: 'medium',
              }).format(new Date(status.lastCheckedAt))}
            </small>
          )}
        </div>
      </Field>
      <Field label={t('proxyEnabled')}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </Field>
      <Field label={t('proxyMode')}>
        <select value={mode} onChange={(event) => setMode(event.target.value as ProxyMode)}>
          <option value="FAILOVER">{t('proxyModeFailover')}</option>
          <option value="ALWAYS_ON">{t('proxyModeAlwaysOn')}</option>
        </select>
      </Field>
      <Field label={t('proxyApplyToGateway')}>
        <input
          type="checkbox"
          checked={applyToGateway}
          onChange={(event) => setApplyToGateway(event.target.checked)}
        />
      </Field>
      <Field label={t('proxyApplyToSystem')}>
        <input
          type="checkbox"
          checked={applyToSystem}
          onChange={(event) => setApplyToSystem(event.target.checked)}
        />
      </Field>
      <Field label={t('proxyProtocol')}>
        <select
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as ProxyProtocol)}
        >
          <option value="SOCKS5">SOCKS5</option>
          <option value="HTTP">HTTP</option>
        </select>
      </Field>
      <Field label={t('proxyHost')}>
        <input
          dir="ltr"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="127.0.0.1"
        />
      </Field>
      <Field label={t('proxyPort')}>
        <input
          dir="ltr"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(Number(event.target.value))}
        />
      </Field>
      <Field label={t('proxyUsername')}>
        <input dir="ltr" value={username} onChange={(event) => setUsername(event.target.value)} />
      </Field>
      <Field
        label={t('proxyPassword')}
        hint={settings.hasPassword ? t('proxyPasswordSetHint') : undefined}
      >
        <input
          dir="ltr"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <fieldset className="form-grid-section">
        <legend>{t('proxyHealthCheck')}</legend>
        <Field label={t('proxyHealthCheckHost')}>
          <input
            dir="ltr"
            value={healthCheckHost}
            onChange={(event) => setHealthCheckHost(event.target.value)}
          />
        </Field>
        <Field label={t('proxyHealthCheckPort')}>
          <input
            dir="ltr"
            type="number"
            min={1}
            max={65535}
            value={healthCheckPort}
            onChange={(event) => setHealthCheckPort(Number(event.target.value))}
          />
        </Field>
        <Field label={t('proxyHealthCheckInterval')}>
          <input
            dir="ltr"
            type="number"
            min={5}
            max={600}
            value={healthCheckIntervalSeconds}
            onChange={(event) => setHealthCheckIntervalSeconds(Number(event.target.value))}
          />
        </Field>
        <Field label={t('proxyHealthCheckThreshold')}>
          <input
            dir="ltr"
            type="number"
            min={1}
            max={20}
            value={healthCheckFailureThreshold}
            onChange={(event) => setHealthCheckFailureThreshold(Number(event.target.value))}
          />
        </Field>
      </fieldset>
      <fieldset className="form-grid-section">
        <legend>{t('proxyVpnConfig')}</legend>
        <Field label={t('proxyVpnType')}>
          <select
            value={vpnConfigType}
            onChange={(event) => setVpnConfigType(event.target.value as VpnConfigType)}
          >
            <option value="NONE">{t('proxyVpnNone')}</option>
            <option value="OPENVPN">OpenVPN</option>
            <option value="WIREGUARD">WireGuard</option>
          </select>
        </Field>
        {vpnConfigType !== 'NONE' && (
          <Field
            label={t('proxyVpnConfigFile')}
            hint={settings.hasVpnConfig ? t('proxyVpnConfigSetHint') : undefined}
          >
            <textarea
              dir="ltr"
              rows={6}
              value={vpnConfig}
              onChange={(event) => setVpnConfig(event.target.value)}
            />
          </Field>
        )}
      </fieldset>
      <div>
        <Button type="submit" disabled={update.isPending}>
          {t('save')}
        </Button>
      </div>
      {update.isSuccess && <Badge tone="good">{t('proxySaved')}</Badge>}
      {Boolean(update.error) && <ErrorBox error={update.error} />}
    </form>
  );
}
