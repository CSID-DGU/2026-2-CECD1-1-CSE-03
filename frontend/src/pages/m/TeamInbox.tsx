import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { errorText } from '../../lib/api';
import { loadCases, useLive, useNow, useScrollRestore, type InboxCase } from '../../lib/hooks';
import { ORIGIN_LABEL, REASON_LABEL, label } from '../../lib/labels';
import { fullTime, relTime, shortNo, waitText } from '../../lib/format';
import { Sentiment } from '../../components/ui';
import { assignReason, lastReply, matches, reviewReason, waitOf, waitingSince } from '../a/model';
import { STAGES, STAGE_LABEL, assigneeOf, closedAt, closedToday, receivedToday, stageDetail, stageOf, type Stage } from './model';
import './m.css';

const STAGE_DOT: Record<Stage, string> = { new: '', ai: 'var(--primary-500)', human: 'var(--secondary-500)', wait: 'var(--status-wait)', closed: 'var(--status-ok)' };
const STAGE_ORDER: Stage[] = ['human', 'new', 'ai', 'wait', 'closed'];

/** M-110 팀 문의함 · 전체 목록 (오늘 접수 · 오늘 종결 · 담당자 필터는 같은 화면의 필터 값) */
export function TeamInbox() {
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const { data, error, loading } = useLive(loadCases, []);
  const all = useMemo(() => data ?? [], [data]);
  useScrollRestore('M-110', Boolean(data));

  const f = {
    period: params.get('period') ?? '',
    stage: params.get('stage') ?? '',
    assignee: params.get('assignee') ?? '',
    reason: params.get('reason') ?? '',
    origin: params.get('origin') ?? '',
  };
  const set = (key: keyof typeof f, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const filtered = Object.values(f).some(Boolean);

  const assignees = useMemo(() => [...new Set(all.map(assigneeOf).filter((n): n is string => Boolean(n)))].sort(), [all]);
  const reasons = useMemo(() => [...new Set(all.map((c) => c.caseReason).filter(Boolean))].sort(), [all]);

  const rows = useMemo(
    () =>
      all
        .filter(
          (c) =>
            matches(c, q) &&
            (!f.period || (f.period === 'received' ? receivedToday(c) : closedToday(c))) &&
            (!f.stage || stageOf(c) === f.stage) &&
            (!f.assignee || (f.assignee === '_none' ? !assigneeOf(c) : assigneeOf(c) === f.assignee)) &&
            (!f.reason || c.caseReason === f.reason) &&
            (!f.origin || c.origin === f.origin),
        )
        // 사람이 봐야 하는 단계를 위로, 그 안에서는 오래 기다린 순
        .sort((a, b) => STAGE_ORDER.indexOf(stageOf(a)) - STAGE_ORDER.indexOf(stageOf(b)) || waitOf(b, now) - waitOf(a, now)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, q, f.period, f.stage, f.assignee, f.reason, f.origin, now],
  );

  const todayCount = all.filter(receivedToday).length;
  const stamp = `${now.getMonth() + 1}월 ${now.getDate()}일 (${'일월화수목금토'[now.getDay()]}) ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 기준`;

  return (
    <main className="page">
      <h1 className="t-h1">팀 문의함</h1>
      <p className="hint t-13" style={{ marginTop: 6 }}>
        오늘 접수 {todayCount}건 중 {rows.filter(receivedToday).length}건 · {stamp}
      </p>

      <div className="row gap-10 a-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="a-search">
          <Search size={16} strokeWidth={1.75} color="#8490a0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="번호 · 제목 · 고객 이름 · 내용으로 찾기" />
        </label>
        <Filter label="기간 기준" value={f.period} onChange={(v) => set('period', v)} options={[['received', '오늘 접수'], ['closed', '오늘 종결']]} />
        <Filter label="단계" value={f.stage} onChange={(v) => set('stage', v)} options={STAGES.map((s) => [s.key, s.label])} />
        <Filter label="담당자" value={f.assignee} onChange={(v) => set('assignee', v)} options={[['_none', '담당 없음'], ...assignees.map((n) => [n, n] as [string, string])]} />
        <Filter label="카테고리" value={f.reason} onChange={(v) => set('reason', v)} options={reasons.map((r) => [r, label(REASON_LABEL, r)])} />
        <Filter label="접수 채널" value={f.origin} onChange={(v) => set('origin', v)} options={[['Email', '이메일'], ['Web', '웹']]} />
        {filtered && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setParams({}, { replace: true })}>
            필터 초기화
          </button>
        )}
        <span className="spacer" />
        <span className="hint t-13">{rows.length}건</span>
      </div>

      {error ? (
        <div className="card error-box" style={{ marginTop: 14 }}>{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading" style={{ marginTop: 14 }}>불러오는 중…</div>
      ) : (
        <div className="table-wrap table-card" style={{ marginTop: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>번호</th>
                <th>제목 · 고객</th>
                <th>검토 사유</th>
                <th>카테고리</th>
                <th>감정</th>
                <th>상태</th>
                <th>마지막 응답</th>
                <th>담당자</th>
                <th>배정 이유</th>
                <th>대기 시간</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Row key={c.id} c={c} now={now} onOpen={() => navigate(`/M-111/${c.id}`, { state: { from: location.pathname + location.search } })} />
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">조건에 맞는 문의가 없어요</div>}
        </div>
      )}
    </main>
  );
}

function Row({ c, now, onOpen }: { c: InboxCase; now: Date; onOpen: () => void }) {
  const stage = stageOf(c);
  const reason = reviewReason(c);
  const assign = assignReason(c);
  const who = assigneeOf(c);
  const min = waitOf(c, now);
  const reply = lastReply(c);
  const byAi = stage === 'ai' || (!who && c.resolution.outcome === 'auto_answered' && (stage === 'wait' || stage === 'closed'));
  return (
    <tr onClick={onOpen}>
      <td className="mono hint t-12">{shortNo(c.caseNumber)}</td>
      <td className="left">
        <div className="cell-title">{c.subject || '(제목 없음)'}</div>
        <div className="cell-sub">
          {c.suppliedName ?? c.suppliedEmail ?? '고객'} 고객 · {label(ORIGIN_LABEL, c.origin)}
        </div>
      </td>
      <td>{stage === 'human' && reason ? <span className={`tag${reason.risk ? ' tag-risk' : ''}`}>{reason.text}</span> : <span className="hint t-12">—</span>}</td>
      <td>
        <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
      </td>
      <td>
        <Sentiment value={c.signals?.sentiment} />
      </td>
      <td>
        <b className="row" style={{ justifyContent: 'center', gap: 6, color: 'var(--gray-900)' }}>
          <i className="dot" style={STAGE_DOT[stage] ? { background: STAGE_DOT[stage] } : undefined} />
          {STAGE_LABEL[stage]}
        </b>
        <div className="cell-sub" style={{ marginTop: 3 }}>
          {stageDetail(c)}
        </div>
      </td>
      <td title={reply ? fullTime(reply.at) : undefined}>{reply ? `${reply.who} · ${relTime(reply.at, now)}` : <span className="hint">응답 없음</span>}</td>
      <td>
        {byAi ? (
          <span className="row gap-8" style={{ justifyContent: 'center' }}>
            <span className="avatar m-av is-ai">A</span>
            <b style={{ color: 'var(--gray-900)' }}>AI</b>
          </span>
        ) : who ? (
          <span className="row gap-8" style={{ justifyContent: 'center' }}>
            <span className="avatar m-av">{who.slice(0, 1)}</span>
            <b style={{ color: 'var(--gray-900)' }}>{who}</b>
          </span>
        ) : (
          <span className="hint">담당 없음</span>
        )}
      </td>
      <td>{assign ? <span className="tag tag-purple">{assign}</span> : <span className="hint t-12">—</span>}</td>
      <td title={fullTime(waitingSince(c))}>
        {stage === 'closed' ? (
          <span className="hint" title={fullTime(closedAt(c))}>
            종결 {relTime(closedAt(c), now)}
          </span>
        ) : (
          <span className={stage === 'human' && min >= 60 ? 'risk strong' : stage === 'wait' ? 'hint' : ''} style={{ fontWeight: stage === 'human' && min >= 60 ? 700 : 500 }}>
            {waitText(min)}
          </span>
        )}
      </td>
      <td>
        <button type="button" className="btn btn-sm btn-line">
          보기
        </button>
      </td>
    </tr>
  );
}

function Filter({ label: text, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className={`m-filter${value ? ' is-on' : ''}`}>
      <span className="hint">{text}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">전체</option>
        {options.map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}
