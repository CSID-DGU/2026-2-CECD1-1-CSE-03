import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useSession, type Role } from '../../lib/session';
import { Todo } from '../../components/ui';
import { COMPANY } from '../../components/Gnb';
import './x.css';

// 로그인은 화면만 Figma대로 만들고 검증 없이 통과시킨다. (실제 로그인은 나중에 추가)
// 백엔드가 아는 것은 요청의 `by`(표시 이름)뿐이라, 이메일 @ 앞부분을 이름으로 쓴다.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_RE = /^[A-Z0-9]{6}$/;
export const homeOf = (role: Role) => (role === 'admin' ? '/M-100' : '/A-100');
export const nameFromEmail = (email: string) => email.trim().split('@')[0] || email.trim();

/** X-100 · X-110 왼쪽 보라 면 */
export function Hero() {
  return (
    <section className="x-hero">
      <div className="x-hero-brand">
        <span className="x-logo-white" aria-hidden>
          <i />
        </span>
        BATON <small>AI 상담 코파일럿</small>
      </div>
      <h2>
        고객은 여전히
        <br />
        사람을 기다립니다.
      </h2>
      <p className="x-hero-sub">
        <i aria-hidden />
        결정의 바톤은, 사람에게.
      </p>
      <div className="x-relay">
        <span>AI가 받고</span>
        <ArrowRight size={14} strokeWidth={2} />
        <span className="on">사람이 결정하고</span>
        <ArrowRight size={14} strokeWidth={2} />
        <span>AI가 이어받아요</span>
      </div>
    </section>
  );
}

/** 워크스페이스(기업명 + 기업 코드) · 이메일 · 비밀번호 — X-100 · X-120 공통 입력칸 */
export function useCredentials() {
  const [company, setCompany] = useState(COMPANY);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [keep, setKeep] = useState(true);
  const [emailTouched, setEmailTouched] = useState(false);

  const companyOk = company.trim().length >= 2 && company.trim().length <= 30;
  const codeOk = CODE_RE.test(code);
  const emailOk = EMAIL_RE.test(email.trim());
  const ready = companyOk && codeOk && emailOk && password.length >= 1;

  const fields = (emailLabel: string): ReactNode => (
    <>
      <span className="field-label">
        워크스페이스 <small>기업명 + 기업 코드</small>
      </span>
      <div className="x-ws">
        <div className="x-ws-name">
          <span className="gnb-company-mark" aria-hidden>
            {company.trim().slice(0, 1).toUpperCase() || 'A'}
          </span>
          <input className="input" value={company} maxLength={30} onChange={(e) => setCompany(e.target.value)} aria-label="기업명" />
          <small>기업명</small>
        </div>
        <span>#</span>
        <input
          className="input x-code"
          value={code}
          maxLength={6}
          placeholder="기업 코드"
          aria-label="기업 코드"
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
        />
      </div>

      <label className="field-label" htmlFor="x-email">
        {emailLabel}
      </label>
      <input
        id="x-email"
        type="email"
        className={`input${emailTouched && email && !emailOk ? ' is-error' : ''}`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => setEmailTouched(true)}
        autoComplete="username"
      />
      {emailTouched && email && !emailOk && <p className="field-error">이메일 형식을 확인해 주세요</p>}

      <label className="field-label" htmlFor="x-pw">
        비밀번호
      </label>
      <div className="x-pw">
        <input id="x-pw" type={showPw ? 'text' : 'password'} className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button type="button" onClick={() => setShowPw((v) => !v)}>
          {showPw ? '숨기기' : '보기'}
        </button>
      </div>

      <div className="x-row">
        <label className="x-check" title="공용 PC에서는 꺼 주세요 · 켜면 30일 유지">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          로그인 상태 유지
        </label>
      </div>
    </>
  );

  return { fields, ready, email, company };
}

/** X-100 로그인 (관리자 · 상담원 공통) */
export function Login() {
  const { session, signIn } = useSession();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>('agent');
  const cred = useCredentials();

  if (session) return <Navigate to={homeOf(session.role)} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cred.ready) return;
    signIn({ name: nameFromEmail(cred.email), role, email: cred.email.trim() });
    navigate(homeOf(role));
  };

  return (
    <div className="x-split">
      <Hero />
      <section className="x-form-side">
        <form className="x-form" onSubmit={submit}>
          <h1 className="t-h1" style={{ fontSize: 28 }}>
            바톤에 로그인
          </h1>
          <p className="tertiary t-13" style={{ marginTop: 8 }}>
            워크스페이스와 회사 이메일로 로그인해요.
          </p>

          <span className="field-label">로그인 유형</span>
          <div className="segment" role="group" style={{ width: '100%', height: 46 }}>
            <button type="button" style={{ flex: 1, height: 38 }} aria-pressed={role === 'admin'} onClick={() => setRole('admin')}>
              관리자
            </button>
            <button type="button" style={{ flex: 1, height: 38 }} aria-pressed={role === 'agent'} onClick={() => setRole('agent')}>
              상담원
            </button>
          </div>

          {cred.fields('회사 이메일')}

          <button type="submit" className="btn btn-lg btn-primary btn-block" style={{ marginTop: 18 }} disabled={!cred.ready} title={cred.ready ? undefined : '워크스페이스 · 기업 코드 6자리 · 이메일 · 비밀번호를 모두 입력해 주세요'}>
            로그인
          </button>
          <p className="x-foot">
            초대 메일을 받으셨나요?{' '}
            <Link to="/X-110" className="x-link">
              메일의 링크로 들어오면 바로 가입돼요
            </Link>
          </p>
          <div style={{ marginTop: 18 }}>
            <Todo block what="계정 검증 (기업명↔코드 일치 · 구성원 확인 · 비밀번호 · 5회 실패 잠금) · 비밀번호 재설정 — 지금은 형식만 맞으면 통과" />
          </div>
          <p className="x-foot">
            <Link to="/C-100" className="x-link">
              고객 문의 창구로 가기
            </Link>
          </p>
        </form>
      </section>
    </div>
  );
}
