import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AppConfig, type Me } from './api';

interface AuthState {
  me: Me | null;
  config: AppConfig | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ me: null, config: null, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [meRes, cfgRes] = await Promise.all([api<Me>('/api/me'), api<AppConfig>('/api/config')]);
      setMe(meRes);
      setConfig(cfgRes);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <AuthContext.Provider value={{ me, config, loading, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// Can this browser see the live map at all?
export const canView = (me: Me | null): boolean => !!me && (me.publicMode || !!me.user || me.kiosk);
export const isAdmin = (me: Me | null): boolean => me?.user?.role === 'admin';
