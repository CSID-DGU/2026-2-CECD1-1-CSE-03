import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Search } from 'lucide-react';
import { api, errorText, type Stats } from '../../lib/api';
import { loadCases, useLive, useScrollRestore, type InboxCase } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { CLOSE_REASON_LABEL, ORIGIN_LABEL, OUTCOME_LABEL, REASON_LABEL, label } from '../../lib/labels';
import { fullTime, monthDayTime, shortNo } from '../../lib/format';
import { Todo } from '../../components/ui';
import { matches } from './model';
import './a.css';

type Quick = 'all' | 'today' | '7d' | '30d' | 'custom';
type Method = 'approved' | 'written' | 'noreply';

const AUTO_CLOSE = new Set(['ignored_first_message', 'declined_ack', 'courtesy_reply', 'inactive']);
const PAGE = 20;
const METHOD_TAG: Record<string, string> = { approved: '', written: 'tag-blue', noreply: 'tag-wait', auto: 'tag-purple' };

function methodOf(c: InboxCase): Method | 'auto' {
  const o = c.resolution.outcome;
  if (o === 'answered_after_approval' || o === 'answered_and_handed_off') return 'approved';
  if (o === 'human_answered') return 'written';
  if (o === 'auto_answered') return 'auto';
  return 'noreply';
}

function closedAt(c: InboxCase): string {
  return c.raw?.closed_at ?? [...c.statusHistory].reverse().find((h) => h.toStatus === 'Closed')?.changedAt ?? c.audit.updatedAt;
}

/** A-300 내 처리 내역 (+ A-300-P01 기간 선택) */
export function History() {
  const { session } = useSession();
  const me = session?.name ?? '';
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<Quick>('all');
  const [range, setRange] = useState({ from: '', to: '' });
  const [pickerOpen, setPickerOpen] = useState(false);
  // 카드 4개는 각각 따로 눌린다. 앞의 두 카드는 문의별 구분이 없어 같은 목록(승인 후 발송)을 거른다.
  const [card, setCard] = useState<'asis' | 'edited' | 'written' | 'noreply' | null>(null);
  const method: Method | null = card === 'asis' || card === 'edited' ? 'approved' : card;
  const [shown, setShown] = useState(PAGE);

  const { data, error, loading } = useLive(async () => {
    const [cases, stats] = await Promise.all([loadCases(), api.stats()]);
    return { cases, stats };
  }, []);
  useScrollRestore('A-300', Boolean(data));

  // 내가 손댄 종결 건: 상태를 바꾼 사람이 나이거나, 내가 맡았던 건.
  const mine = useMemo(
    () =>
      (data?.cases ?? []).filter(
        (c) => c.status === 'Closed' && (c.owner.id === me || c.raw?.assignee === me || c.statusHistory.some((h) => h.changedBy.type === 'user' && h.changedBy.id === me)),
      ),
    [data, me],
  );

  const inPeriod = useMemo(() => {
    const now = Date.now();
    const day = 86400000;
    return mine.filter((c) => {
      const t = new Date(closedAt(c)).getTime();
      if (quick === 'today') return new Date(t).toDateString() === new Date().toDateString();
      if (quick === '7d') return now - t <= 7 * day;
      if (quick === '30d') return now - t <= 30 * day;
      if (quick === 'custom') {
        const from = range.from ? new Date(`${range.from}T00:00:00`).getTime() : -Infinity;
        const to = range.to ? new Date(`${range.to}T23:59:59`).getTime() : Infinity;
        return t >= from && t <= to;
      }
      return true;
    });
  }, [mine, quick, range]);

  const rows = useMemo(
    () =>
      inPeriod
        .filter((c) => matches(c, q) && (!method || methodOf(c) === method))
        .sort((a, b) => closedAt(b).localeCompare(closedAt(a))),
    [inPeriod, q, method],
  );

  const count = (m: Method) => inPeriod.filter((c) => methodOf(c) === m).length;
  const stats: Stats | null = data?.stats ?? null;
  const toggle = (k: 'asis' | 'edited' | 'written' | 'noreply') => setCard((cur) => (cur === k ? null : k));
  const today = new Date().toISOString().slice(0, 10);
  const rangeTooLong = Boolean(range.from && range.to) && new Date(range.to).getTime() - new Date(range.from).getTime() > 366 * 86400000;

  return (
    <main className="page">
      <h1 className="t-h1">내 처리 내역</h1>
      <p className="tertiary t-13" style={{ marginTop: 8 }}>
        내가 종결한 문의가 모두 쌓여요 · 기본은 전체 기간이에요
      </p>

      <div className="row gap-10 a-toolbar" style={{ position: 'relative' }}>
        <label className="a-search">
          <Search size={16} strokeWidth={1.75} color="#8490a0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="번호 · 제목 · 고객 이름 · 내용으로 찾기" />
        </label>
        <span className="spacer" />
        <div className="a-pills" role="group" aria-label="기간 빠른 선택">
          {(
            [
              ['all', '전체'],
              ['today', '오늘'],
              ['7d', '최근 7일'],
              ['30d', '최근 30일'],
            ] as [Quick, string][]
          ).map(([k, text]) => (
            <button key={k} type="button" aria-pressed={quick === k} onClick={() => setQuick(k)}>
              {text}
            </button>
          ))}
          <button type="button" className="a-period" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
            <span className="hint">기간</span>
            <b>{quick === 'custom' && (range.from || range.to) ? `${range.from || '처음'} ~ ${range.to || '오늘'}` : '전체 기간'}</b>
            <ChevronDown size={14} strokeWidth={1.75} />
          </button>
        </div>
        {pickerOpen && (
          <div className="card a-picker">
            <div className="row">
              <b style={{ fontSize: 14 }}>기간 직접 선택</b>
              <span className="spacer" />
              <span className="hint t-12">종결일 기준</span>
            </div>
            <div className="row gap-8" style={{ marginTop: 12, alignItems: 'flex-start' }}>
              <label style={{ flex: 1 }}>
                <span className="hint t-12">시작일</span>
                <input type="date" className="input" value={range.from} max={range.to || today} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
              </label>
              <label style={{ flex: 1 }}>
                <span className="hint t-12">종료일</span>
                <input type="date" className="input" value={range.to} max={today} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
              </label>
            </div>
            <p className="hint t-12" style={{ marginTop: 12 }}>
              최대 1년까지 조회할 수 있어요
            </p>
            {rangeTooLong && <p className="field-error">기간을 1년 안으로 줄여 주세요</p>}
            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-sm btn-line" onClick={() => setPickerOpen(false)}>
                취소
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={(!range.from && !range.to) || rangeTooLong}
                onClick={() => {
                  setQuick('custom');
                  setPickerOpen(false);
                }}
              >
                적용
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="a-methods">
        <button type="button" className="a-method" aria-pressed={card === 'asis'} onClick={() => toggle('asis')}>
          <span className="t-13 strong">초안 그대로 발송</span>
          <b>
            {stats?.approvedNoEdit ?? '—'}
            <small>건</small>
          </b>
          <span className="hint t-12">고친 데 없이 보냈어요</span>
        </button>
        <button type="button" className="a-method" aria-pressed={card === 'edited'} onClick={() => toggle('edited')}>
          <span className="t-13 strong">수정해서 발송</span>
          <b>
            {stats?.approvedEdited ?? '—'}
            <small>건</small>
          </b>
          <span className="hint t-12">고친 내용이 학습에 반영돼요</span>
        </button>
        <button type="button" className="a-method" aria-pressed={card === 'written'} onClick={() => toggle('written')}>
          <span className="t-13 strong">직접 작성 발송</span>
          <b>
            {count('written')}
            <small>건</small>
          </b>
          <span className="hint t-12">처음부터 직접 썼어요</span>
        </button>
        <button type="button" className="a-method" aria-pressed={card === 'noreply'} onClick={() => toggle('noreply')}>
          <span className="t-13 strong">답변 없이 종결</span>
          <b>
            {count('noreply')}
            <small>건</small>
          </b>
          <span className="hint t-12">답변이 필요 없던 건</span>
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        <Todo block what="상담원별 · 기간별 ‘초안 그대로 / 수정해서’ 건수 (지금은 /api/stats 의 팀 전체 누적값)" />
      </div>

      <section className="card a-rules">
        <b>처리 내역 기준</b>
        · 종결한 순간의 기록이 처리 1건으로 남아요. 문의가 다시 열려도, 다른 상담원에게 넘어가도 이미 남은 기록은 지워지지 않아요.
        <br />· 종결 후 고객이 다시 문의하면 같은 번호로 다시 열려 문의함 ‘답변 필요’로 돌아와요. 이 표에는 ‘다시 열림’으로 보이고, 다시 종결하면 새 기록이 한 줄 더 생겨요.
        <br />· 다시 열린 문의가 다른 상담원에게 배정되거나 이관되면 이후 처리는 그 상담원의 내역에 쌓여요. 이 표에는 ‘이관 · 담당자 이름’으로 보여요.
        <br />
        <Todo what="종결 시점 기록 고정 · 다시 열림/이관 추적 (지금은 현재 종결 상태인 문의만 보여요)" />
      </section>

      {error ? (
        <div className="card error-box" style={{ marginTop: 18 }}>{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading" style={{ marginTop: 18 }}>불러오는 중…</div>
      ) : (
        <div className="table-wrap table-card" style={{ marginTop: 18 }}>
          <table className="table">
            <thead>
              <tr>
                <th>번호</th>
                <th className="left">제목 · 고객</th>
                <th>카테고리</th>
                <th>처리 방식</th>
                <th>답변 횟수</th>
                <th>종결 시각</th>
                <th>결과</th>
                <th>지금 상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((c) => (
                <tr key={c.id} onClick={() => navigate(`/A-200/${c.id}`, { state: { from: '/A-300' } })}>
                  <td className="mono hint t-12">{shortNo(c.caseNumber)}</td>
                  <td className="left">
                    <div className="cell-title">{c.subject || '(제목 없음)'}</div>
                    <div className="cell-sub">
                      {c.suppliedName ?? c.suppliedEmail ?? '고객'} 고객 · {label(ORIGIN_LABEL, c.origin)}
                    </div>
                  </td>
                  <td>
                    <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
                  </td>
                  <td>
                    <span className={`tag ${METHOD_TAG[methodOf(c)]}`}>{label(OUTCOME_LABEL, c.resolution.outcome, '답변 없이 종결')}</span>
                  </td>
                  <td>
                    <span className="hint">—</span>
                  </td>
                  <td title={fullTime(closedAt(c))}>{monthDayTime(closedAt(c))}</td>
                  <td title={label(CLOSE_REASON_LABEL, c.closeReason)}>
                    <b style={{ color: 'var(--gray-900)' }}>{c.closeReason && AUTO_CLOSE.has(c.closeReason) ? '자동 종결' : '종결'}</b>
                  </td>
                  <td>
                    <span className="tag">종결 유지</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">조건에 맞는 처리 내역이 없어요</div>}
          {rows.length > shown && (
            <button type="button" className="a-more" onClick={() => setShown((n) => n + PAGE)}>
              +{rows.length - shown}건 더 보기 · 최근 {shown}건만 보여요
            </button>
          )}
        </div>
      )}
      <p className="hint t-12" style={{ marginTop: 10 }}>
        답변 횟수 칸 <Todo what="문의별 답변 횟수 (목록 API에 없음)" />
      </p>
    </main>
  );
}
