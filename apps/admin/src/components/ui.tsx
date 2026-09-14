import { AlertTriangle, LoaderCircle, X } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

export function Button({
  className,
  children,
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'secondary';
}) {
  return (
    <button className={clsx('button', `button-${variant}`, className)} {...props}>
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx('card', className)}>{children}</section>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'good' | 'warn' | 'bad' | 'neutral' | 'info';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="state-box">
      <LoaderCircle className="spin" size={22} />
      {t('loading')}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="state-box state-error">
      <AlertTriangle size={22} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
      {retry && (
        <Button variant="ghost" onClick={retry}>
          {t('retry')}
        </Button>
      )}
    </div>
  );
}

export function Empty() {
  const { t } = useTranslation();
  return <div className="empty">{t('noData')}</div>;
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function formatAtomic(amount: string | bigint, asset: 'BTC' | 'XMR'): string {
  const decimals = asset === 'BTC' ? 8 : 12;
  const raw = BigInt(amount)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/u, '').slice(0, 8);
  return `${whole}${fraction ? `.${fraction}` : ''} ${asset}`;
}

export function formatHashrate(value: number): string {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let current = value;
  let unit = 0;
  while (Math.abs(current) >= 1000 && unit < units.length - 1) {
    current /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(current)} ${units[unit]}`;
}
