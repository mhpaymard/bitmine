import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button, Field } from '../components/ui';

export function LoginPage() {
  const { t } = useTranslation();
  const { admin, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (admin) return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password, totp);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-orb login-orb-one" />
      <div className="login-orb login-orb-two" />
      <div className="login-panel">
        <div className="login-brand">
          <div className="brand-mark large">
            <LockKeyhole size={26} />
          </div>
          <div>
            <h1>{t('appName')}</h1>
            <p>{t('appTagline')}</p>
          </div>
        </div>
        <div className="login-title">
          <ShieldCheck size={21} />
          <h2>{t('signIn')}</h2>
        </div>
        <p className="muted">{t('loginHelp')}</p>
        <form onSubmit={(event) => void submit(event)}>
          <Field label={t('email')}>
            <input
              dir="ltr"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label={t('password')}>
            <input
              dir="ltr"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              required
            />
          </Field>
          <Field label={t('totp')} hint={t('totpOptional')}>
            <input
              dir="ltr"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
              maxLength={32}
            />
          </Field>
          {error && <div className="form-error">{error}</div>}
          <Button type="submit" disabled={busy}>
            {busy ? t('loading') : t('signIn')}
          </Button>
        </form>
      </div>
    </div>
  );
}
