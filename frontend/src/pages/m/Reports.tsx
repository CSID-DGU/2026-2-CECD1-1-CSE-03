import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { api, errorText, get, type CrmDetail } from '../../lib/api';
import { loadCases, useLive, type InboxCase } from '../../lib/hooks';
import { REASON_LABEL, label } from '../../lib/labels';
import { fullTime, hm, isToday, shortNo } from '../../lib/format';
import { Modal, Todo } from '../../components/ui';
import { closedAt, closedByHuman } from './model';
import './m.css';

type Period = 'today' | '7d' | '30d';
const PERIOD_LABEL: Record<Period, string> = { today: '오늘', '7d': '최근 7일', '30d': '최근 30일' };
const DAYS: Record<Period, number> = { today: 1, '7d': 7, '30d': 30 };

/** 기간은 오늘을 포함한 연속 달력일로 센다 (R-100 스펙). */
function inPeriod(iso: string, p: Period): boolean {
  if (p === 'today') return isToday(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS[p] - 1)).getTime();
  return new Date(iso).getTime() >= start;
}

function periodText(p: Period): string {
  const now = new Date();
  const day = `${now.getMonth() + 1}월 ${now.getDate()}일`;
  return p === 'today' ? `오늘 00:00 ~ ${hm(now.toISOString())}` : `${day} 포함 ${PERIOD_LABEL[p]}`;
}

type Gaps = { total: number; items: { channel: string; caseRef: string; at: string; question: string; nearestKeys: string[] }[] };

function Head({ tab, period, onPeriod, title, sub }: { tab: 'ops' | 'voice'; period: Period; onPeriod: (p: Period) => void; title: string; sub: string }) {
  const navigate = useNavigate();
  return (
    <>
      <div className="row">
        <div>
          <h1 className="t-h1">{title}</h1>
          <p className="hint t-13" style={{ marginTop: 6 }}>
            {sub}
          </p>
        </div>
        <span className="spacer" />
        <div className="segment" role="group" aria-label="리포트 탭">
          <button type="button" aria-pressed={tab === 'ops'} onClick={() => navigate('/R-100')}>
            운영 리포트
          </button>
          <button type="button" aria-pressed={tab === 'voice'} onClick={() => navigate('/R-200')}>
            고객 목소리
          </button>
        </div>
      </div>
      <div className="row gap-10" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <span className="hint t-12">기간</span>
        <div className="segment" role="group" aria-label="기간">
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
            <button key={p} type="button" aria-pressed={period === p} onClick={() => onPeriod(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** R-100 리포트 · 운영 리포트 */
export function OpsReport() {
  const [period, setPeriod] = useState<Period>('7d');
  const { data, error, loading } = useLive(async () => {
    const [cases, gaps] = await Promise.all([loadCases(), get<Gaps>('/api/report/knowledge-gaps?limit=200')]);
    return { cases, gaps };
  }, []);

  const m = useMemo(() => {
    const cases = data?.cases ?? [];
    const received = cases.filter((c) => inPeriod(c.audit.createdAt, period));
    const closed = cases.filter((c) => c.status === 'Closed' && inPeriod(closedAt(c), period));
    // AI 자동 처리율 = 접수한 건 중 사람 손 없이 AI가 답한 비율
    // AI 1차 응답 기준: AI가 먼저 답한 건 (그 뒤 사람에게 넘어간 건 포함)
    const autoOnly = received.filter((c) => c.resolution.outcome === 'auto_answered' || c.resolution.outcome === 'answered_and_handed_off');
    const byReason = new Map<string, number>();
    received.forEach((c) => byReason.set(c.caseReason || 'other', (byReason.get(c.caseReason || 'other') ?? 0) + 1));
    return {
      received,
      closed,
      aiClosed: closed.filter((c) => !closedByHuman(c)).length,
      autoOnly: autoOnly.length,
      // 건수 많은 순, '기타'는 맨 아래
      reasons: [...byReason.entries()].sort((a, b) => Number(a[0] === 'other') - Number(b[0] === 'other') || b[1] - a[1]),
    };
  }, [data, period]);

  // 같은 질문은 묶어서 건수로 보여준다
  const gaps = useMemo(() => {
    const groups = new Map<string, { question: string; channel: string; keys: string[]; count: number }>();
    (data?.gaps.items ?? [])
      .filter((g) => inPeriod(g.at, period))
      .forEach((g) => {
        const key = g.question.trim();
        const cur = groups.get(key);
        if (cur) cur.count += 1;
        else groups.set(key, { question: key, channel: g.channel, keys: g.nearestKeys, count: 1 });
      });
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }, [data, period]);
  const n = m.received.length;

  return (
    <main className="page">
      <Head tab="ops" period={period} onPeriod={setPeriod} title="운영 리포트" sub={`${periodText(period)} 기준 · 접수와 종결, 자동 처리율을 한눈에 봐요`} />

      {error ? (
        <div className="card error-box" style={{ marginTop: 18 }}>{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading" style={{ marginTop: 18 }}>불러오는 중…</div>
      ) : (
        <>
          <div className="m-kpis">
            <div className="card m-sum">
              <span className="t-13 strong">접수</span>
              <span className="m-sum-num">
                {n}
                <small>건</small>
              </span>
              <span className="hint t-12">하루 평균 {Math.round(n / DAYS[period])}건</span>
            </div>
            <div className="card m-sum">
              <span className="t-13 strong">종결</span>
              <span className="m-sum-num">
                {m.closed.length}
                <small>건</small>
              </span>
              <span className="hint t-12">
                AI 자동 종결 {m.aiClosed} · 사람 종결 {m.closed.length - m.aiClosed}
              </span>
            </div>
            <div className="card m-sum">
              <span className="t-13 strong">AI 자동 처리율</span>
              <span className="m-sum-num">
                {n ? ((m.autoOnly / n) * 100).toFixed(1) : '—'}
                <small>%</small>
              </span>
              <span className="hint t-12">
                AI 1차 응대 {m.autoOnly}건 / {n}건
              </span>
            </div>
            <div className="card m-sum">
              <span className="t-13 strong">평균 첫 응답</span>
              <span className="m-sum-num">
                <Todo what="평균 첫 응답 시간 집계" />
              </span>
              <span className="hint t-12">AI 1차 응답 기준</span>
            </div>
          </div>

          <div className="m-two">
            <section className="card a-panel">
              <header style={{ alignItems: 'center' }}>
                <h2 className="t-h2">주요 문의 유형</h2>
                <span className="spacer" />
                <span className="hint t-12">접수 {n}건 중 비율</span>
              </header>
              {m.reasons.map(([key, count]) => (
                <div key={key} className="m-ratio">
                  <b>{label(REASON_LABEL, key)}</b>
                  <span className="m-bar">
                    <i style={{ width: `${(count / Math.max(1, n)) * 100}%`, background: 'var(--primary-500)' }} />
                  </span>
                  <span className="t-12 tertiary">
                    {Math.round((count / Math.max(1, n)) * 100)}% · {count}건
                  </span>
                </div>
              ))}
              {!m.reasons.length && <div className="empty">이 기간에 접수한 문의가 없어요</div>}
            </section>

            <section className="card a-panel">
              <header style={{ alignItems: 'center', marginBottom: 6 }}>
                <h2 className="t-h2">매뉴얼에 답이 없던 문의</h2>
                <span className="spacer" />
                <span className="hint t-12">{periodText(period)}</span>
              </header>
              <p className="hint t-12" style={{ marginBottom: 12 }}>
                AI가 매뉴얼에서 근거를 찾지 못해 사람이 직접 답한 문의예요.
              </p>
              {gaps.slice(0, 5).map((g) => (
                <Link key={g.question} to="/S-110" className="m-gap">
                  <b>{g.question}</b>
                  <span className="hint t-12">
                    {periodText(period)} {g.count}건 · {label({ support: '고객문의', onboarding: '온보딩', sales: '영업 문의' }, g.channel)}
                    {g.keys.length ? ` · ${g.keys.join(', ')}` : ''}
                  </span>
                </Link>
              ))}
              {!gaps.length && <div className="empty">이 기간에는 없어요</div>}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

/** R-200 리포트 · 고객 목소리 (+ R-200-P01 의견 보기) */
export function VoiceReport() {
  const [period, setPeriod] = useState<Period>('today');
  const [open, setOpen] = useState<InboxCase | null>(null);
  const { data, error, loading } = useLive(loadCases, []);
  const rows = useMemo(
    () => (data ?? []).filter((c) => inPeriod(c.audit.createdAt, period)).sort((a, b) => b.audit.createdAt.localeCompare(a.audit.createdAt)),
    [data, period],
  );

  return (
    <main className="page">
      <Head tab="voice" period={period} onPeriod={setPeriod} title="고객 목소리" sub={`${periodText(period)} 기준 · 고객 의견을 최신순으로 한 건씩 보여줘요 · 보기로 전체 내용을 읽어요`} />
      {error ? (
        <div className="card error-box" style={{ marginTop: 18 }}>{errorText(error)}</div>
      ) : loading && !data ? (
        <div className="card loading" style={{ marginTop: 18 }}>불러오는 중…</div>
      ) : (
        <div className="table-wrap table-card" style={{ marginTop: 14 }}>
          <table className="table m-voice">
            <thead>
              <tr>
                <th className="left">의견 제목 · 한 줄 요약 ({rows.length}건)</th>
                <th className="left">카테고리</th>
                <th className="left">접수 시각</th>
                <th>보기</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => setOpen(c)}>
                  <td className="left">
                    <b className="m-clamp2">{c.summary || c.subject || '(제목 없음)'}</b>
                  </td>
                  <td className="left">
                    <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
                  </td>
                  <td className="left" title={fullTime(c.audit.createdAt)}>
                    {isToday(c.audit.createdAt) ? `오늘 ${hm(c.audit.createdAt)}` : fullTime(c.audit.createdAt)}
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm btn-line">
                      보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">이 기간에 접수한 의견이 없어요</div>}
        </div>
      )}
      <p className="hint t-12" style={{ marginTop: 10 }}>
        지금은 접수한 문의 전체를 접수 Agent 요약과 함께 보여줘요. <Todo what="불만 원인 묶기 · 개선 과제 · 담당 부서 제안 (경영진용 분석)" />
      </p>
      {open && <VoiceModal c={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

function VoiceModal({ c, onClose }: { c: InboxCase; onClose: () => void }) {
  const navigate = useNavigate();
  const { data } = useLive<CrmDetail>(() => api.crmCase(c.id), [c.id], []);
  const bodies = (data?.timeline ?? []).flatMap((t) => (t.kind === 'inbound' ? [t.body] : []));
  return (
    <Modal onClose={onClose} width={640}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <h2 className="t-modal" style={{ flex: 1 }}>
          {c.summary || c.subject}
        </h2>
        <button type="button" className="btn btn-sm btn-line" style={{ width: 32, padding: 0 }} onClick={onClose} aria-label="닫기">
          <X size={16} />
        </button>
      </div>
      <div className="row gap-10" style={{ marginTop: 12 }}>
        <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
        <span className="hint t-12">접수</span>
        <span className="t-13">
          {isToday(c.audit.createdAt) ? `오늘 ${hm(c.audit.createdAt)}` : fullTime(c.audit.createdAt)} · {c.origin === 'Web' ? '웹' : '이메일'}
        </span>
      </div>
      <b className="t-13" style={{ display: 'block', margin: '18px 0 8px' }}>
        전체 의견
      </b>
      <div className="a-send-box scroll" style={{ maxHeight: 220, marginTop: 0, background: '#fff', border: '1px dashed var(--gray-400)' }}>
        {data ? bodies.join('\n\n') || '(내용 없음)' : '불러오는 중…'}
      </div>
      <div style={{ marginTop: 16 }}>
        <span className="hint t-12" style={{ display: 'block' }}>
          관련 문의 번호
        </span>
        <button type="button" className="tag mono" style={{ marginTop: 6 }} onClick={() => navigate(`/M-111/${c.id}`)}>
          {shortNo(c.caseNumber)}
        </button>
        <button type="button" className="t-12 strong brand row" style={{ gap: 3, marginTop: 8 }} onClick={() => navigate(`/M-111/${c.id}`)}>
          문의 이력 보기 <ArrowRight size={12} />
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-primary" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}
