import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useSession } from '../lib/session';
import { Todo } from './ui';

export const COMPANY = 'ACME';

export type GnbTab = { to: string; label: string; match?: string[] };

/** A · M 콘솔 공통 상단 바 (Figma: 높이 60 · 좌 로고/회사/역할 · 가운데 탭 · 우 상태/계정). */
export function Gnb({ tabs, pathname }: { tabs: GnbTab[]; pathname: string }) {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.role === 'admin';
  const roleLabel = isAdmin ? '관리자' : '상담원';
  const name = session?.name ?? '';
  const [menu, setMenu] = useState(false);

  return (
    <header className="gnb">
      <div className="gnb-brand">
        <span className="gnb-logo" aria-hidden>
          <i />
        </span>
        <span className="gnb-wordmark">BATON</span>
        <span className="gnb-sep" />
        <span className="gnb-company-mark" aria-hidden>
          A
        </span>
        <span className="gnb-company">{COMPANY}</span>
        <span className={`gnb-role${isAdmin ? ' is-admin' : ''}`}>{roleLabel}</span>
      </div>

      <nav className="gnb-tabs">
        {tabs.map((t) => {
          const active = (t.match ?? [t.to]).some((p) => pathname.startsWith(p));
          return (
            <NavLink key={t.to} to={t.to} className={active ? 'active' : ''}>
              {t.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="gnb-right">
        {!isAdmin && (
          <span className="gnb-pill" title="기능 구현 필요: 상담원별 고감정 응대 건수 집계 · 하루 5건 배정 한도">
            <i className="dot dot-risk" />
            오늘 고감정 응대
            <Todo what="상담원별 고감정 응대 집계" />
          </span>
        )}
        {isAdmin && (
          <span className="gnb-pill" title="기능 구현 필요: 상담원 근무 상태 집계">
            <i className="dot dot-ok" />
            근무 중 상담원
            <Todo what="상담원 근무 상태" />
          </span>
        )}
        <span className="gnb-user" role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} onKeyDown={(e) => e.key === 'Enter' && setMenu((v) => !v)}>
          <span className="avatar">{name.slice(0, 1)}</span>
          {name}
          <small>{roleLabel}</small>
          {menu && (
            <span className="gnb-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  signOut();
                  navigate('/X-100');
                }}
              >
                <LogOut size={14} strokeWidth={1.75} />
                로그아웃
              </button>
            </span>
          )}
        </span>
      </div>
    </header>
  );
}
