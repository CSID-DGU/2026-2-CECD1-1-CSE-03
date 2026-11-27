import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, MessageSquare, Pencil, Phone, Search, X } from 'lucide-react';
import { ApiError, post } from '../../lib/api';
import { hm } from '../../lib/format';
import { Modal, Todo } from '../../components/ui';
import { COMPANY } from '../../components/Gnb';
import { EMAIL_RE } from '../x/Login';
import '../x/x.css';
import './c.css';

// 고객 문의 창구.
// 백엔드에서 고객이 쓸 수 있는 것은 문의 접수(POST /api/inbound)뿐이다.
// 접수 뒤 화면(C-101 ~ C-140) · 내 문의 조회(C-200) · FAQ(C-300)는 화면만 만들고 "기능 구현 필요"로 표시한다.

/** C-100에서 접수한 문의 — 이후 화면이 같은 내용을 이어서 보여준다 (브라우저 탭 안에서만 유지). */
type Ticket = { caseId: string; type: string; subject: string; body: string; email: string; at: string };

const maskEmail = (e: string) => e.replace(/^(.{1,3})[^@]*(@.*)$/, '$1***$2');
const ticketNo = (t: Ticket | null) => (t ? t.caseId.slice(0, 8).toUpperCase() : '—');

// ACME(업무 협업 SaaS)의 접수 창구 3개(policy/*.json)에 맞춘 문의 종류.
const TYPES = [
  { key: 'account', title: '계정 · 로그인', desc: '로그인 · 탈퇴 · 계정 정보', channel: 'support' },
  { key: 'billing', title: '결제 · 요금', desc: '영수증 · 구독 · 환불', channel: 'support' },
  { key: 'howto', title: '사용 방법', desc: '기능 위치 · 사용법', channel: 'support' },
  { key: 'onboarding', title: '온보딩 신청', desc: '도입 교육 · 미팅', channel: 'onboarding' },
  { key: 'sales', title: '도입 · 견적', desc: '서비스 소개 · 견적', channel: 'sales' },
  { key: 'other', title: '기타', desc: '그 밖의 문의', channel: 'support' },
];

function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { pathname } = useLocation();
  const tab = pathname.startsWith('/C-3') ? 'faq' : pathname.startsWith('/C-2') ? 'mine' : 'ask';
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header className="c-top">
        <div className="c-top-in">
          <Link to="/C-300" className="c-brand">
            <span className="gnb-company-mark" aria-hidden>
              A
            </span>
            <b>{COMPANY}</b>
            <i />
            고객센터
          </Link>
          <nav className="c-tabs">
            <NavLink to="/C-300" className={tab === 'faq' ? 'active' : ''}>
              자주 묻는 질문
            </NavLink>
            <NavLink to="/C-100" className={tab === 'ask' ? 'active' : ''}>
              1:1 문의
            </NavLink>
            <NavLink to="/C-200" className={tab === 'mine' ? 'active' : ''}>
              내 문의 조회
            </NavLink>
          </nav>
          <div className="c-top-right">
            <span title="기능 구현 필요: 운영 시간 설정(S-300) 값 표시">상담원 연결 시간 안내 · 문의 접수 24시간</span>
            <Link to="/Shop" className="btn btn-sm btn-line">
              {COMPANY} 홈 <ArrowUpRight size={13} />
            </Link>
          </div>
          {/* 모바일 헤더: 로고 + '내 문의'만 */}
          <Link to="/C-200" className="c-top-mobile">
            내 문의
          </Link>
        </div>
      </header>
      {wide ? children : <main className="c-main">{children}</main>}
      <div className="c-foot" style={{ paddingBottom: 32 }}>
        <span className="gnb-logo" style={{ width: 24, height: 24 }} aria-hidden>
          <i />
        </span>
        Powered by <b style={{ color: 'var(--gray-900)' }}>BATON</b> · 바로 안내하고, 사람이 확인해요
      </div>
    </div>
  );
}

function Preview({ what, next }: { what: string; next?: { to: string; text: string; state: unknown } }) {
  return (
    <div className="todo-block" style={{ marginBottom: 16 }}>
      <span style={{ flex: 1 }}>
        <b>기능 구현 필요</b> · {what}
      </span>
      {next && (
        <Link to={next.to} state={next.state} className="x-link">
          {next.text}
        </Link>
      )}
    </div>
  );
}

// ───────── C-100 문의 접수 (+ C-100_error 필수 누락) ─────────

export function Ask() {
  const navigate = useNavigate();
  const preset = (useLocation().state as { subject?: string; type?: string } | null) ?? null;
  const [type, setType] = useState(preset?.type ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [subject, setSubject] = useState(preset?.subject ?? '');
  const [body, setBody] = useState('');
  const [agree, setAgree] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const picked = TYPES.find((t) => t.key === type);
  const emailOk = EMAIL_RE.test(email.trim());
  const subjectOk = subject.trim().length >= 2 && subject.trim().length <= 40;
  const bodyOk = body.trim().length >= 10 && body.length <= 1000;
  const ready = Boolean(picked) && emailOk && subjectOk && bodyOk && agree;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ready || !picked || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const r = await post<{ caseId: string }>('/api/inbound', {
        channel: picked.channel,
        from: email.trim(),
        name: name.trim() || undefined,
        subject: subject.trim(),
        body: body.trim(),
      });
      const ticket: Ticket = { caseId: r.caseId, type: picked.title, subject: subject.trim(), body: body.trim(), email: email.trim(), at: new Date().toISOString() };
      navigate('/C-101', { state: ticket });
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.status === 401
          ? '이 서버는 접수에 인증 키(INBOUND_SECRET)가 필요해서 웹에서 바로 접수할 수 없어요.'
          : '접수하지 못했어요. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  };

  const emailErr = (tried || emailTouched) && !emailOk;
  return (
    <Shell>
      <div className="c-cols">
        <form className="c-card" onSubmit={submit} noValidate>
          {tried && !ready && <p className="c-errbar">빠진 항목이 있어요 · 빨간 표시를 확인해 주세요</p>}
          <h1 className="c-h1">무엇을 도와드릴까요?</h1>

          <h2 className="c-h2">1. 문의 종류를 골라주세요</h2>
          <div className="c-types" role="radiogroup">
            {TYPES.map((t) => (
              <button key={t.key} type="button" role="radio" aria-checked={type === t.key} className="c-type" onClick={() => setType(t.key)}>
                <b>{t.title}</b>
                <span>{t.desc}</span>
              </button>
            ))}
          </div>
          {tried && !picked && <p className="field-error">문의 종류를 골라 주세요</p>}
          {picked && <p className="c-notice">{picked.title} 문의는 고객센터 안내에 있는 내용이면 바로 안내드리고, 판단이 필요하면 담당자가 확인한 뒤 답변드려요</p>}

          <h2 className="c-h2">2. 확인이 필요한 정보</h2>
          <div className="c-grid2">
            <label>
              <span className="field-label">이름</span>
              <input className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span className="field-label">이메일</span>
              <input type="email" className={`input${emailErr ? ' is-error' : ''}`} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setEmailTouched(true)} placeholder="답변을 받을 주소" />
              {emailErr && <span className="field-error">이메일 형식을 확인해 주세요</span>}
            </label>
            <label>
              <span className="field-label">
                사진 첨부 <span className="hint" style={{ fontWeight: 400 }}>선택</span> <Todo what="사진 · 파일 첨부 (접수 API가 첨부를 받지 않음)" />
              </span>
              <input className="input" readOnly placeholder="+ 사진 · 파일 올리기" />
            </label>
          </div>

          <h2 className="c-h2">3. 문의 내용</h2>
          <label>
            <span className="field-label">제목</span>
            <input className={`input${tried && !subjectOk ? ' is-error' : ''}`} value={subject} maxLength={40} onChange={(e) => setSubject(e.target.value)} />
            {tried && !subjectOk && <span className="field-error">제목은 2~40자로 적어 주세요</span>}
          </label>
          <label style={{ display: 'block', marginTop: 14 }}>
            <span className="field-label">
              내용 <span className="c-count">{body.length} / 1,000</span>
            </span>
            <textarea className={`textarea${tried && !bodyOk ? ' is-error' : ''}`} rows={4} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} />
            {tried && !bodyOk && <span className="field-error">내용은 10자 이상 적어 주세요</span>}
          </label>
          <p className="hint t-12" style={{ marginTop: 10 }}>
            답변은 이메일로 알려드려요 <Todo what="이 페이지에서 답변 알림" />
          </p>

          <label className={`x-check c-agree${tried && !agree ? ' is-error' : ''}`}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            개인정보 수집 · 이용에 동의합니다. 첫 안내는 자동으로 드리고, 필요하면 상담원이 이어받아요.
          </label>
          {tried && !agree && (
            <p className="field-error" style={{ marginLeft: 26 }}>
              동의해야 문의를 접수할 수 있어요
            </p>
          )}
          {failure && <p className="field-error">{failure}</p>}

          {/* 조건을 다 채우기 전에는 옅게 보이고, 누르면 빠진 항목을 알려준다 (C-100_error) */}
          <button type="submit" className={`btn btn-lg btn-primary btn-block${busy ? ' is-loading' : ''}${ready ? '' : ' is-pale'}`} style={{ marginTop: 18 }}>
            {busy ? '접수하는 중' : '문의 접수하기'}
          </button>
        </form>

        <aside>
          <section className="c-side">
            <b style={{ fontSize: 15 }}>접수하면 이렇게 진행돼요</b>
            <ol className="c-steps">
              <li>
                <i>1</i>
                <span>
                  <b>접수</b>문의 내용을 확인해요
                </span>
              </li>
              <li>
                <i>2</i>
                <span>
                  <b>답변 도착</b>고객센터 안내에 있는 내용은 바로 답해요
                </span>
              </li>
              <li>
                <i className="is-human">3</i>
                <span>
                  <b>필요하면 상담원 연결</b>판단이 필요한 건은 상담원이 확인하고 답해요
                </span>
              </li>
            </ol>
          </section>
          <section className="c-side">
            <b style={{ fontSize: 15 }}>자주 찾는 답변</b>
            <div className="c-rows">
              <Link to="/C-300">
                자주 묻는 질문에서 찾아보기 <ChevronRight size={16} />
              </Link>
            </div>
            <Todo block what="문의 종류별 자주 찾는 답변 3개 (고객용 FAQ API 없음)" />
          </section>
        </aside>
      </div>
    </Shell>
  );
}

// ───────── C-101 답변 준비 중 ─────────

export function Preparing() {
  const navigate = useNavigate();
  const ticket = (useLocation().state as Ticket | null) ?? null;
  const [step, setStep] = useState(1);
  useEffect(() => {
    // 단계 표시가 끝나면 자동으로 다음 화면으로 넘어간다 (C-101 스펙 ①⑥)
    const t = window.setTimeout(() => (step >= 3 ? navigate('/C-120', { state: ticket, replace: true }) : setStep((s) => s + 1)), step >= 3 ? 2500 : 1800);
    return () => window.clearTimeout(t);
  }, [step, navigate, ticket]);

  const stages = [
    { t: '문의 접수 완료', d: ticket ? `오늘 ${hm(ticket.at)} · 웹` : '웹' },
    { t: step > 1 ? '문의 내용 확인 완료' : '문의 내용 확인', d: ticket ? ticket.type : '문의 종류에 맞게 자동 분류돼요' },
    { t: '답변을 준비하는 중', d: ticket ? `${ticket.type} 안내를 확인하고 있어요` : '고객센터 안내를 확인하고 있어요' },
    { t: '답변 전달', d: '바로 안내드리거나, 담당자가 확인한 뒤 보내드려요' },
  ];

  return (
    <Shell>
      <section className="c-card c-narrow">
        <div className="row">
          <span className="hint t-12">
            접수번호 <span className="mono">{ticketNo(ticket)}</span>
          </span>
          <span className="spacer" />
          <span className="c-status">
            <i className="dot" style={{ background: 'var(--primary-500)' }} />
            답변 준비 중
          </span>
        </div>
        <h1 className="c-h1" style={{ fontSize: 24, marginTop: 10 }}>
          {COMPANY}가 답변을 준비하고 있어요
        </h1>
        <p className="tertiary t-13" style={{ marginTop: 6 }}>
          {COMPANY} 고객센터 안내에서 답을 찾고 있어요. 보통 10초 안에 끝나요.
        </p>
        <div className="c-progress">
          <i style={{ width: `${(step / 3) * 68}%` }} />
        </div>
        {stages.map((s, i) => (
          <div key={i} className={`c-stage${i === Math.min(step, 2) ? ' is-now' : ''}`}>
            <i className={`dot${i < step ? ' dot-ok' : ''}`} style={i === Math.min(step, 2) ? { background: 'var(--primary-500)' } : undefined} />
            <span>
              <b>{s.t}</b>
              {s.d}
            </span>
          </div>
        ))}
        <div className="x-info" style={{ borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
          <b className="brand">창을 닫아도 괜찮아요</b>
          <br />
          답변이 준비되면 이메일({ticket ? maskEmail(ticket.email) : '접수할 때 남긴 주소'})로 알려드려요.
        </div>
        <div className="row" style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border-default)' }}>
          <span className="hint t-12">준비되면 자동으로 넘어가요</span>
          <span className="spacer" />
          <button type="button" className="t-13 strong brand row" style={{ gap: 4 }} onClick={() => navigate('/C-120', { state: ticket })}>
            지금 넘어가기 <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <div className="c-narrow">
        {!ticket && <p className="field-error">접수한 문의 정보가 없어요. 1:1 문의에서 먼저 접수해 주세요.</p>}
        <Todo block what="접수 뒤 진행 상태를 고객 화면에 실시간으로 보여주기 (고객용 조회 API 없음) — 문의는 실제로 접수됐고, 위 단계 표시는 화면 구성이에요" />
      </div>
    </Shell>
  );
}

// ───────── C-110 · C-120 · C-130 · C-140 접수 뒤 화면 (화면 구성 · 기능 구현 필요) ─────────

function Mine({ ticket, title = '내 문의', done }: { ticket: Ticket | null; title?: string; done?: boolean }) {
  return (
    <section className="c-side">
      <b style={{ fontSize: 15 }}>{title}</b>
      <dl className="c-kv">
        <dt>문의 종류</dt>
        <dd>{ticket?.type ?? '—'}</dd>
        <dt>접수</dt>
        <dd>{ticket ? `오늘 ${hm(ticket.at)} · 웹` : '—'}</dd>
        {done && (
          <>
            <dt>처리</dt>
            <dd>
              <Todo what="처리 결과 · 걸린 시간" />
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** 원 3개를 선으로 이은 진행 표시 (C-120 · C-130) */
function Track({ at, sub }: { at: string; sub: string }) {
  return (
    <div className="c-track">
      <div className="done">
        <i>
          <Check size={14} />
        </i>
        <b>접수</b>
        {at}
      </div>
      <div className="now">
        <i>2</i>
        <b>확인 중</b>
        {sub}
      </div>
      <div>
        <i>3</i>
        <b>완료</b>
      </div>
    </div>
  );
}

const RATES = ['별로예요', '아쉬워요', '보통', '좋아요', '최고예요'];

export function After({ screen }: { screen: 'C-110' | 'C-120' | 'C-130' | 'C-140' }) {
  const navigate = useNavigate();
  const ticket = (useLocation().state as Ticket | null) ?? null;
  const [score, setScore] = useState(0);
  const [popup, setPopup] = useState<null | 'connect' | 'phone' | 'add' | 'thanks'>(null);
  const at = ticket ? hm(ticket.at) : '';
  const go = (to: string) => navigate(to, { state: ticket });
  const myBubble = (
    <p className="c-bubble is-me">
      <small>
        <b>내 문의</b>
        {at}
      </small>
      {ticket?.body ?? '접수한 문의 내용이 여기에 보여요'}
    </p>
  );
  const rateButtons = (
    <div className={`c-rate${screen === 'C-140' ? ' is-fixed' : ''}`}>
      {RATES.map((t, i) => (
        <button key={t} type="button" aria-pressed={score === i + 1} onClick={() => setScore(i + 1)}>
          <b>{i + 1}</b>
          {t}
        </button>
      ))}
      {screen === 'C-140' && <span className="hint t-12">선택하지 않아도 괜찮아요</span>}
    </div>
  );
  const previewNext =
    screen === 'C-110' ? undefined : screen === 'C-120' ? { to: '/C-130', text: '다음 화면 보기 (C-130)', state: ticket } : screen === 'C-130' ? { to: '/C-110', text: 'AI 바로 안내 화면 보기 (C-110)', state: ticket } : undefined;

  return (
    <Shell>
      <Preview
        next={previewNext}
        what={
          screen === 'C-110'
            ? 'AI 답변을 고객 화면에 보여주기 — 실제 답변은 이메일로 가요. 아래는 화면 구성이에요'
            : screen === 'C-120'
              ? '담당자 확인 상태 · 대기 순서 · 추가 메시지 — 아래는 화면 구성이에요'
              : screen === 'C-130'
                ? '담당자 답변 표시 · 만족도 평가 저장 — 아래는 화면 구성이에요'
                : '상담 완료 처리 · 평가 저장 — 아래는 화면 구성이에요'
        }
      />
      <div className="c-cols">
        <div>
          <section className="c-card">
            {screen === 'C-140' ? (
              <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
                <span className="c-doneicon">
                  <Check size={26} strokeWidth={3} color="#fff" />
                </span>
                <div>
                  <span className="hint t-12">
                    접수번호 <span className="mono">{ticketNo(ticket)}</span>
                  </span>
                  <span className="c-status is-ok" style={{ marginLeft: 8 }}>
                    <i className="dot dot-ok" />
                    상담 완료
                  </span>
                  <h1 className="c-h1" style={{ fontSize: 26, marginTop: 6 }}>
                    문의가 완료됐어요
                  </h1>
                  <p className="tertiary t-13" style={{ marginTop: 6 }}>
                    도움이 됐다니 다행이에요. 이 문의는 완료 처리됐어요.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="row">
                  <span className="hint t-12">
                    접수번호 <span className="mono">{ticketNo(ticket)}</span>
                  </span>
                  <span className="spacer" />
                  <span className={`c-status${screen === 'C-120' ? ' is-human' : screen === 'C-130' ? ' is-ok' : ''}`}>
                    <i className="dot" style={{ background: screen === 'C-120' ? 'var(--secondary-500)' : screen === 'C-110' ? 'var(--primary-500)' : 'var(--status-ok)' }} />
                    {screen === 'C-120' ? '담당자 확인 중' : '답변 도착'}
                  </span>
                </div>
                <h1 className="c-h1" style={{ fontSize: 26, marginTop: 10 }}>
                  {screen === 'C-110' ? '문의가 접수됐어요' : screen === 'C-120' ? '담당자가 확인하고 있어요' : '답변이 도착했어요'}
                </h1>
                <p className="tertiary t-13" style={{ marginTop: 6 }}>
                  {screen === 'C-110' && '고객센터 안내에 있는 내용은 바로 알려드려요. 금액이나 일정처럼 확인이 필요한 건 담당자가 이어받아요.'}
                  {screen === 'C-120' && '판단이 필요한 문의라, 담당자가 직접 확인한 뒤 답변을 보내드려요.'}
                  {screen === 'C-130' && '담당자가 확인한 답변이에요.'}
                </p>
              </>
            )}

            {screen === 'C-120' && <Track at={at} sub="담당자 확인 중" />}
            {screen === 'C-130' && <Track at={at} sub="답변 도착" />}
            {screen === 'C-140' && (
              <div className="c-tabtrack">
                <div>
                  <b>접수</b>
                  {at}
                </div>
                <div>
                  <b>확인 중</b>답변 도착
                </div>
                <div className="now">
                  <b>완료</b>상담 완료
                </div>
              </div>
            )}
            {screen !== 'C-140' && myBubble}

            {screen === 'C-110' && (
              <>
                <div className="c-bubble is-ai">
                  <small>
                    <span className="gnb-logo" style={{ width: 20, height: 20, marginRight: 8, verticalAlign: -5 }} aria-hidden>
                      <i style={{ width: 11, height: 5 }} />
                    </span>
                    <b>자동 안내</b>
                    {at} · 바로 답변
                  </small>
                  <Todo what="AI 답변 본문" />
                  <p className="row gap-8 t-12 hint" style={{ marginTop: 10 }}>
                    <span className="tag">참고</span>
                    <Todo what="참고한 고객센터 안내 조항" />
                  </p>
                </div>
                <div className="c-box">
                  <b style={{ fontSize: 15 }}>답변이 도움이 됐나요?</b>
                  <div className="c-grid2 keep" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-md btn-blueline" style={{ background: 'var(--secondary-50)' }} onClick={() => setPopup('connect')}>
                      상담원과 이야기할래요
                    </button>
                    <button type="button" className="btn btn-md btn-primary" onClick={() => go('/C-140')}>
                      네, 해결됐어요
                    </button>
                  </div>
                  <p className="hint t-12" style={{ marginTop: 10 }}>
                    판단이 필요한 내용은 담당자가 확인해요 · 상담원 연결 시간 <Todo what="운영 시간 · 평균 응답 시간" />
                  </p>
                </div>
              </>
            )}

            {screen === 'C-120' && (
              <>
                <p className="c-working">
                  <span>···</span>담당자가 문의 내용을 확인하고 있어요
                </p>
                <div className="c-waitbox">
                  <i className="dot" style={{ background: 'var(--secondary-500)' }} />
                  <span style={{ flex: 1 }}>
                    <b>
                      대기 순서 · 예상 응답 시각 <Todo what="대기 순서 · 예상 응답 시각" />
                    </b>
                    <span className="tertiary t-12" style={{ display: 'block' }}>
                      상담 가능 시간에 담당자가 확인해요
                    </span>
                  </span>
                  <button type="button" className="t-13 strong brand" disabled title="기능 구현 필요: 연결 요청 취소">
                    요청 취소
                  </button>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <span className="hint t-12">답변이 오면 이메일({ticket ? maskEmail(ticket.email) : '—'})로 알려드려요</span>
                  <span className="spacer" />
                  <button type="button" className="btn btn-sm btn-line" onClick={() => setPopup('add')}>
                    문의 내용 추가하기
                  </button>
                </div>
              </>
            )}

            {screen === 'C-130' && (
              <>
                <div className="c-bubble is-human">
                  <small>
                    <span className="avatar" style={{ width: 22, height: 22, fontSize: 11, marginRight: 8 }}>
                      상
                    </span>
                    <b>상담원</b>
                    <span className="c-status is-human" style={{ height: 20, marginRight: 8 }}>
                      담당자 확인
                    </span>
                  </small>
                  <Todo what="담당자 답변 본문" />
                </div>
                <p className="hint t-12" style={{ marginTop: 8 }}>
                  담당자가 확인한 답변이에요
                </p>
                <div className="c-box">
                  <b style={{ fontSize: 15 }}>이번 상담은 어떠셨나요?</b>
                  {rateButtons}
                  <input className="input" maxLength={300} placeholder="더 하고 싶은 말이 있다면 남겨주세요 (선택)" />
                  <div className="c-grid2 keep" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-md btn-line" onClick={() => setPopup('add')}>
                      <span className="c-long">추가로 문의할래요</span>
                      <span className="c-short">추가 문의</span>
                    </button>
                    <button type="button" className="btn btn-md btn-primary" onClick={() => setPopup('thanks')}>
                      해결됐어요
                    </button>
                  </div>
                </div>
              </>
            )}

            {screen === 'C-140' && (
              <div className="c-box">
                <p className="row gap-8 t-12 hint">
                  <span className="tag">받은 답변</span>
                  <Todo what="받은 답변 원문 · 참고한 안내 조항" />
                </p>
              </div>
            )}
          </section>

          {screen === 'C-140' && (
            <section className="c-card" style={{ marginTop: 16 }}>
              <b style={{ fontSize: 18 }}>이번 상담은 어떠셨나요?</b>
              <p className="hint t-12" style={{ marginTop: 4 }}>
                남겨주신 의견은 고객 목소리 리포트로 모여 상담 품질을 고치는 데 쓰여요.
              </p>
              {rateButtons}
              <textarea className="textarea" rows={2} maxLength={300} placeholder="더 하고 싶은 말이 있다면 남겨주세요 (선택)" />
              <div className="row gap-8" style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-md btn-line" onClick={() => navigate('/C-300')}>
                  그냥 마치기
                </button>
                <button type="button" className="btn btn-md btn-primary" disabled={!score} data-tip={!score ? '만족도를 고르면 눌러져요' : undefined} onClick={() => setPopup('thanks')}>
                  평가 남기고 마치기
                </button>
              </div>
            </section>
          )}
        </div>

        <aside>
          <Mine ticket={ticket} title={screen === 'C-140' ? '완료된 문의' : '내 문의'} done={screen === 'C-140'} />
          {screen === 'C-110' && (
            <div className="x-info" style={{ borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
              <b className="brand">이 답변은 AI가 작성했어요</b>
              <br />
              {COMPANY} 고객센터 안내를 근거로 답했어요. 틀린 내용이 있으면 상담원이 바로 이어받아요.
            </div>
          )}
          {screen === 'C-120' && (
            <div className="x-info">
              <b>왜 사람이 확인하나요?</b>
              <br />
              금액이나 판단이 필요한 문의는 담당자가 직접 확인하고 책임지고 답해요.
            </div>
          )}
          {screen === 'C-130' && (
            <section className="c-side">
              <b style={{ fontSize: 15 }}>다음엔 이렇게 돼요</b>
              <p className="tertiary t-12" style={{ marginTop: 8, lineHeight: '19px' }}>
                처리 진행 상황은 이메일로 알려드려요.
              </p>
            </section>
          )}
          {screen === 'C-140' && (
            <>
              <div className="x-info" style={{ borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
                <b className="brand">문제가 다시 생기면</b>
                <br />
                받으신 답변 메일에 답장하면 같은 문의로 이어져요.{' '}
                <Link to="/C-200" className="x-link">
                  내 문의 조회
                </Link>
              </div>
              <section className="c-side">
                <b style={{ fontSize: 15 }}>이런 것도 자주 찾아요</b>
                <div className="c-rows">
                  <Link to="/C-300">
                    <span>
                      <span className="tag" style={{ marginRight: 8 }}>
                        FAQ
                      </span>
                      자주 묻는 질문 보기
                    </span>
                    <ChevronRight size={16} />
                  </Link>
                  <Link to="/C-100" className="brand strong">
                    새 문의 접수하기 <ArrowRight size={15} />
                  </Link>
                </div>
              </section>
            </>
          )}
        </aside>
      </div>

      {popup === 'connect' && <ConnectModal onClose={() => setPopup(null)} onPhone={() => setPopup('phone')} />}
      {popup === 'phone' && <PhoneModal onClose={() => setPopup(null)} onBack={() => setPopup('connect')} />}
      {popup === 'add' && <AddModal ticket={ticket} onClose={() => setPopup(null)} />}
      {popup === 'thanks' && <ThanksModal ticket={ticket} onClose={() => setPopup(null)} />}
    </Shell>
  );
}

/** C-110-P01 상담원 연결 요청 */
function ConnectModal({ onClose, onPhone }: { onClose: () => void; onPhone: () => void }) {
  const [why, setWhy] = useState('');
  const REASONS = ['답변이 부족해요', '일정을 정하고 싶어요', '직접 이야기하고 싶어요'];
  return (
    <Modal onClose={onClose} width={560}>
      <span className="c-popicon is-blue">
        <Phone size={22} color="#333d4b" />
      </span>
      <h2 className="t-modal" style={{ marginTop: 14 }}>
        상담원에게 연결할게요
      </h2>
      <p className="modal-sub t-13">지금까지 나눈 대화는 그대로 넘어가요. 처음부터 다시 설명하지 않아도 돼요.</p>
      <span className="field-label" style={{ marginTop: 18 }}>
        어떤 점이 해결되지 않았나요?
      </span>
      <div className="x-chips">
        {REASONS.map((r) => (
          <button key={r} type="button" aria-pressed={why === r} onClick={() => setWhy(r)}>
            {r}
          </button>
        ))}
      </div>
      <span className="field-label" style={{ marginTop: 16 }}>
        상담원에게 남길 말 <span className="hint" style={{ fontWeight: 400 }}>선택</span>
      </span>
      <textarea className="textarea" rows={2} />
      <span className="field-label" style={{ marginTop: 16 }}>
        답변 받을 방법
      </span>
      <div className="segment" style={{ width: '100%' }}>
        <button type="button" style={{ flex: 1 }} aria-pressed="true">
          이 페이지 · 이메일
        </button>
        <button type="button" style={{ flex: 1 }} aria-pressed="false" onClick={onPhone}>
          전화 요청
        </button>
      </div>
      <div style={{ marginTop: 14 }}>
        <Todo block what="상담원 연결 요청 (고객 화면에서 사람에게 넘기는 API 없음) · 상담 가능 시간 · 평균 응답 시간" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-blue" disabled data-tip="연결 요청 기능이 아직 없어요">
          상담원 연결 요청
        </button>
      </div>
    </Modal>
  );
}

/** C-110-P02 전화 요청 · 상담원 번호 */
function PhoneModal({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  return (
    <Modal onClose={onClose} width={560}>
      <span className="c-popicon is-blue">
        <Phone size={22} color="#333d4b" />
      </span>
      <h2 className="t-modal" style={{ marginTop: 14 }}>
        전화로 도와드릴게요
      </h2>
      <p className="modal-sub t-13">아래 번호로 전화하시면 지금 문의 내용을 가진 상담원에게 바로 연결돼요. 따로 요청을 보내지 않으셔도 돼요.</p>
      <div className="c-phonebox">
        <span className="hint t-12">상담원 연결 번호</span>
        <b className="mono">
          <Todo what="고객센터 전화번호 · 연결 코드" />
        </b>
      </div>
      <div className="x-info" style={{ borderColor: 'var(--primary-100)', background: 'var(--primary-50)' }}>
        <b>전화로 받은 안내도 기록에 남아요</b>
        <br />
        통화가 끝나면 상담 내용을 정리해 이메일로 보내드려요.
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-blue" onClick={onBack}>
          뒤로가기
        </button>
      </div>
    </Modal>
  );
}

/** C-120-P01 문의 내용 추가하기 */
function AddModal({ ticket, onClose }: { ticket: Ticket | null; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal onClose={onClose} width={560}>
      <span className="c-popicon">
        <Pencil size={22} color="#5f5ce8" />
      </span>
      <h2 className="t-modal" style={{ marginTop: 14 }}>
        문의에 내용을 더 쓸게요
      </h2>
      <p className="modal-sub t-13">새 문의가 아니라 지금 문의에 이어 붙어요. 담당자가 지금까지 대화를 그대로 보고 있어요.</p>
      <div className="note row gap-8" style={{ marginTop: 14 }}>
        <span className="mono">{ticketNo(ticket)}</span>
        <b style={{ color: 'var(--gray-900)' }}>{ticket?.subject ?? '접수한 문의'}</b>
        <span className="spacer" />
        <span className="c-status is-human" style={{ height: 20 }}>
          담당자 확인 중
        </span>
      </div>
      <span className="field-label" style={{ marginTop: 16 }}>
        더 쓸 내용
      </span>
      <textarea className="textarea" rows={3} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} autoFocus />
      <div style={{ marginTop: 14 }}>
        <Todo block what="접수한 문의에 내용 · 파일 추가 (같은 메일 스레드로 답장하면 이어지지만, 웹에서 이어 쓰는 API는 없음)" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-primary" disabled data-tip="문의에 이어 쓰는 기능이 아직 없어요">
          문의에 추가하기
        </button>
      </div>
    </Modal>
  );
}

/** C-130-P01 · C-140-P01 평가 완료 */
function ThanksModal({ ticket, onClose }: { ticket: Ticket | null; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Modal onClose={onClose} width={520}>
      <div style={{ textAlign: 'center' }}>
        <span className="c-doneicon" style={{ margin: '0 auto' }}>
          <Check size={26} strokeWidth={3} color="#fff" />
        </span>
        <h2 className="t-modal" style={{ marginTop: 16 }}>
          평가 감사해요!
        </h2>
        <p className="modal-sub t-13">상담이 완료됐어요. 남겨주신 의견은 상담 품질을 고치는 데 쓰여요.</p>
      </div>
      <div className="note row gap-8" style={{ marginTop: 16 }}>
        <span className="c-status is-ok" style={{ height: 20 }}>
          <i className="dot dot-ok" />
          상담 완료
        </span>
        <span style={{ color: 'var(--gray-800)' }}>{ticket?.type ?? '문의'}</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <Todo block what="만족도 평가 저장 · 상담 완료 처리 — 평가는 아직 서버에 남지 않아요" />
      </div>
      <button type="button" className="btn btn-lg btn-primary btn-block" style={{ marginTop: 16 }} onClick={() => navigate('/Shop')}>
        {COMPANY} 홈으로 돌아가기 <ArrowUpRight size={15} />
      </button>
      <button type="button" className="btn btn-md btn-line btn-block" style={{ marginTop: 8 }} onClick={() => navigate('/C-200')}>
        내 문의 조회
      </button>
    </Modal>
  );
}

// ───────── C-200 내 문의 조회 (+ C-200_empty) ─────────

const RECENT_KEY = 'baton.c200.recent';
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function MyTickets() {
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const [recent, setRecent] = useState<string[]>(loadRecent);

  const search = (word: string) => {
    const w = word.trim();
    if (w.length < 2) return;
    setQ(w);
    setSearched(w);
    // 최근 찾은 말: 최근 3개 · 이 기기에만 저장 (C-200 스펙 ②)
    const next = [w, ...recent.filter((r) => r !== w)].slice(0, 3);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* 저장하지 못해도 검색은 된다 */
    }
  };

  return (
    <Shell>
      <div className="c-cols">
        <div>
          <section className="c-card">
            <h1 className="c-h1" style={{ fontSize: 24 }}>
              내 문의 조회
            </h1>
            <p className="tertiary t-13" style={{ margin: '6px 0 16px' }}>
              문의 내용에 들어간 말로 찾을 수 있어요. 접수번호를 몰라도 돼요.
            </p>
            <form
              className="c-search"
              onSubmit={(e) => {
                e.preventDefault();
                search(q);
              }}
            >
              <Search size={20} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="기억나는 말로 찾아보세요" />
              <button type="submit" className="btn btn-md btn-primary" disabled={q.trim().length < 2} data-tip={q.trim().length < 2 ? '2자 이상 적어 주세요' : undefined}>
                검색
              </button>
            </form>
            {recent.length > 0 && (
              <div className="row gap-8" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                <span className="hint t-12">최근 찾은 말</span>
                {recent.map((r) => (
                  <button key={r} type="button" className="c-chip" onClick={() => search(r)}>
                    {r}
                  </button>
                ))}
              </div>
            )}
          </section>

          {searched ? (
            <>
              <div className="row" style={{ margin: '20px 4px 10px' }}>
                <b>‘{searched}’ 검색 결과 0건</b>
                <span className="spacer" />
                <span className="hint t-12">최근 6개월</span>
              </div>
              <section className="c-card" style={{ textAlign: 'center' }}>
                <span className="c-popicon is-gray" style={{ margin: '0 auto' }}>
                  <Search size={22} color="#8490a0" />
                </span>
                <b style={{ display: 'block', marginTop: 14, fontSize: 16 }}>찾는 문의가 없어요</b>
                <p className="tertiary t-13" style={{ marginTop: 6, lineHeight: '21px' }}>
                  다른 말로 찾아보시거나, 최근 6개월 안에 남긴 문의인지 확인해 주세요.
                </p>
                <div className="row gap-8" style={{ justifyContent: 'center', marginTop: 16 }}>
                  <button
                    type="button"
                    className="btn btn-md btn-line"
                    onClick={() => {
                      setSearched('');
                      setQ('');
                    }}
                  >
                    전체 문의 보기
                  </button>
                  <Link to="/C-100" className="btn btn-md btn-primary">
                    새 문의 접수하기
                  </Link>
                </div>
              </section>
            </>
          ) : (
            <div className="row" style={{ margin: '20px 4px 10px' }}>
              <b>찾은 문의</b>
              <span className="spacer" />
              <span className="hint t-12">최근 6개월</span>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <Todo block what="고객 본인 확인 · 내 문의 목록(상태 칩 · 갱신 시각) · 문의 상세 팝업 3종 · 다시 문의 (고객용 조회 API 없음) — 그래서 검색해도 항상 0건이에요" />
          </div>
        </div>
        <aside>
          <section className="c-side">
            <b style={{ fontSize: 15 }}>새 문의가 필요하신가요?</b>
            <p className="tertiary t-12" style={{ margin: '6px 0 12px' }}>
              문의 종류를 고르면 필요한 정보만 물어볼게요.
            </p>
            <Link to="/C-100" className="btn btn-md btn-soft btn-block">
              새 문의 접수하기
            </Link>
          </section>
          <p className="hint t-12" style={{ margin: '14px 4px' }}>
            답변이 도착하면 접수할 때 남긴 이메일로도 알려드려요.
          </p>
        </aside>
      </div>
    </Shell>
  );
}

// ───────── C-300 자주 묻는 질문 / C-310 검색 결과 ─────────

function FaqCta() {
  return (
    <section className="c-cta">
      <span className="c-popicon" style={{ background: 'rgba(255,255,255,0.12)' }}>
        <MessageSquare size={22} color="#fff" />
      </span>
      <span style={{ flex: 1, minWidth: 200 }}>
        <b style={{ fontSize: 16 }}>원하는 답을 못 찾으셨나요?</b>
        <span style={{ display: 'block', marginTop: 4, fontSize: 13, opacity: 0.75 }}>1:1 문의를 남기면 바로 안내드리고, 필요하면 상담원이 이어받아요</span>
      </span>
      <Link to="/C-200" className="btn btn-md" style={{ background: 'var(--gray-700)', color: '#fff' }}>
        내 문의 조회
      </Link>
      <Link to="/C-100" className="btn btn-md btn-primary">
        1:1 문의하기
      </Link>
    </section>
  );
}

export function Faq({ results }: { results?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  const [q, setQ] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) navigate(`/C-310?q=${encodeURIComponent(q.trim())}`);
  };

  if (results) {
    // C-310: 히어로 없이 검색창이 맨 위 · 결과 왼쪽, 안내 오른쪽
    return (
      <Shell>
        <form className="c-search" onSubmit={submit}>
          <Search size={20} />
          <input value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" aria-label="지우기" onClick={() => setQ('')}>
              <X size={18} color="#8490a0" />
            </button>
          )}
          <button type="submit" className="btn btn-md btn-primary">
            검색
          </button>
        </form>
        <div className="c-cols" style={{ marginTop: 20 }}>
          <div>
            <div className="row" style={{ margin: '0 4px 10px' }}>
              <b>‘{initial}’ 검색 결과 0건</b>
            </div>
            <section className="c-card" style={{ textAlign: 'center' }}>
              <b style={{ fontSize: 16 }}>찾는 답이 없나요?</b>
              <p className="tertiary t-13" style={{ margin: '6px 0 16px' }}>
                1:1 문의로 남겨주시면 바로 안내하거나 담당자가 확인해서 답변드려요.
              </p>
              {/* 아니요 → C-100 (검색어를 제목에 채움) — C-310 스펙 ⑤ */}
              <Link to="/C-100" state={{ subject: initial.slice(0, 40) }} className="btn btn-md btn-primary">
                이 내용으로 1:1 문의하기 <ChevronRight size={15} />
              </Link>
            </section>
            <div style={{ marginTop: 12 }}>
              <Todo block what="FAQ 검색 · 결과 목록(검색어 강조 · 도움이 됐나요) (고객에게 공개하는 FAQ API 없음) — 그래서 항상 0건이에요" />
            </div>
          </div>
          <aside>
            <section className="c-side">
              <b style={{ fontSize: 15 }}>다른 방법으로 찾기</b>
              <div className="c-rows">
                <Link to="/C-300">
                  자주 묻는 질문 전체 보기 <ChevronRight size={16} />
                </Link>
                <Link to="/C-200">
                  내 문의 조회 <ChevronRight size={16} />
                </Link>
              </div>
            </section>
          </aside>
        </div>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <section className="c-hero">
        <b className="brand t-12">{COMPANY} 고객센터</b>
        <h1 className="c-h1" style={{ fontSize: 32, marginTop: 6 }}>
          무엇이 궁금하세요?
        </h1>
        <form className="c-search" onSubmit={submit}>
          <Search size={20} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="궁금한 내용을 검색해 보세요" />
          <button type="submit" className="btn btn-md btn-primary">
            검색
          </button>
        </form>
        <p className="row gap-8 hint t-12" style={{ justifyContent: 'center', marginTop: 14 }}>
          많이 찾는 검색어 <Todo what="많이 찾는 검색어 (최근 7일 상위 5개)" />
        </p>
      </section>
      <main className="c-main">
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <span className="c-chip is-on">전체</span>
          <Todo what="FAQ 분류와 질문 수" />
        </div>
        <section className="c-card" style={{ marginTop: 16 }}>
          <div className="row">
            <b style={{ fontSize: 17 }}>자주 찾는 질문 TOP 5</b>
            <span className="spacer" />
            <span className="hint t-12">이번 주 조회 기준</span>
          </div>
          <div style={{ marginTop: 14 }}>
            <Todo block what="고객용 FAQ 목록 · 분류 · 조회수 기준 TOP 5 · 질문 펼치기 (매뉴얼은 관리자 화면에서만 읽을 수 있음)" />
          </div>
        </section>
        <div className="row gap-8" style={{ margin: '24px 4px 12px', alignItems: 'baseline' }}>
          <b style={{ fontSize: 18 }}>전체 질문</b>
          <span className="hint t-12">분류별</span>
        </div>
        <Todo block what="분류별 전체 질문 목록" />
        <FaqCta />
      </main>
    </Shell>
  );
}

// ───────── Shop · Orders (고객센터로 들어가는 과정만 — Figma 코멘트 #4 · #5) ─────────

export function Shop() {
  return (
    <div style={{ minHeight: '100%', background: '#fff' }}>
      <header className="c-top">
        <div className="c-top-in">
          <span className="c-brand">
            <span className="gnb-company-mark" aria-hidden>
              A
            </span>
            <b>{COMPANY}</b>
          </span>
          <div className="c-top-right keep">
            <Link to="/Orders" className="btn btn-sm btn-line">
              내 계정
            </Link>
            <Link to="/C-300" className="btn btn-sm btn-primary">
              고객센터
            </Link>
          </div>
        </div>
      </header>
      <section className="c-shop-hero">
        <h1>
          팀의 반복 업무를
          <br />
          {COMPANY}가 대신합니다
        </h1>
        <p style={{ margin: '14px 0 28px', opacity: 0.85 }}>업무 협업 플랫폼 {COMPANY}</p>
        <Link to="/C-300" className="btn btn-lg" style={{ background: '#fff', color: 'var(--primary-500)' }}>
          고객센터 바로가기 <ArrowRight size={16} />
        </Link>
      </section>
      <p className="hint t-12" style={{ padding: 24, textAlign: 'center' }}>
        고객센터로 들어가는 과정을 보여주기 위한 랜딩 페이지예요.
      </p>
    </div>
  );
}

export function Orders() {
  return (
    <div style={{ minHeight: '100%' }}>
      <header className="c-top">
        <div className="c-top-in">
          <Link to="/Shop" className="c-brand">
            <span className="gnb-company-mark" aria-hidden>
              A
            </span>
            <b>{COMPANY}</b>
            <i />내 계정
          </Link>
          <div className="c-top-right keep">
            <Link to="/C-200" className="btn btn-sm btn-line">
              1:1 문의 내역
            </Link>
          </div>
        </div>
      </header>
      <main className="c-main">
        <section className="c-card c-narrow" style={{ textAlign: 'center' }}>
          <h1 className="c-h1" style={{ fontSize: 22 }}>
            이용 내역
          </h1>
          <p className="tertiary t-13" style={{ margin: '8px 0 20px' }}>
            1:1 문의하기를 누르면 고객센터 문의 화면이 열려요.
          </p>
          <Link to="/C-100" className="btn btn-md btn-soft">
            1:1 문의하기
          </Link>
        </section>
        <section className="c-card c-narrow row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <b>이용 내역과 상관없는 문의인가요?</b>
            <span className="tertiary t-13" style={{ display: 'block', marginTop: 4 }}>
              자주 묻는 질문에서 먼저 찾아보고, 없으면 1:1 문의를 남겨주세요.
            </span>
          </span>
          <Link to="/C-300" className="btn btn-md btn-line">
            고객센터 가기
          </Link>
        </section>
      </main>
    </div>
  );
}
