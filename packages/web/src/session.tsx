import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Capability, MeResponse } from '@cl/shared';
import { api, setCsrf } from './api';

type SessionCtx = {
  me: MeResponse | null; // null while loading
  refresh: () => Promise<void>;
  can: (c: Capability) => boolean;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api<MeResponse>('GET', '/api/auth/me');
      setCsrf(m.csrfToken);
      setMe(m);
    } catch {
      setMe({ stage: 'none' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: SessionCtx = {
    me,
    refresh,
    can: (c) => !!me?.user?.capabilities.includes(c) && me.stage === 'full',
    signOut: async () => {
      try {
        await api('POST', '/api/auth/logout');
      } finally {
        setCsrf(undefined);
        await refresh();
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}
