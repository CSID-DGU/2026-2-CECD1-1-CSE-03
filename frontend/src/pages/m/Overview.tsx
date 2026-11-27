import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { errorText } from '../../lib/api';
import { loadCases, useLive, useNow, type InboxCase } from '../../lib/hooks';
import { fullTime, hm, shortNo, waitText } from '../../lib/format';
import { Todo } from '../../components/ui';
import { waitOf, waitingSince } from '../a/model';
import { STAGES, assigneeOf, closedAt, closedByHuman, closedToday, receivedToday, stageDetail, stageOf, type Stage } from './model';
import './m.css';

/** M-100 운영 현황 · 팀 전체 / M-101 운영 현황 · 상담원별 */
export function Overview({ view }: { view: 'team' | 'agents' }) {
  const navigate = useNavigate();
  const now = useNow();
  const { data, error, loading } = useLive(loadCases, []);
  const all = useMemo(() => data ?? [], [data]);

  const today = all.filter(receivedToday);
  const closed = all.filter(closedToday);
  const byOrigin = (o: string) => today.filter((c) => c.origin === o).length;

  return (
    <main className="page">
      <div className="row">
        <div>
          <h1 className="t-h1">운영 현황</h1>
          <p className="hint t-13" style={{ marginTop: 6 }}>
            BATON이 자동 배정한 결과를 확인하고, 사람이 정해야 하는 건만 처리해요
          </p>
        </div>
        <span className="spacer" />
        <div className="segment" role="group" aria-label="보기 전환">
          <button type="button" aria-pressed={view === 'team'} onClick={() => navigate('/M-100')}>
            팀 전체 현황
          </button>
          <button type="button" aria-pressed={view === 'agents'} onClick={() => navigate('/M-101')}>
            상담원별 현황
          </button>
        </div>
      </div>

      {error ? (
        <div className="card error-box" style={{ marginTop: 18 }}>{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading" style={{ marginTop: 18 }}>불러오는 중…</div>
      ) : view === 'agents' ? (
        <AgentTable all={all} />
      ) : (
        <>
          <div className="m-summary">
            <Link to="/M-200" className="card m-sum">
              <span className="row">
                <i className="dot dot-risk" style={{ marginRight: 8 }} />
                <b>관리자 이관</b>
                <span className="spacer" />
                <span className="m-sum-link">
                  검토 대기 목록 <ArrowRight size={12} strokeWidth={2} />
                </span>
              </span>
              <span className="m-sum-num">
                <Todo what="상담원 → 관리자 이관 건수" />
              </span>
              <span className="hint t-12">상담원이 넘긴 문의 · 가장 오래 기다린 시간</span>
            </Link>
            <Link to="/M-110?period=received" className="card m-sum">
              <span className="row">
                <b>오늘 접수 중</b>
                <span className="spacer" />
                <span className="m-sum-link">
                  오늘 접수한 문의 <ArrowRight size={12} strokeWidth={2} />
                </span>
              </span>
              <span className="m-sum-num">
                {today.length}
                <small>건</small>
              </span>
              <span className="hint t-12">
                하루 기준 00:00 ~ 23:59 · 웹 {byOrigin('Web')} · 이메일 {byOrigin('Email')}
              </span>
            </Link>
            <Link to="/M-110?period=closed" className="card m-sum">
              <span className="row">
                <b>오늘 종결</b>
                <span className="spacer" />
                <span className="m-sum-link">
                  오늘 종결한 문의 <ArrowRight size={12} strokeWidth={2} />
                </span>
              </span>
              <span className="m-sum-num">
                {closed.length}
                <small>건</small>
              </span>
              <span className="hint t-12">
                하루 기준 00:00 ~ 23:59 · AI 자동 종결 {closed.filter((c) => !closedByHuman(c)).length} · 사람 종결 {closed.filter(closedByHuman).length}
              </span>
            </Link>
          </div>

          <h2 className="t-h3" style={{ marginTop: 22 }}>
            팀 전체 현황
          </h2>
          <div className="m-board">
            {STAGES.map((s) => (
              <StageColumn key={s.key} stage={s.key} label={s.label} desc={s.desc} all={all} now={now} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function StageColumn({ stage, label, desc, all, now }: { stage: Stage; label: string; desc: string; all: InboxCase[]; now: Date }) {
  const navigate = useNavigate();
  // 종결 열은 오늘 종결한 건만, 최근 순. 나머지는 오래 기다린 순.
  const list = all
    .filter((c) => stageOf(c) === stage && (stage !== 'closed' || closedToday(c)))
    .sort((a, b) => (stage === 'closed' ? closedAt(b).localeCompare(closedAt(a)) : waitOf(b, now) - waitOf(a, now)));
  return (
    <section className="m-col">
      <header>
        <b>{label}</b>
        <span className="m-col-count">{list.length}</span>
      </header>
      <p className="hint t-12">
        {stage === 'human'
          ? `초안 승인 대기 ${list.filter((c) => c.subStatus === 'Awaiting Approval').length}건 · 사람 처리 ${list.filter((c) => c.subStatus !== 'Awaiting Approval').length}건`
          : stage === 'closed'
            ? `AI 자동 종결 ${list.filter((c) => !closedByHuman(c)).length} · 사람 종결 ${list.filter(closedByHuman).length}`
            : desc}
      </p>
      {list.map((c) => {
        const who = assigneeOf(c);
        const min = waitOf(c, now);
        const byAi = stage === 'ai' || (stage === 'closed' && !closedByHuman(c)) || (stage === 'wait' && c.resolution.outcome === 'auto_answered');
        return (
          <article key={c.id} className="m-kcard" onClick={() => navigate(`/M-111/${c.id}`)}>
            <div className="row">
              <span className="mono hint t-12">{shortNo(c.caseNumber)}</span>
              {stage === 'human' && <span className={`tag${c.subStatus === 'Awaiting Approval' ? ' tag-purple' : ''}`} style={{ marginLeft: 8 }}>{stageDetail(c)}</span>}
              {stage === 'closed' && <span className={`tag${byAi ? ' tag-purple' : ''}`} style={{ marginLeft: 8 }}>{stageDetail(c)}</span>}
              <span className="spacer" />
              {stage === 'closed' ? (
                <span className="hint t-12" title={fullTime(closedAt(c))}>
                  종결 {hm(closedAt(c))}
                </span>
              ) : (
                <span className={`t-12 ${stage === 'human' && min >= 60 ? 'risk strong' : 'hint'}`} title={fullTime(waitingSince(c))}>
                  {waitText(min)}
                </span>
              )}
            </div>
            <h3>{c.subject || '(제목 없음)'}</h3>
            <p className="row gap-8 t-12 strong">
              {stage === 'new' ? (
                '분류 중'
              ) : byAi ? (
                <>
                  <span className="avatar m-av is-ai">A</span>
                  {stage === 'closed' ? 'AI 자동 종결' : stage === 'wait' ? 'AI 발송' : 'AI'}
                </>
              ) : who ? (
                <>
                  <span className="avatar m-av">{who.slice(0, 1)}</span>
                  {who}
                </>
              ) : (
                <span className="hint" style={{ fontWeight: 400 }}>
                  담당 없음
                </span>
              )}
            </p>
          </article>
        );
      })}
      {!list.length && <div className="empty" style={{ padding: '28px 8px' }}>없어요</div>}
    </section>
  );
}

function AgentTable({ all }: { all: InboxCase[] }) {
  const navigate = useNavigate();
  const rows = useMemo(() => {
    const names = [...new Set(all.map(assigneeOf).filter((n): n is string => Boolean(n)))];
    return names
      .map((name) => {
        const mine = all.filter((c) => assigneeOf(c) === name);
        return { name, open: mine.filter((c) => c.status !== 'Closed').length, closed: mine.filter(closedToday).length };
      })
      .sort((a, b) => b.open - a.open);
  }, [all]);
  const max = Math.max(1, ...rows.map((r) => r.open));

  return (
    <>
      <div className="row gap-10" style={{ marginTop: 20 }}>
        <h2 className="t-h3">상담원별 현황</h2>
        <span className="hint t-12">행을 누르면 팀 문의함이 그 상담원으로 필터링돼요</span>
      </div>
      <div className="table-wrap table-card" style={{ marginTop: 10 }}>
        <table className="table m-agents">
          <thead>
            <tr>
              <th>상담원</th>
              <th>근무 상태</th>
              <th>열린 문의 수</th>
              <th>오늘 종결 수</th>
              <th>오늘 고감정 응대</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ratio = r.open / max;
              return (
                <tr key={r.name} onClick={() => navigate(`/M-110?assignee=${encodeURIComponent(r.name)}&stage=human`)}>
                  <td>
                    <span className="row gap-10" style={{ justifyContent: 'center' }}>
                      <span className="avatar m-av">{r.name.slice(0, 1)}</span>
                      <span style={{ color: 'var(--gray-900)' }}>{r.name}</span>
                    </span>
                  </td>
                  <td>
                    <span className="hint">—</span>
                  </td>
                  <td>
                    <span className="row gap-10">
                      <span className="m-bar">
                        <i style={{ width: `${ratio * 100}%`, background: ratio > 0.75 ? 'var(--status-risk)' : ratio > 0.45 ? 'var(--status-wait)' : 'var(--primary-500)' }} />
                      </span>
                      <b style={{ color: 'var(--gray-900)' }}>{r.open}건</b>
                    </span>
                  </td>
                  <td>{r.closed}건</td>
                  <td>
                    <span className="hint">—</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="empty">아직 사람이 맡은 문의가 없어요 · 상담원이 인수하거나 답변하면 여기에 나타나요</div>}
      </div>
      <div style={{ marginTop: 12 }}>
        <Todo block what="상담원 목록 · 근무 상태 · 오늘 고감정 응대 (팀 · 근무 정보가 백엔드에 없음) — 지금은 문의를 맡은 적 있는 이름만 보여요" />
      </div>
    </>
  );
}
