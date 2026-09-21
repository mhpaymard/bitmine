import { KeyRound, ShieldCheck } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, post, put } from '../api';
import { Button, Card, ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { NetworkProxySettings } from './network-proxy-settings';

interface TotpSetup {
  secret: string;
  uri: string;
}

interface OperatorSetting {
  asset: 'BTC' | 'XMR';
  mode: 'RETAIN' | 'DAILY' | 'WEEKLY' | 'MANUAL';
  address: string;
  minPayoutAtomic: string;
  weekday: number;
  effectiveAt: string;
}
interface PayoutPolicy {
  mode: 'DAILY' | 'INTERVAL';
  intervalMinutes: number;
  minuteOffset: number;
  dailyTime: string;
  timezone: string;
  feePayer: 'CUSTOMER' | 'OPERATOR';
  maxFeeBps: number;
  maxBatchItems: number;
  minimumAtomic: Record<'BTC' | 'XMR', string>;
  dailyAutoLimitAtomic: Record<'BTC' | 'XMR', string>;
}
interface Settings {
  payoutPolicy: PayoutPolicy;
  payoutSchedule: { time: string; timezone: string };
  operatorPayouts: Record<'BTC' | 'XMR', OperatorSetting>;
  pendingOperatorPayouts: Record<'BTC' | 'XMR', OperatorSetting | null>;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/api/v1/settings'),
  });

  const begin = async () => {
    setBusy(true);
    setError(null);
    setBackupCodes([]);
    try {
      setSetup(await post<TotpSetup>('/api/v1/auth/totp/setup'));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ ok: true; backupCodes: string[] }>('/api/v1/auth/totp/enable', {
        code,
      });
      setBackupCodes(result.backupCodes);
      setSetup(null);
      setCode('');
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('settings')} subtitle={t('securitySettingsHelp')} />
      <div className="settings-grid">
        <Card className="settings-card">
          <div className="section-heading">
            <div className="icon-box">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h2>{t('twoFactor')}</h2>
              <p>{t('twoFactorHelp')}</p>
            </div>
          </div>
          {!setup && backupCodes.length === 0 && (
            <Button onClick={() => void begin()} disabled={busy}>
              <KeyRound size={17} />
              {t('setupTwoFactor')}
            </Button>
          )}
          {setup && (
            <div className="security-setup">
              <Field label={t('totpSecret')} hint={t('totpSecretHelp')}>
                <input
                  dir="ltr"
                  readOnly
                  value={setup.secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Field>
              <details>
                <summary>otpauth URI</summary>
                <code className="break-code">{setup.uri}</code>
              </details>
              <Field label={t('totp')}>
                <input
                  dir="ltr"
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  minLength={6}
                  maxLength={6}
                />
              </Field>
              <Button onClick={() => void enable()} disabled={busy || code.length !== 6}>
                {t('enableTwoFactor')}
              </Button>
            </div>
          )}
          {backupCodes.length > 0 && (
            <div className="backup-codes">
              <strong>{t('backupCodes')}</strong>
              <p className="warning-text">{t('backupCodesWarning')}</p>
              <div className="code-grid">
                {backupCodes.map((backupCode) => (
                  <code key={backupCode}>{backupCode}</code>
                ))}
              </div>
            </div>
          )}
          {Boolean(error) && <ErrorBox error={error} />}
        </Card>
        {settings.isLoading ? (
          <Loading />
        ) : settings.error ? (
          <ErrorBox error={settings.error} retry={() => void settings.refetch()} />
        ) : settings.data ? (
          <FinanceSettings settings={settings.data} />
        ) : null}
        <NetworkProxySettings />
      </div>
    </>
  );
}

function FinanceSettings({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const policy = settings.payoutPolicy;
  const [scheduleMode, setScheduleMode] = useState(policy.mode);
  const [intervalMinutes, setIntervalMinutes] = useState(policy.intervalMinutes);
  const [minuteOffset, setMinuteOffset] = useState(policy.minuteOffset);
  const [dailyTime, setDailyTime] = useState(policy.dailyTime);
  const [timezone, setTimezone] = useState(policy.timezone);
  const [feePayer, setFeePayer] = useState(policy.feePayer);
  const [maxFeeBps, setMaxFeeBps] = useState(policy.maxFeeBps);
  const [maxBatchItems, setMaxBatchItems] = useState(policy.maxBatchItems);
  const [bitcoinMinimumAtomic, setBitcoinMinimumAtomic] = useState(policy.minimumAtomic.BTC);
  const [moneroMinimumAtomic, setMoneroMinimumAtomic] = useState(policy.minimumAtomic.XMR);
  const [bitcoinDailyAutoLimitAtomic, setBitcoinDailyAutoLimitAtomic] = useState(
    policy.dailyAutoLimitAtomic.BTC,
  );
  const [moneroDailyAutoLimitAtomic, setMoneroDailyAutoLimitAtomic] = useState(
    policy.dailyAutoLimitAtomic.XMR,
  );
  const update = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => put(path, body),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['settings'] }),
  });
  return (
    <Card className="settings-card">
      <div className="section-heading">
        <div>
          <h2>{t('payoutConfiguration')}</h2>
          <p>{t('payoutConfigurationHelp')}</p>
        </div>
      </div>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({
            path: '/api/v1/settings/payout-schedule',
            body: {
              mode: scheduleMode,
              intervalMinutes,
              minuteOffset,
              dailyTime,
              timezone,
              feePayer,
              maxFeeBps,
              maxBatchItems,
              bitcoinMinimumAtomic,
              moneroMinimumAtomic,
              bitcoinDailyAutoLimitAtomic,
              moneroDailyAutoLimitAtomic,
            },
          });
        }}
      >
        <Field label={t('customerPayoutMode')}>
          <select
            value={scheduleMode}
            onChange={(event) => setScheduleMode(event.target.value as PayoutPolicy['mode'])}
          >
            <option value="DAILY">DAILY</option>
            <option value="INTERVAL">INTERVAL</option>
          </select>
        </Field>
        {scheduleMode === 'DAILY' ? (
          <Field label={t('dailyTime')}>
            <input
              dir="ltr"
              type="time"
              value={dailyTime}
              onChange={(event) => setDailyTime(event.target.value)}
              required
            />
          </Field>
        ) : (
          <>
            <Field label={t('intervalMinutes')}>
              <input
                dir="ltr"
                type="number"
                min={60}
                max={10080}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                required
              />
            </Field>
            <Field label={t('minuteOffset')}>
              <input
                dir="ltr"
                type="number"
                min={0}
                max={59}
                value={minuteOffset}
                onChange={(event) => setMinuteOffset(Number(event.target.value))}
                required
              />
            </Field>
          </>
        )}
        {scheduleMode === 'INTERVAL' && (
          <Field label={t('dailyTime')} hint={t('operatorDailyTimeHelp')}>
            <input
              dir="ltr"
              type="time"
              value={dailyTime}
              onChange={(event) => setDailyTime(event.target.value)}
              required
            />
          </Field>
        )}
        <Field label={t('timezone')}>
          <input
            dir="ltr"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            required
          />
        </Field>
        <Field label={t('feePayer')}>
          <select
            value={feePayer}
            onChange={(event) => setFeePayer(event.target.value as PayoutPolicy['feePayer'])}
          >
            <option value="OPERATOR">OPERATOR</option>
            <option value="CUSTOMER">CUSTOMER</option>
          </select>
        </Field>
        <Field label={t('maxFeeBps')} hint={t('basisPointHelp')}>
          <input
            dir="ltr"
            type="number"
            min={1}
            max={10000}
            value={maxFeeBps}
            onChange={(event) => setMaxFeeBps(Number(event.target.value))}
          />
        </Field>
        <Field label={t('maxBatchItems')}>
          <input
            dir="ltr"
            type="number"
            min={1}
            max={1000}
            value={maxBatchItems}
            onChange={(event) => setMaxBatchItems(Number(event.target.value))}
          />
        </Field>
        <Field label={t('bitcoinMinimumAtomic')}>
          <input
            dir="ltr"
            value={bitcoinMinimumAtomic}
            onChange={(event) => setBitcoinMinimumAtomic(event.target.value)}
            pattern="\d+"
          />
        </Field>
        <Field label={t('moneroMinimumAtomic')}>
          <input
            dir="ltr"
            value={moneroMinimumAtomic}
            onChange={(event) => setMoneroMinimumAtomic(event.target.value)}
            pattern="\d+"
          />
        </Field>
        <Field label={t('bitcoinDailyAutoLimitAtomic')}>
          <input
            dir="ltr"
            value={bitcoinDailyAutoLimitAtomic}
            onChange={(event) => setBitcoinDailyAutoLimitAtomic(event.target.value)}
            pattern="\d+"
          />
        </Field>
        <Field label={t('moneroDailyAutoLimitAtomic')}>
          <input
            dir="ltr"
            value={moneroDailyAutoLimitAtomic}
            onChange={(event) => setMoneroDailyAutoLimitAtomic(event.target.value)}
            pattern="\d+"
          />
        </Field>
        <div>
          <Button type="submit" disabled={update.isPending}>
            {t('save')}
          </Button>
        </div>
      </form>
      <div className="operator-settings">
        <OperatorForm
          asset="BTC"
          setting={settings.operatorPayouts.BTC}
          pending={settings.pendingOperatorPayouts.BTC}
          submit={(body) => update.mutate({ path: '/api/v1/settings/operator-payout', body })}
          busy={update.isPending}
        />
        <OperatorForm
          asset="XMR"
          setting={settings.operatorPayouts.XMR}
          pending={settings.pendingOperatorPayouts.XMR}
          submit={(body) => update.mutate({ path: '/api/v1/settings/operator-payout', body })}
          busy={update.isPending}
        />
      </div>
      {Boolean(update.error) && <ErrorBox error={update.error} />}
    </Card>
  );
}

function OperatorForm({
  asset,
  setting,
  pending,
  submit,
  busy,
}: {
  asset: 'BTC' | 'XMR';
  setting: OperatorSetting;
  pending: OperatorSetting | null;
  submit: (body: unknown) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(setting.mode);
  const [address, setAddress] = useState(setting.address);
  const [minimum, setMinimum] = useState(setting.minPayoutAtomic);
  const [weekday, setWeekday] = useState(setting.weekday);
  const save = (event: FormEvent) => {
    event.preventDefault();
    submit({ asset, mode, address: address || undefined, minPayoutAtomic: minimum, weekday });
  };
  return (
    <form className="operator-form" onSubmit={save}>
      <h3>
        {asset} · {t('operatorPayout')}
      </h3>
      {pending && (
        <p className="warning-text">
          {t('pendingCooling')}:{' '}
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
            new Date(pending.effectiveAt),
          )}
        </p>
      )}
      <Field label={t('mode')}>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as OperatorSetting['mode'])}
        >
          <option value="RETAIN">RETAIN</option>
          <option value="MANUAL">MANUAL</option>
          <option value="DAILY">DAILY</option>
          <option value="WEEKLY">WEEKLY</option>
        </select>
      </Field>
      <Field label={t('receiveAddress')}>
        <input
          dir="ltr"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          disabled={mode === 'RETAIN'}
        />
      </Field>
      <Field label={t('minimumAtomic')}>
        <input
          dir="ltr"
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
          pattern="\d+"
        />
      </Field>
      {mode === 'WEEKLY' && (
        <Field label={t('weekday')}>
          <input
            type="number"
            min={1}
            max={7}
            value={weekday}
            onChange={(event) => setWeekday(Number(event.target.value))}
          />
        </Field>
      )}
      <Button type="submit" disabled={busy}>
        {t('save')}
      </Button>
    </form>
  );
}
