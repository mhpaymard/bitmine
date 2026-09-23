import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BookOpen,
  Boxes,
  ChevronDown,
  CircleDollarSign,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Settings,
  ShieldCheck,
  Sun,
  SunMoon,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme, type ThemeMode } from '../theme';

const nav = [
  { to: '/', key: 'dashboard', icon: LayoutDashboard },
  { to: '/customers', key: 'customers', icon: Users },
  { to: '/workers', key: 'workers', icon: Activity },
  { to: '/upstreams', key: 'upstreams', icon: Network },
  { to: '/ledger', key: 'ledger', icon: BookOpen },
  { to: '/payouts', key: 'payouts', icon: CircleDollarSign },
  { to: '/wallets', key: 'wallets', icon: WalletCards },
  { to: '/alerts', key: 'alerts', icon: AlertTriangle },
  { to: '/audit', key: 'audit', icon: ShieldCheck },
  { to: '/settings', key: 'settings', icon: Settings },
];

const themeOptions: Array<{ mode: ThemeMode; icon: typeof Sun }> = [
  { mode: 'auto', icon: SunMoon },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
];

export function Layout() {
  const { t, i18n } = useTranslation();
  const { admin, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const rtl = i18n.language === 'fa';
    document.documentElement.lang = i18n.language;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  }, [i18n.language]);

  const switchLanguage = async () => {
    const next = i18n.language === 'fa' ? 'en' : 'fa';
    localStorage.setItem('language', next);
    await i18n.changeLanguage(next);
  };

  return (
    <div className="app-shell">
      {open && (
        <button className="sidebar-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />
      )}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Boxes size={22} />
          </div>
          <div>
            <strong>{t('appName')}</strong>
            <span>{t('appTagline')}</span>
          </div>
          <button className="mobile-close" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav>
          {nav.map(({ to, key, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <Icon size={19} />
              <span>{t(key)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="environment">
            <span className="pulse-dot" />
            <div>
              <strong>Gateway</strong>
              <small>BTC · XMR</small>
            </div>
          </div>
          <button className="nav-link" onClick={() => void logout()}>
            <LogOut size={19} />
            <span>{t('signOut')}</span>
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setOpen(true)}>
            <Menu size={22} />
          </button>
          <div className="topbar-spacer" />
          <div className="segmented theme-switch" role="radiogroup" aria-label={t('theme')}>
            {themeOptions.map(({ mode: optionMode, icon: Icon }) => (
              <button
                key={optionMode}
                type="button"
                role="radio"
                aria-checked={mode === optionMode}
                className={mode === optionMode ? 'active' : ''}
                title={t(
                  optionMode === 'auto' ? 'themeAuto' : optionMode === 'light' ? 'themeLight' : 'themeDark',
                )}
                onClick={() => setMode(optionMode)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          <button className="language-button" onClick={() => void switchLanguage()}>
            <ArrowLeftRight size={16} />
            {t('language')}
          </button>
          <div className="admin-menu">
            <div className="avatar">{admin?.displayName.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{admin?.displayName}</strong>
              <span>{admin?.role}</span>
            </div>
            <ChevronDown size={15} />
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
