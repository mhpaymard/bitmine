import { Activity, Clock3, KeyRound, LogOut, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../api';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  formatAtomic,
  formatHashrate,
  Loading,
} from '../components/ui';

type Asset = 'BTC' | 'XMR';

interface PortalSummary {
  customer: { slug: string; displayName: string; timezone: string };
  payoutSchedule: {
    mode: 'DAILY' | 'INTERVAL';
    intervalMinutes: number;
    dailyTime: string;
    timezone: string;
    nextAt: string;
    nextLocalAt: string;
    feePayer: 'CUSTOMER' | 'OPERATOR';
  };
  workers: Array<{
    id: string;
    slug: string;
    asset: Asset;
    status: string;
    connected: boolean;
    activeConnections: number;
    lastSeenAt?: string;
    hashrate1m: number;
    hashrate5m: number;
    hashrate15m: number;
    accepted24h: number;
    rejected24h: number;
  }>;
  balances: Array<{
    asset: Asset;
    confirmedAtomic: string;
    reservedAtomic: string;
    payableAtomic: string;
    pendingAcceptedShares: string;
    minimumAtomic: string;
    eligibleAtNextRun: boolean;
    autoApprovalConfigured: boolean;
    activeDestination: Destination | null;
    pendingDestination: Destination | null;
  }>;
  earnings: Array<{
    asset: Asset;
    earnedTrailing24hAtomic: string;
    earnedTrailing7dAtomic: string;
    projectedNext24hAtomic: string;
  }>;
  payouts: Array<{
    id: string;
    netAtomic: string;
    destination: string;
    batch: {
      asset: Asset;
      state: string;
      createdAt: string;
      confirmedAt?: string;
      transactionIds: string[];
    };
  }>;
}

interface Destination {
  id: string;
  asset: Asset;
  address: string;
  status: string;
  effectiveAt: string;
  minPayoutAtomic: string;
}

interface Credentials {
  customerSlug: string;
  accessCode: string;
}

export function PortalPage() {
  const { t, i18n } = useTranslation();
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [summary, setSummary] = useState<PortalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    document.documentElement.lang = i18n.language;
    document.documentElement.dir = i18n.language === 'fa' ? 'rtl' : 'ltr';
  }, [i18n.language]);

  const load = async (nextCredentials: Credentials) => {
    setLoading(true);
    setError(undefined);
    try {
      const data = await post<PortalSummary>('/api/v1/public/portal/summary', nextCredentials);
      setCredentials(nextCredentials);
      setSummary(data);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  };

  if (!summary || !credentials) {
    return (
      <div className="portal-shell portal-login">
        <Card className="portal-login-card">
          <div className="portal-mark">
            <KeyRound size={28} />
          </div>
          <h1>{t('portalTitle')}</h1>
          <p className="muted">{t('portalLoginHelp')}</p>
          <PortalLogin busy={loading} error={error} submit={(value) => void load(value)} />
        </Card>
      </div>
    );
  }

  return (
    <div className="portal-shell">
      <header className="portal-topbar">
        <div>
          <span>{t('portalTitle')}</span>
          <h1>{summary.customer.displayName}</h1>
        </div>
        <div className="portal-actions">
          <Button
            variant="ghost"
            onClick={() => {
              const next = i18n.language === 'fa' ? 'en' : 'fa';
              localStorage.setItem('language', next);
              void i18n.changeLanguage(next);
            }}
          >
            {t('language')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setCredentials(null);
              setSummary(null);
            }}
          >
            <LogOut size={16} />
            {t('portalExit')}
          </Button>
        </div>
      </header>

      <div className="portal-grid">
        <Card className="portal-schedule">
          <Clock3 size={24} />
          <div>
            <span>{t('nextPayoutRun')}</span>
            <strong>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(summary.payoutSchedule.nextAt))}
            </strong>
            <small>
              <Countdown target={summary.payoutSchedule.nextAt} /> ·{' '}
              {summary.payoutSchedule.mode === 'INTERVAL'
                ? `${summary.payoutSchedule.intervalMinutes / 60}h interval`
                : `${summary.payoutSchedule.dailyTime} daily`}
            </small>
          </div>
        </Card>
        {summary.balances.map((balance) => {
          const earning = summary.earnings.find((item) => item.asset === balance.asset);
          return (
            <Card key={balance.asset} className="portal-balance">
              <div className="portal-card-title">
                <WalletCards size={20} />
                <h2>{balance.asset}</h2>
                <Badge tone={balance.eligibleAtNextRun ? 'good' : 'warn'}>
                  {balance.eligibleAtNextRun ? t('payoutEligible') : t('payoutNotEligible')}
                </Badge>
              </div>
              <div className="portal-amount">
                <span>{t('payableBalance')}</span>
                <strong>{formatAtomic(balance.payableAtomic, balance.asset)}</strong>
              </div>
              <dl className="portal-details">
                <div>
                  <dt>{t('confirmedBalance')}</dt>
                  <dd>{formatAtomic(balance.confirmedAtomic, balance.asset)}</dd>
                </div>
                <div>
                  <dt>{t('minimumAtomic')}</dt>
                  <dd>{formatAtomic(balance.minimumAtomic, balance.asset)}</dd>
                </div>
                <div>
                  <dt>{t('estimated24h')}</dt>
                  <dd>{formatAtomic(earning?.projectedNext24hAtomic ?? '0', balance.asset)}</dd>
                </div>
                <div>
                  <dt>{t('pendingShares')}</dt>
                  <dd>{balance.pendingAcceptedShares}</dd>
                </div>
              </dl>
              <p className="muted portal-address">
                {balance.activeDestination
                  ? `${t('activeWallet')}: ${balance.activeDestination.address}`
                  : t('noActiveWallet')}
              </p>
              {balance.pendingDestination && (
                <p className="portal-pending">
                  {t('pendingWallet')}: {balance.pendingDestination.address} ·{' '}
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(balance.pendingDestination.effectiveAt))}
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <Card>
        <div className="portal-card-title">
          <Activity size={20} />
          <h2>{t('workers')}</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('status')}</th>
                <th>{t('hashrate')} 1m</th>
                <th>{t('hashrate')} 5m</th>
                <th>{t('hashrate')} 15m</th>
                <th>{t('accepted24h')}</th>
                <th>{t('rejected')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.workers.map((worker) => (
                <tr key={worker.id}>
                  <td dir="ltr">{worker.slug}</td>
                  <td>
                    <Badge tone={worker.connected ? 'good' : 'neutral'}>
                      {worker.connected ? t('online') : t('offline')}
                    </Badge>
                  </td>
                  <td>{formatHashrate(worker.hashrate1m)}</td>
                  <td>{formatHashrate(worker.hashrate5m)}</td>
                  <td>{formatHashrate(worker.hashrate15m)}</td>
                  <td>{worker.accepted24h}</td>
                  <td>{worker.rejected24h}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="portal-grid portal-lower-grid">
        <Card>
          <h2>{t('walletRequest')}</h2>
          <p className="muted">{t('walletRequestHelp')}</p>
          <DestinationForm credentials={credentials} onSaved={() => void load(credentials)} />
        </Card>
        <Card>
          <h2>{t('recentPayouts')}</h2>
          {summary.payouts.length ? (
            <div className="portal-payout-list">
              {summary.payouts.map((payout) => (
                <div key={payout.id}>
                  <Badge tone={payout.batch.state === 'CONFIRMED' ? 'good' : 'info'}>
                    {payout.batch.state}
                  </Badge>
                  <strong>{formatAtomic(payout.netAtomic, payout.batch.asset)}</strong>
                  <span>{payout.destination}</span>
                  <small>{new Date(payout.batch.createdAt).toLocaleString()}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{t('noData')}</p>
          )}
        </Card>
      </div>

      <p className="portal-notice">{t('estimateNotice')}</p>
    </div>
  );
}

function PortalLogin({
  busy,
  error,
  submit,
}: {
  busy: boolean;
  error: unknown;
  submit: (value: Credentials) => void;
}) {
  const { t } = useTranslation();
  const [customerSlug, setCustomerSlug] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const send = (event: FormEvent) => {
    event.preventDefault();
    submit({ customerSlug: customerSlug.trim(), accessCode });
  };
  return (
    <form className="modal-form" onSubmit={send}>
      <Field label={t('customerId')}>
        <input
          dir="ltr"
          value={customerSlug}
          onChange={(event) => setCustomerSlug(event.target.value)}
          required
        />
      </Field>
      <Field label={t('portalAccessCode')}>
        <input
          type="password"
          dir="ltr"
          value={accessCode}
          onChange={(event) => setAccessCode(event.target.value)}
          required
        />
      </Field>
      {error !== undefined && <ErrorBox error={error} />}
      {busy ? <Loading /> : <Button type="submit">{t('portalEnter')}</Button>}
    </form>
  );
}

function DestinationForm({
  credentials,
  onSaved,
}: {
  credentials: Credentials;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [asset, setAsset] = useState<Asset>('BTC');
  const [address, setAddress] = useState('');
  const [minimum, setMinimum] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await post('/api/v1/public/portal/payout-destinations', {
        ...credentials,
        asset,
        address,
        ...(minimum ? { minPayoutAtomic: minimum } : {}),
      });
      setAddress('');
      setMinimum('');
      setSaved(true);
      onSaved();
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="modal-form" onSubmit={(event) => void submit(event)}>
      <Field label={t('asset')}>
        <select value={asset} onChange={(event) => setAsset(event.target.value as Asset)}>
          <option value="BTC">BTC</option>
          <option value="XMR">XMR</option>
        </select>
      </Field>
      <Field label={t('walletAddress')}>
        <input
          dir="ltr"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          required
        />
      </Field>
      <Field label={t('minimumAtomic')} hint={t('minimumOptional')}>
        <input
          dir="ltr"
          inputMode="numeric"
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
          pattern="[0-9]*"
        />
      </Field>
      {error !== undefined && <ErrorBox error={error} />}
      {saved && <p className="portal-success">{t('walletRequestSaved')}</p>}
      <Button type="submit" disabled={busy}>
        {busy ? t('loading') : t('save')}
      </Button>
    </form>
  );
}

function Countdown({ target }: { target: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const value = useMemo(() => {
    const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainder = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  }, [now, target]);
  return `${t('remaining')}: ${value}`;
}
