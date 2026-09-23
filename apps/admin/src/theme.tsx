import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'mitm-theme-override';
const OVERRIDE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 19;
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

interface StoredOverride {
  theme: ResolvedTheme;
  expiresAt: number;
}

export function autoTheme(date: Date = new Date()): ResolvedTheme {
  const hour = date.getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? 'light' : 'dark';
}

function readOverride(): StoredOverride | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredOverride>;
    if (
      (parsed.theme !== 'light' && parsed.theme !== 'dark') ||
      typeof parsed.expiresAt !== 'number'
    ) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return { theme: parsed.theme, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function resolveState(): { mode: ThemeMode; theme: ResolvedTheme } {
  const override = readOverride();
  if (override) return { mode: override.theme, theme: override.theme };
  return { mode: 'auto', theme: autoTheme() };
}

function applyToDocument(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f6fb' : '#070f1a');
}

interface ThemeContextValue {
  mode: ThemeMode;
  theme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(resolveState);

  useEffect(() => {
    applyToDocument(state.theme);
  }, [state.theme]);

  useEffect(() => {
    const recompute = () => setState(resolveState());
    const interval = setInterval(recompute, RECHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', recompute);
    window.addEventListener('focus', recompute);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', recompute);
      window.removeEventListener('focus', recompute);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode: state.mode,
      theme: state.theme,
      setMode(mode: ThemeMode) {
        if (mode === 'auto') {
          localStorage.removeItem(STORAGE_KEY);
        } else {
          const override: StoredOverride = { theme: mode, expiresAt: Date.now() + OVERRIDE_DURATION_MS };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(override));
        }
        setState(resolveState());
      },
    }),
    [state],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
