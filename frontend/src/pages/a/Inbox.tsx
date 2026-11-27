import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Search } from 'lucide-react';
import { errorText } from '../../lib/api';
import { loadCases, useLive, useNow, useScrollRestore, type InboxCase } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { ORIGIN_LABEL, REASON_LABEL, label } from '../../lib/labels';
import { fullTime, isToday, relTime, shortNo, waitMinutes, waitText } from '../../lib/format';
import { Sentiment, Todo } from '../../components/ui';
import {
  assignReason,
  bucketOf,
  firstToSee,
  lastReply,
  hasNewReply,
  matches,
  reviewReason,
  sortCases,
  waitOf,
  waitingSince,
  type FirstCard,
  type SortKey,
} from './model';
import './a.css';

type Tab = 'need' | 'wait';

/** A-100 문의함 · 목록 / A-101 고객 회신 대기 탭 / A-110 칸반 */
export function Inbox({ view, tab = 'need' }: { view: 'list' | 'kanban'; tab?: Tab }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const now = useNow();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const { data, error, loading } = useLive(loadCases, []);
  useScrollRestore(view === 'kanban' ? 'A-110' : tab === 'wait' ? 'A-101' : 'A-100', Boolean(data));

  const all = data ?? [];
  const need = useMemo(() => all.filter((c) => bucketOf(c) === 'need'), [all]);
  const wait = useMemo(() => all.filter((c) => bucketOf(c) === 'wait'), [all]);
  const closedToday = useMemo(() => all.filter((c) => c.status === 'Closed' && isToday(c.raw?.closed_at)).length, [all]);
  const first = useMemo(() => firstToSee(all, now), [all, now]);
  // 먼저 볼 건에 든 건은 목록 행 · 칸반 카드도 같은 옅은 색 (위험 = 빨강, 아니면 파랑)
  const firstIds = useMemo(() => new Map(first.map((f) => [f.c.id, f.risk])), [first]);

  const show = (list: InboxCase[]) => sortCases(list.filter((c) => matches(c, q)), sort, now);
  const needShown = show(need);
  const waitShown = show(wait);

  const here = view === 'kanban' ? '/A-110' : tab === 'wait' ? '/A-101' : '/A-100';
  const open = (c: InboxCase) => navigate(`/A-200/${c.id}`, { state: { from: here } });

  const switchView = (v: 'list' | 'kanban') => {
    try {
      localStorage.setItem('baton.inboxView', v);
    } catch {
      /* 기억하지 못해도 화면은 바뀐다 */
    }
    navigate(v === 'kanban' ? '/A-110' : '/A-100');
  };

  return (
    <main className="page">
      <h1 className="t-h1">{session?.name} 님의 문의함</h1>

      <section className="card a-stats">
        <div>
          현재 진행 중인 상담 <b>{need.length + wait.length}</b> 개
        </div>
        <i />
        <div>
          오늘 처리 <b>{closedToday}</b> 건
        </div>
        <span className="spacer" />
        <Todo what="상담원별 배정 — 지금은 팀 전체 문의가 보여요" />
      </section>

      <div className="row gap-10 a-toolbar">
        <label className="a-search">
          <Search size={16} strokeWidth={1.75} color="#8490a0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="번호 · 제목 · 고객 이름 · 내용으로 찾기" />
        </label>
        <div className="segment" role="group" aria-label="정렬">
          <button type="button" aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>
            최신 접수순
          </button>
          <button type="button" aria-pressed={sort === 'longest'} onClick={() => setSort('longest')}>
            오래 기다린 순
          </button>
        </div>
        <span className="spacer" />
        <div className="segment" role="group" aria-label="보기 전환">
          <button type="button" aria-pressed={view === 'list'} onClick={() => switchView('list')}>
            목록
          </button>
          <button type="button" aria-pressed={view === 'kanban'} onClick={() => switchView('kanban')}>
            칸반
          </button>
        </div>
      </div>

      {error ? (
        <div className="card error-box">{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading">불러오는 중…</div>
      ) : (
        <div className="a-body">
          <div className="a-main">
            {view === 'list' ? (
              <>
                <div className="tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={tab === 'need'} onClick={() => navigate('/A-100')}>
                    답변 필요 <span className={`count${tab === 'need' ? ' count-dark' : ''}`}>{need.length}</span>
                  </button>
                  <button type="button" role="tab" aria-selected={tab === 'wait'} onClick={() => navigate('/A-101')}>
                    고객 회신 대기 <span className={`count${tab === 'wait' ? ' count-dark' : ''}`}>{wait.length}</span>
                  </button>
                </div>
                <ListTable rows={tab === 'need' ? needShown : waitShown} tab={tab} me={session?.name} firstIds={firstIds} now={now} onOpen={open} searching={q.trim().length >= 2} />
                {tab === 'need' && (
                  <p className="hint t-12" style={{ marginTop: 10 }}>
                    대기 시간은 접수 뒤 지난 시간 그대로예요 <Todo what="운영 시간 기준 대기 시간 · ‘업무 외 접수’ 표시 (운영 시간 설정이 백엔드에 없음)" />
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="a-kanban">
                  <KanbanColumn title="답변 필요" count={need.length}>
                    {needShown.map((c) => (
                      <KanbanCard key={c.id} c={c} now={now} first={firstIds.get(c.id)} onOpen={open} />
                    ))}
                    {!needShown.length && <div className="empty">답변이 필요한 문의가 없어요</div>}
                  </KanbanColumn>
                  <KanbanColumn title="고객 회신 대기" count={wait.length}>
                    {waitShown.map((c) => (
                      <KanbanCard key={c.id} c={c} now={now} onOpen={open} />
                    ))}
                    {!waitShown.length && <div className="empty">고객 답을 기다리는 문의가 없어요</div>}
                  </KanbanColumn>
                </div>
                <p className="a-kanban-note">
                  카드는 끌어서 옮길 수 없어요 · 상태는 발송, 종결, 고객 답장으로만 바뀌어요 · 종결한 문의는 내 처리 내역에서 볼 수 있어요
                </p>
              </>
            )}
          </div>
          <FirstPanel cards={first} now={now} onOpen={open} />
        </div>
      )}
    </main>
  );
}

function ListTable({
  rows,
  tab,
  me,
  firstIds,
  now,
  onOpen,
  searching,
}: {
  rows: InboxCase[];
  tab: Tab;
  me?: string;
  firstIds: Map<string, boolean>;
  now: Date;
  onOpen: (c: InboxCase) => void;
  searching: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>번호</th>
            <th className="left">제목 · 고객</th>
            <th>검토 사유</th>
            <th>카테고리</th>
            <th>감정</th>
            <th>{tab === 'wait' ? '자동 종결' : '마지막 응답'}</th>
            <th>배정 이유</th>
            <th>대기 시간</th>
            <th>작업</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const reason = reviewReason(c);
            const assign = assignReason(c);
            const min = waitOf(c, now);
            const firstRisk = tab === 'need' ? firstIds.get(c.id) : undefined;
            const reply = lastReply(c, me);
            return (
              <tr key={c.id} className={firstRisk === undefined ? '' : firstRisk ? 'is-first' : 'is-first-blue'} onClick={() => onOpen(c)}>
                <td className="mono hint t-12">{shortNo(c.caseNumber)}</td>
                <td className="left">
                  <div className="cell-title">{c.subject || '(제목 없음)'}</div>
                  <div className="cell-sub">
                    {c.suppliedName ?? c.suppliedEmail ?? '고객'} 고객 · {label(ORIGIN_LABEL, c.origin)}
                  </div>
                </td>
                <td>{tab === 'need' && reason ? <span className={`tag${reason.risk ? ' tag-risk' : ''}`}>{reason.text}</span> : <span className="hint t-12">—</span>}</td>
                <td>
                  <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
                </td>
                <td>
                  <Sentiment value={c.signals?.sentiment} />
                </td>
                {tab === 'wait' ? (
                  <td>
                    <Todo what="자동 종결 예정일 조회 (서버 AUTO_CLOSE_DAYS 값이 API에 없음)" />
                  </td>
                ) : (
                  <td title={reply ? fullTime(reply.at) : undefined}>{reply ? `${reply.who} · ${relTime(reply.at, now)}` : <span className="hint">응답 없음</span>}</td>
                )}
                <td>
                  {tab === 'wait' ? (
                    <span className="tag tag-purple">{reply?.who === '내 답변' ? '내가 발송' : reply?.who === '상담원 답변' ? '상담원 발송' : 'AI 발송'}</span>
                  ) : assign ? (
                    <span className="tag tag-purple">{assign}</span>
                  ) : (
                    <span className="hint t-12">—</span>
                  )}
                </td>
                <td title={fullTime(waitingSince(c))}>
                  {tab === 'wait' ? (
                    <span style={{ fontWeight: 500 }}>{waitText(waitMinutes(c.raw?.lastMessageAt ?? c.audit.updatedAt, now))}</span>
                  ) : (
                    <span className={min >= 60 ? 'risk strong' : ''} style={{ fontWeight: min >= 60 ? 700 : 500 }}>
                      {waitText(min)}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className={`btn btn-sm ${tab === 'wait' ? 'btn-line' : 'btn-primary'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(c);
                    }}
                  >
                    {tab === 'wait' ? '보기' : '응답하기'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty">
          {searching ? '검색 결과가 없어요' : tab === 'need' ? '답변이 필요한 문의가 없어요' : '고객 답을 기다리는 문의가 없어요'}
        </div>
      )}
    </div>
  );
}

function KanbanColumn({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="a-col">
      <header>
        <b>{title}</b>
        <span className="a-col-count">{count}</span>
      </header>
      {children}
    </section>
  );
}

function KanbanCard({ c, now, first, onOpen }: { c: InboxCase; now: Date; first?: boolean; onOpen: (c: InboxCase) => void }) {
  const bucket = bucketOf(c);
  const reason = reviewReason(c);
  const min = waitOf(c, now);
  const fresh = hasNewReply(c);
  const tone = first === undefined ? '' : first ? ' is-risk' : ' is-new';
  return (
    <article className={`a-kcard${tone}`} onClick={() => onOpen(c)}>
      <div className="row">
        <span className="mono hint t-12">{shortNo(c.caseNumber)}</span>
        {fresh && (
          <span className="tag tag-line" style={{ marginLeft: 8 }}>
            새 답장
          </span>
        )}
        <span className="spacer" />
        <span className={`t-12${bucket === 'need' && min >= 60 ? ' risk strong' : ''}`} title={fullTime(waitingSince(c))}>
          대기 {waitText(min)}
        </span>
      </div>
      <h3>{c.subject || '(제목 없음)'}</h3>
      <p className="hint t-12">
        {c.suppliedName ?? c.suppliedEmail ?? '고객'} 고객 · {label(ORIGIN_LABEL, c.origin)}
      </p>
      <div className="row a-kcard-tags">
        <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
        <Sentiment value={c.signals?.sentiment} />
        {bucket === 'need' && reason && <span className={`tag${reason.risk ? ' tag-risk' : ''}`}>{reason.text}</span>}
      </div>
      <p className="a-kcard-state">{bucket === 'need' ? '답변 필요' : '고객 회신 대기'}</p>
      {bucket === 'need' ? (
        <button type="button" className="btn btn-sm btn-primary btn-block">
          응답하기
        </button>
      ) : (
        <p className="hint t-12">
          자동 종결 예정일 <Todo what="자동 종결 예정일 조회 (서버 AUTO_CLOSE_DAYS 값이 API에 없음)" />
        </p>
      )}
    </article>
  );
}

function FirstPanel({ cards, now, onOpen }: { cards: FirstCard[]; now: Date; onOpen: (c: InboxCase) => void }) {
  return (
    <aside className="a-first">
      <div className="row">
        <h2 className="t-h2">먼저 볼 건</h2>
        <span className="spacer" />
        <span className="a-first-count">{cards.length} 건</span>
      </div>
      <p className="hint t-12" style={{ lineHeight: '18px', marginTop: 10 }}>
        새 답장 · 위험 신호 · 감정이 높은 건이에요
        <br />
        누르면 바로 응대 화면으로 가요
      </p>
      {cards.map(({ c, tag, risk, why }) => (
        <button type="button" key={c.id} className={`a-fcard${risk ? ' is-risk' : ''}`} onClick={() => onOpen(c)}>
          <span className="a-fcard-title">
            <span className="mono hint t-12">{shortNo(c.caseNumber)}</span>
            <b>{c.subject || '(제목 없음)'}</b>
          </span>
          <span className={`tag${risk ? ' tag-risk' : ''}`}>{tag}</span>
          <span className="hint t-12 a-fcard-why">{[why, `대기 ${waitText(waitOf(c, now))}`].filter(Boolean).join(' · ')}</span>
          <span className="a-fcard-go">
            바로 응대 <ArrowRight size={13} strokeWidth={2} />
          </span>
        </button>
      ))}
      {!cards.length && <div className="empty">먼저 볼 건이 없어요</div>}
    </aside>
  );
}
