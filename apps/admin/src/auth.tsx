import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, post, setCsrfToken } from './api';

export interface Admin {
  id: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'OPERATOR' | 'VIEWER';
}

interface AuthContextValue {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ admin: Admin; csrfToken: string }>('/api/v1/auth/me')
      .then((result) => {
        setAdmin(result.admin);
        setCsrfToken(result.csrfToken);
      })
      .catch(() => setAdmin(null))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      admin,
      loading,
      async login(email, password, totpCode) {
        const result = await post<{ admin: Admin; csrfToken: string }>('/api/v1/auth/login', {
          email,
          password,
          totpCode: totpCode || undefined,
        });
        setCsrfToken(result.csrfToken);
        setAdmin(result.admin);
      },
      async logout() {
        await post('/api/v1/auth/logout');
        setAdmin(null);
        setCsrfToken('');
      },
    }),
    [admin, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing');
  return value;
}
