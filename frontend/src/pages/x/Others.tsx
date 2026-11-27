import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { useSession } from '../../lib/session';
import { Todo, useToast } from '../../components/ui';
import { COMPANY } from '../../components/Gnb';
import { Hero, homeOf, nameFromEmail, useCredentials } from './Login';
import './x.css';

/** X-110 초대 수락 · 가입 */
export function Invite() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const pwOk = password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  const ready = name.trim().length >= 1 && name.trim().length <= 20 && pwOk;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    signIn({ name: name.trim(), role: 'agent' });
    navigate('/A-100');
  };

  return (
    <div className="x-split">
      <Hero />
      <section className="x-form-side">
        <form className="x-form" style={{ width: 420 }} onSubmit={submit}>
          <span className="chip chip-human">상담원으로 초대됨</span>
          <h1 className="t-h1" style={{ fontSize: 28, marginTop: 10 }}>
            {COMPANY} 팀에 초대됐어요
          </h1>
          <p className="tertiary t-13" style={{ marginTop: 8 }}>
            소속 · 관리자 <Todo what="초대 정보 조회 (소속 팀 · 초대한 관리자)" />
          </p>

          <div className="x-readonly" style={{ marginTop: 20 }}>
            <div className="row gap-10">
              <b>워크스페이스</b>
              <span className="gnb-company-mark" aria-hidden>
                A
              </span>
              <b>{COMPANY}</b>
            </div>
            <p className="hint t-12" style={{ marginTop: 10 }}>
              다음 로그인부터 이 기업명과 코드를 입력해요
            </p>
          </div>

          <label className="field-label" htmlFor="x-inv-email">
            이메일
          </label>
          <input id="x-inv-email" className="input" readOnly value="" placeholder="초대받은 주소 (초대 링크에서 채워져요)" />

          <label className="field-label" htmlFor="x-inv-name">
            이름
          </label>
          <input id="x-inv-name" className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} autoFocus />

          <label className="field-label" htmlFor="x-inv-pw">
            비밀번호
          </label>
          <input id="x-inv-pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <p className="t-12" style={{ marginTop: 8, color: password ? (pwOk ? 'var(--status-ok)' : 'var(--status-risk)') : 'var(--gray-500)' }}>
            8자 이상 · 영문과 숫자 포함
          </p>

          <div className="x-info">
            <span className="chip chip-human" style={{ marginRight: 8 }}>
              사람
            </span>
            <b>바톤은 상담원을 먼저 지켜요</b>
            <br />· 고객의 거친 표현은 정리해서 보여드려요
            <br />· 원문은 필요할 때만, 사유를 남기고 열어요
            <br />· 고감정 문의는 하루 5건까지만 배정돼요
          </div>

          <button type="submit" className="btn btn-lg btn-primary btn-block" style={{ marginTop: 20 }} disabled={!ready}>
            가입하고 시작하기
          </button>
          <div style={{ marginTop: 16 }}>
            <Todo block what="초대 링크(7일 유효) 확인 · 계정 생성 — 지금은 이름만 받아 상담원으로 들어가요" />
          </div>
        </form>
      </section>
    </div>
  );
}

/** X-120 관리자 로그인 (첫 방문) */
export function AdminLogin() {
  const { session, signIn } = useSession();
  const navigate = useNavigate();
  const cred = useCredentials();

  if (session) return <Navigate to={homeOf(session.role)} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cred.ready) return;
    signIn({ name: nameFromEmail(cred.email), role: 'admin', email: cred.email.trim() });
    navigate('/X-130');
  };

  return (
    <div className="x-admin">
      <section className="x-admin-left">
        <div className="x-admin-top">
          <span className="gnb-logo" aria-hidden>
            <i />
          </span>
          <b style={{ fontSize: 14, color: 'var(--gray-900)' }}>BATON</b>
          <span className="hint">AI 상담 코파일럿</span>
          <span className="spacer" />
          계정이 없나요? <b className="brand">도입 문의</b>
        </div>
        <form className="x-admin-card" onSubmit={submit}>
          <div className="row gap-10">
            <span className="gnb-company-mark" style={{ width: 28, height: 28, fontSize: 13 }} aria-hidden>
              A
            </span>
            <b style={{ fontSize: 18 }}>{COMPANY}</b>
            <span className="hint">×</span>
            <span className="gnb-logo" style={{ width: 22, height: 22 }} aria-hidden>
              <i />
            </span>
            <b>BATON</b>
          </div>
          <h1 className="t-h1" style={{ marginTop: 18 }}>
            {COMPANY} CS 관리 페이지
          </h1>
          <p className="tertiary t-13" style={{ marginTop: 6 }}>
            기업명과 기업 코드로 들어와 주세요.
          </p>
          <div className="x-form" style={{ width: '100%' }}>{cred.fields('관리자 이메일')}</div>
          <button type="submit" className="btn btn-lg btn-primary btn-block" style={{ marginTop: 18 }} disabled={!cred.ready}>
            로그인
          </button>
          <div className="x-info" style={{ display: 'flex', gap: 12, alignItems: 'center', borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
            <span className="chip chip-ai" style={{ height: 30, background: 'var(--primary-500)', color: '#fff' }}>
              1st
            </span>
            <span>
              <b>처음 오셨나요?</b>
              <br />
              가입 메일의 ‘비밀번호 만들기’로 시작해요
            </span>
          </div>
          <div style={{ marginTop: 14 }}>
            <Todo block what="계정 검증 · 비밀번호 찾기 — 지금은 형식만 맞으면 통과" />
          </div>
        </form>
        <div className="x-admin-bottom">
          <span>이용약관</span>
          <span>개인정보처리방침</span>
          <span className="spacer" />
          <span>© BATON</span>
        </div>
      </section>

      <section className="x-admin-right">
        <span className="t-12" style={{ opacity: 0.8 }}>
          로그인하면 바로 이어서
        </span>
        <h2>
          {COMPANY} 고객센터를
          <br />
          매뉴얼 하나로 열어요
        </h2>
        <div className="x-preview" aria-hidden>
          <div className="row gap-8">
            <span className="gnb-company-mark">A</span>
            <b>{COMPANY}</b>
            <span className="t-12 tertiary">고객센터</span>
            <span className="spacer" />
            <span className="hint" style={{ fontSize: 11 }}>
              자주 묻는 질문 · 1:1 문의
            </span>
          </div>
          <b style={{ display: 'block', marginTop: 18, fontSize: 15 }}>무엇을 도와드릴까요?</b>
          <div className="x-preview-grid">
            <span>계정</span>
            <span className="on">결제 · 요금</span>
            <span>사용 방법</span>
            <span>온보딩</span>
          </div>
          <div className="x-info" style={{ marginTop: 12, padding: 12, borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
            <b className="brand" style={{ fontSize: 11.5 }}>
              AI 상담 · 바로 답변
            </b>
            <br />
            고객센터 안내에 있는 내용은 AI가 바로 알려드려요.
          </div>
          <span className="btn btn-md btn-primary btn-block" style={{ marginTop: 12 }}>
            문의 접수하기
          </span>
        </div>
        <div className="x-steps">
          <span>회사 정보</span>
          <ArrowRight size={13} />
          <span>매뉴얼 올리기</span>
          <ArrowRight size={13} />
          <span>자동 구성</span>
          <ArrowRight size={13} />
          <span>게시</span>
        </div>
      </section>
    </div>
  );
}

const INDUSTRIES = ['SaaS · 소프트웨어', '온라인 쇼핑몰', '공공기관', '교육 (학원)', '제조 · 철강', '자영업 · 매장'];
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** X-130 첫 로그인 · 회사 정보 확인 */
export function Onboard() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [industry, setIndustry] = useState(INDUSTRIES[0]);
  const [days, setDays] = useState(new Set(['월', '화', '수', '목', '금']));
  const [color, setColor] = useState<'baton' | 'brand'>('baton');

  if (!session) return <Navigate to="/X-120" replace />;
  if (session.role !== 'admin') return <Navigate to="/X-900" replace />;

  const toggleDay = (d: string) =>
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });

  return (
    <>
      <header className="x-top">
        <span className="gnb-logo" aria-hidden>
          <i />
        </span>
        <span className="gnb-wordmark">BATON</span>
        <span className="hint t-12" style={{ marginLeft: 12 }}>
          AI 상담 코파일럿
        </span>
        <div className="x-stepper">
          <span className="on">
            <b>1</b>회사 정보
          </span>
          <span>
            <b>2</b>매뉴얼 업로드
          </span>
          <span>
            <b>3</b>AI 분석
          </span>
          <span>
            <b>4</b>접수 페이지 게시
          </span>
        </div>
      </header>

      <main className="x-onboard">
        <section className="card">
          <b className="brand t-13">반가워요, {session.name} 님</b>
          <h1 className="t-h1" style={{ fontSize: 26, marginTop: 6 }}>
            회사 정보를 확인해 주세요
          </h1>
          <p className="tertiary t-13" style={{ marginTop: 6 }}>
            고객이 보는 고객센터 페이지에 그대로 쓰여요.
          </p>

          <div className="x-grid2" style={{ marginTop: 22 }}>
            <label>
              <span className="field-label">회사 이름</span>
              <input className="input" defaultValue={COMPANY} />
            </label>
            <label>
              <span className="field-label">회사 주소</span>
              <input className="input" placeholder="https://" />
            </label>
          </div>

          <span className="field-label" style={{ marginTop: 20 }}>
            로고
          </span>
          <div className="card row gap-10" style={{ padding: 16, borderRadius: 12 }}>
            <span className="gnb-company-mark" style={{ width: 44, height: 44, fontSize: 18 }} aria-hidden>
              A
            </span>
            <span className="hint t-12">정사각형 · 투명 배경 권장</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm btn-line" disabled>
              변경
            </button>
          </div>

          <span className="field-label" style={{ marginTop: 20 }}>
            업종
          </span>
          <div className="x-chips">
            {INDUSTRIES.map((i) => (
              <button key={i} type="button" aria-pressed={industry === i} onClick={() => setIndustry(i)}>
                {i}
              </button>
            ))}
          </div>

          <span className="field-label" style={{ marginTop: 20 }}>
            고객센터 버튼 색
          </span>
          <div className="x-grid2" role="radiogroup">
            <button type="button" role="radio" aria-checked={color === 'baton'} className="radio-card" onClick={() => setColor('baton')}>
              <i className="radio" />
              <span>
                <b>바톤 기본</b>
                <span className="hint t-12" style={{ display: 'block' }}>
                  #5F5CE8
                </span>
              </span>
            </button>
            <button type="button" role="radio" aria-checked={color === 'brand'} className="radio-card" style={{ marginTop: 0 }} onClick={() => setColor('brand')}>
              <i className="radio" />
              <span>
                <b>회사 컬러</b>
                <span className="hint t-12" style={{ display: 'block' }}>
                  직접 지정
                </span>
              </span>
            </button>
          </div>

          <span className="field-label" style={{ marginTop: 20 }}>
            상담원 연결 시간 <small style={{ fontWeight: 400, color: 'var(--gray-500)' }}>이 시간에만 상담원 연결 버튼이 켜져요 · AI 답변은 24시간</small>
          </span>
          <div className="row gap-8 x-days" style={{ flexWrap: 'wrap' }}>
            {DAYS.map((d) => (
              <button key={d} type="button" aria-pressed={days.has(d)} onClick={() => toggleDay(d)}>
                {d}
              </button>
            ))}
            <input className="input mono" style={{ width: 120 }} defaultValue="09:00" />
            <span className="hint">–</span>
            <input className="input mono" style={{ width: 120 }} defaultValue="18:00" />
            <label className="x-check">
              <input type="checkbox" defaultChecked />
              공휴일은 쉬어요
            </label>
          </div>

          <div className="x-grid2" style={{ marginTop: 20 }}>
            <label>
              <span className="field-label">워크스페이스</span>
              <input className="input" readOnly value={COMPANY} />
              <span className="hint t-12" style={{ display: 'block', marginTop: 6 }}>
                기업 코드는 바꿀 수 없어요
              </span>
            </label>
            <label>
              <span className="field-label">고객센터 주소</span>
              <input className="input" readOnly value="/C-100" />
            </label>
          </div>

          <div style={{ marginTop: 20 }}>
            <Todo block what="회사 정보 · 로고 · 버튼 색 · 상담원 연결 시간 저장 (워크스페이스 설정이 백엔드에 없음) — 입력해도 저장되지 않아요" />
          </div>
        </section>

        <section className="card row gap-10" style={{ marginTop: 22, padding: '18px 20px' }}>
          <span className="hint t-12">입력한 정보는 관리자 › 설정에서 바꿀 수 있어요</span>
          <span className="spacer" />
          <button type="button" className="btn btn-md btn-line" onClick={() => navigate('/M-100')}>
            나중에 하기
          </button>
          <button type="button" className="btn btn-md btn-primary" onClick={() => navigate('/S-110')}>
            다음 · 매뉴얼 올리기 <ArrowRight size={15} strokeWidth={2} />
          </button>
        </section>
      </main>
    </>
  );
}

/** X-900 권한 없음 · 관리자 / X-910 권한 없음 · 상담원 */
export function NoAccess({ need }: { need: 'admin' | 'agent' }) {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  if (!session) return <Navigate to="/X-100" replace />;
  const admin = need === 'admin';

  return (
    <>
      <header className="x-lock-top">
        <span className="gnb-logo" aria-hidden>
          <i />
        </span>
        <span className="gnb-wordmark">BATON</span>
        <span className="x-ws-pill">
          <span className="gnb-company-mark" aria-hidden>
            A
          </span>
          {COMPANY}
        </span>
        <span className={`chip ${admin ? 'chip-ai' : 'chip-human'}`}>{admin ? '관리자 · 권한 대기' : '상담원 · 권한 대기'}</span>
        <span className="spacer" />
        <button
          type="button"
          className="t-13 hint"
          onClick={() => {
            signOut();
            navigate('/X-100');
          }}
        >
          로그아웃
        </button>
        <span className="avatar">{session.name.slice(0, 1)}</span>
      </header>

      <main className="x-lock">
        <span className={`x-lock-icon${admin ? '' : ' is-agent'}`}>
          <Lock size={26} strokeWidth={2} color="#4e5868" />
        </span>
        <h1 className="t-modal" style={{ marginTop: 18 }}>
          {admin ? '관리자만 볼 수 있는 화면이에요' : '상담원 권한이 필요한 화면이에요'}
        </h1>
        <p className="tertiary" style={{ marginTop: 10, fontSize: 14, lineHeight: '23px' }}>
          {admin ? (
            <>
              아직 관리자 권한이 승인되지 않았어요.
              <br />
              워크스페이스 소유자에게 권한을 요청해 주세요.
            </>
          ) : (
            <>
              문의함은 관리자가 담당으로 지정한 상담원만 볼 수 있어요.
              <br />
              관리자에게 상담원 권한을 요청해 주세요.
            </>
          )}
        </p>
        <button
          type="button"
          className="btn btn-md btn-primary"
          style={{ width: 220, marginTop: 20 }}
          disabled={asked}
          title={asked ? '이미 요청했어요 · 24시간 뒤 다시 보낼 수 있어요' : undefined}
          onClick={() => {
            setAsked(true);
            toast('권한 요청은 아직 전달되지 않아요 (기능 구현 필요)');
          }}
        >
          {asked ? '요청했어요' : '권한 요청하기'}
        </button>
        <p className="hint t-12" style={{ marginTop: 18 }}>
          {admin ? `요청하면 ${COMPANY} 워크스페이스 소유자에게 알림이 가요` : '요청하면 관리자에게 알림이 가요'}
        </p>
        <div style={{ marginTop: 16, textAlign: 'left' }}>
          <Todo block what="권한 요청 알림 · 권한 승인 — 지금은 로그인할 때 고른 유형으로만 구분해요" />
        </div>
        <p style={{ marginTop: 14 }}>
          <Link to={homeOf(session.role)} className="x-link">
            내 화면으로 돌아가기
          </Link>
        </p>
      </main>
    </>
  );
}
