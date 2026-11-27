import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// 백엔드에는 로그인 · 계정이 없다. 요청마다 body.by(표시 이름)로 누가 했는지만 남긴다.
// 그래서 여기서는 이름과 역할을 브라우저에만 저장한다. (기능 구현 필요: 실제 로그인 · 권한 검증)

export type Role = 'agent' | 'admin';
export type Session = { name: string; role: Role; email?: string };

const KEY = 'baton.session';

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s && typeof s.name === 'string' && s.name.trim() ? s : null;
  } catch {
    return null;
  }
}

type Ctx = { session: Session | null; signIn: (s: Session) => void; signOut: () => void };

const SessionContext = createContext<Ctx>({ session: null, signIn: () => {}, signOut: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(load);

  const signIn = useCallback((s: Session) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* 저장이 막혀 있어도 이번 탭에서는 동작한다 */
    }
    setSession(s);
  }, []);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* noop */
    }
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
