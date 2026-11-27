import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronRight, ChevronUp } from 'lucide-react';
import { api, errorText, type Activity, type AgentLog, type CrmDetail, type RawDetail } from '../../lib/api';
import { loadCases, useLive } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import {
  CLOSE_REASON_LABEL,
  HANDOFF_LABEL,
  ORIGIN_LABEL,
  OUTCOME_LABEL,
  REASON_LABEL,
  TOOL_LABEL,
  label,
} from '../../lib/labels';
import { fullTime, hm, monthDayTime, receivedAt, relTime, shortNo } from '../../lib/format';
import { Modal, RadioCard, Sentiment, Todo, useToast } from '../../components/ui';
import { firstToSee } from './model';
import './a.css';

type Detail = { crm: CrmDetail; raw: RawDetail | null };
type Mode = 'view' | 'edit' | 'write' | 'follow';
type Popup = null | 'send' | 'sent' | 'handover' | 'close';
export type SendKind = 'draft' | 'edited' | 'written';

const SEND_KIND_LABEL: Record<SendKind, string> = { draft: '초안 그대로', edited: '수정해서 발송', written: '직접 작성' };

/**
 * A-200 문의 상세 · 답변 작성 (+ A-200_raw · A-210 초안 수정 · A-220 직접 작성 · A-200-P01~P04)
 * A-230 고객 회신 대기 · A-240 종결 — 같은 주소에서 문의 상태에 따라 아래쪽 카드만 바뀐다.
 */
export function CaseDetail() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const by = session?.name ?? '';
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? (location.pathname.startsWith('/A-240') ? '/A-300' : '/A-100');
  const fromLabel = from === '/A-300' ? '내 처리 내역' : '문의함';
  const toast = useToast();

  const loader = useCallback(async (): Promise<Detail> => {
    const [crm, raw] = await Promise.all([api.crmCase(id), api.rawCase(id).catch(() => null)]);
    return { crm, raw };
  }, [id]);
  const { data, error, loading, reload } = useLive(loader, [id]);

  // 화면 ID가 따로 있는 상태는 주소도 따로 준다: A-210 초안 수정 · A-220 직접 작성 · A-230 회신 대기 · A-240 종결
  const screen = location.pathname.split('/')[1] ?? 'A-200';
  const [mode, setMode] = useState<Mode>(screen === 'A-210' ? 'edit' : screen === 'A-220' ? 'write' : 'view');
  const [text, setText] = useState('');
  const seeded = useRef(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [after, setAfter] = useState<'wait' | 'close'>('wait');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [openRaw, setOpenRaw] = useState<Set<string>>(new Set());
  const [sentInfo, setSentInfo] = useState<{ closed: boolean } | null>(null);

  const loadedCase = data?.crm.case;
  const loadedDraft = data ? data.crm.pendingDraft?.body ?? data.raw?.handoffs.at(-1)?.briefing?.recommendedReply ?? '' : '';
  const canonical = !loadedCase
    ? null
    : loadedCase.status === 'Closed'
      ? 'A-240'
      : loadedCase.subStatus === 'Waiting on Customer'
        ? 'A-230'
        : mode === 'edit'
          ? 'A-210'
          : mode === 'write'
            ? 'A-220'
            : 'A-200';

  useEffect(() => {
    if (canonical && canonical !== screen) navigate(`/${canonical}/${id}`, { replace: true, state: location.state });
  }, [canonical, screen, id, navigate, location.state]);

  // A-210 주소로 바로 들어온 경우 초안을 편집칸에 채운다.
  useEffect(() => {
    if (!seeded.current && loadedCase && mode === 'edit') {
      seeded.current = true;
      setText(loadedDraft);
    }
  }, [loadedCase, loadedDraft, mode]);

  if (error) return <main className="page"><div className="card error-box">{errorText(error)}</div></main>;
  if (loading && !data) return <main className="page"><div className="card loading">불러오는 중…</div></main>;
  if (!data) return null;

  const { crm, raw } = data;
  const c = crm.case;
  const draft = crm.pendingDraft;
  const briefing = raw?.handoffs.at(-1)?.briefing ?? null;
  const can = (a: CrmDetail['actions'][number]) => crm.actions.includes(a);
  const isClosed = c.status === 'Closed';
  const isWaiting = c.subStatus === 'Waiting on Customer';
  const needsReply = !isClosed && !isWaiting;
  const customer = c.suppliedName ?? crm.contact?.current?.name?.value ?? c.suppliedEmail ?? '고객';

  // AI 초안: 승인 대기 초안이 있으면 그 본문, 없으면 인계 Agent가 남긴 추천 답변.
  const aiDraft = draft?.body ?? briefing?.recommendedReply ?? '';
  const draftIsApprovable = Boolean(draft) && can('approve');
  const sendKind: SendKind = mode === 'write' || mode === 'follow' ? 'written' : mode === 'edit' && text.trim() !== aiDraft.trim() ? 'edited' : 'draft';
  const outgoing = mode === 'view' ? aiDraft : text;

  const startEdit = () => {
    seeded.current = true;
    setText(aiDraft);
    setMode('edit');
  };
  const startWrite = () => {
    setText('');
    setMode('write');
  };

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (sendKind === 'draft' && draft && draftIsApprovable) await api.approve(draft.id, by);
      else if (sendKind === 'edited' && draft && can('edit_approve')) await api.approve(draft.id, by, text);
      else await api.humanReply(c.id, by, outgoing);
      if (after === 'close') await api.close(c.id, by, 'resolved');
      setSentInfo({ closed: after === 'close' });
      setMode('view');
      setPopup('sent');
      reload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const closeCase = async (reason: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await api.close(c.id, by, reason, undefined, crm.revision);
      // 토스트는 한 문장만 · 대상 이름이나 세부 값은 넣지 않는다 (Interaction Rules)
      toast(reason === 'no_response' ? '문의를 종결했어요' : '답변 없이 종결했어요');
      navigate(isWaiting ? '/A-100' : from);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleRaw = (key: string) =>
    setOpenRaw((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const closedEntry = [...c.statusHistory].reverse().find((h) => h.toStatus === 'Closed');

  return (
    <main className="page">
      <Link to={from} className="back">
        <ArrowLeft size={14} strokeWidth={2} />
        {fromLabel}
      </Link>

      <div className="a-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="t-h1">
            <span className="mono hint" style={{ fontSize: 13 }}>
              {shortNo(c.caseNumber)}
            </span>
            {c.subject || '(제목 없음)'}
          </h1>
          <div className="a-head-meta">
            <span>
              {customer} 고객 · {label(ORIGIN_LABEL, c.origin)} · {receivedAt(c.audit.createdAt)}
            </span>
            <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
            <Sentiment value={latestTriage(crm.agentLog)?.output.sentiment} />
            <b style={{ color: 'var(--gray-900)' }}>
              · {isClosed ? '종결' : isWaiting ? '고객 회신 대기' : '답변 필요'}
              {needsReply && raw?.case.responder === 'human' && raw.case.lastMessageDirection === 'in' && c.statusHistory.some((h) => h.changedBy.type === 'user') ? ' · 새 답장' : ''}
            </b>
          </div>
        </div>
        {needsReply && (
          <button type="button" className="btn btn-sm btn-line" onClick={() => setPopup('handover')}>
            관리자에게 넘기기
          </button>
        )}
      </div>

      {isClosed && (
        <div className="card a-result">
          <i className="dot dot-ok" />
          <b>
            {monthDayTime(closedEntry?.changedAt ?? c.audit.updatedAt)} · {label(OUTCOME_LABEL, c.resolution.outcome, '답변 없이 종결')} ·{' '}
            {label(CLOSE_REASON_LABEL, c.closeReason, '종결')}
            {c.closeDetail ? ` (${c.closeDetail})` : ''}
          </b>
          <span className="spacer" />
          <span className="hint t-12">종결된 문의예요 · 기록은 고칠 수 없어요</span>
        </div>
      )}

      <div className="a-detail">
        <div>
          <section className="card a-panel">
            <header>
              <h2 className="t-h2">응대 이력</h2>
              <span className="hint t-12">시간 순서대로 모두 저장돼요</span>
            </header>
            <Timeline crm={crm} customer={customer} openRaw={openRaw} onToggleRaw={toggleRaw} />
          </section>

          {needsReply && (
            <section className="card a-panel a-compose">
              <header>
                <h2 className="t-h2">답변 작성</h2>
                {mode !== 'write' && aiDraft && <span className="chip chip-ai">AI 초안</span>}
                <span className="hint t-12">
                  {mode === 'view' && (aiDraft ? '아직 고치지 않았어요 · 이대로 보내면 “초안 그대로”로 기록돼요' : 'AI 초안이 없는 문의예요 · 직접 작성해 주세요')}
                  {mode === 'edit' && '수정 중이에요 · 원래 초안과 달라지면 “수정해서 발송”으로 기록돼요'}
                  {mode === 'write' && '직접 작성 중이에요 · “직접 작성”으로 기록돼요'}
                </span>
              </header>

              {mode === 'view' ? (
                <div className="a-compose-view">{aiDraft || <span className="hint">초안 없음</span>}</div>
              ) : (
                <textarea
                  className="textarea"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="고객에게 보낼 답변을 작성해 주세요"
                  autoFocus
                />
              )}

              <div className="a-compose-actions">
                {mode === 'view' ? (
                  <>
                    <button type="button" className="btn btn-md btn-primary" disabled={!aiDraft} data-tip={!aiDraft ? 'AI 초안이 없어요 · 직접 작성해 주세요' : undefined} onClick={() => setPopup('send')}>
                      그대로 발송
                    </button>
                    <button type="button" className="btn btn-md btn-line" disabled={!aiDraft} data-tip={!aiDraft ? '고칠 AI 초안이 없어요' : undefined} onClick={startEdit}>
                      수정하기
                    </button>
                    <button type="button" className="btn btn-md btn-line" disabled={!can('human_reply') && !can('takeover')} onClick={startWrite}>
                      직접 작성
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-md btn-primary" disabled={!text.trim()} data-tip={!text.trim() ? '빈 칸을 채우면 눌러져요' : undefined} onClick={() => setPopup('send')}>
                      {mode === 'edit' ? '수정한 내용으로 발송' : '작성한 내용으로 발송'}
                    </button>
                    <button type="button" className="btn btn-md btn-line" onClick={() => setMode('view')}>
                      취소
                    </button>
                    {mode === 'edit' && (
                      <button type="button" className="btn btn-md btn-ghost" onClick={() => setText(aiDraft)}>
                        AI 초안 복원
                      </button>
                    )}
                  </>
                )}
                <span className="spacer" />
                <button type="button" className="btn btn-md btn-line" disabled={!can('close')} onClick={() => setPopup('close')}>
                  답변 없이 종결
                </button>
              </div>
              <p className="hint t-12" style={{ marginTop: 14 }}>
                수정해서 보내면 그 차이가 학습 데이터로 쌓여요
              </p>
            </section>
          )}

          {isWaiting && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center' }}>
                <i className="dot dot-wait" />
                <h2 className="t-h2">고객 답을 기다리고 있어요</h2>
                <span className="spacer" />
                <span className="hint t-12">
                  자동 종결 예정일 <Todo what="자동 종결 예정일 조회" />
                </span>
              </header>
              <p className="t-13 tertiary">
                {raw?.case.lastMessageDirection === 'out' && raw.case.lastMessageAt ? `${relTime(raw.case.lastMessageAt)}에 답변을 보냈어요. ` : '답변을 보냈어요. '}
                오래 답이 없으면 자동으로 종결돼요. 고객이 답장하면 같은 담당에게 ‘답변 필요 · 새 답장’으로 다시 와요.
              </p>
              <div className="a-compose-actions" style={{ paddingTop: 16, borderTop: '1px solid var(--border-default)' }}>
                <button type="button" className="btn btn-md btn-primary" disabled={!can('close')} onClick={() => setPopup('close')}>
                  지금 종결
                </button>
                <Link to="/A-100" className="btn btn-md btn-line">
                  문의함
                </Link>
              </div>
            </section>
          )}

          {isClosed && (
            <section className="card a-panel a-compose a-follow">
              <header style={{ alignItems: 'center' }}>
                <h2 className="t-h2">고객에게 먼저 메시지 보내기</h2>
                <span className="spacer" />
                {mode === 'follow' ? <span className="chip chip-pill">다시 열림 예정</span> : <span className="hint t-12">종결 후에도 보낼 수 있어요</span>}
              </header>
              {mode === 'follow' ? (
                <>
                  <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="고객에게 보낼 메시지를 작성해 주세요" autoFocus />
                  <div className="a-compose-actions">
                    <button type="button" className="btn btn-md btn-primary" disabled>
                      발송
                    </button>
                    <button type="button" className="btn btn-md btn-line" onClick={() => setMode('view')}>
                      취소
                    </button>
                    <Todo what="종결된 문의 다시 열기 (reopen API 없음)" />
                    <span className="spacer" />
                    <span className="hint t-12">보내면 ‘고객 회신 대기’ · 3일 무응답 시 다시 자동 종결</span>
                  </div>
                </>
              ) : (
                <>
                  <p className="t-13 tertiary">추가 안내가 필요하면 고객에게 먼저 메시지를 보낼 수 있어요. 보내면 이 문의가 다시 열려 ‘고객 회신 대기’로 옮겨져요.</p>
                  <div className="a-compose-actions" style={{ paddingTop: 14, borderTop: '1px solid var(--border-default)' }}>
                    <button
                      type="button"
                      className="btn btn-md btn-primary"
                      onClick={() => {
                        setText('');
                        setMode('follow');
                      }}
                    >
                      메시지 작성
                    </button>
                    <span className="hint t-12">기존 종결 기록은 내 처리 내역에 그대로 남아요</span>
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        <SidePanels crm={crm} raw={raw} />
      </div>

      {popup === 'send' && (
        <SendConfirm
          no={shortNo(c.caseNumber)}
          subject={c.subject}
          body={outgoing}
          kind={sendKind}
          after={after}
          onAfter={setAfter}
          busy={busy}
          failure={failure}
          onCancel={() => {
            setPopup(null);
            setFailure(null);
          }}
          onSend={send}
        />
      )}
      {popup === 'sent' && <SentDone no={shortNo(c.caseNumber)} closed={Boolean(sentInfo?.closed)} currentId={c.id} onClose={() => setPopup(null)} />}
      {popup === 'handover' && <HandoverModal no={shortNo(c.caseNumber)} subject={c.subject} onClose={() => setPopup(null)} />}
      {popup === 'close' && (
        <CloseConfirm
          waiting={isWaiting}
          busy={busy}
          failure={failure}
          onCancel={() => {
            setPopup(null);
            setFailure(null);
          }}
          onClose={closeCase}
        />
      )}
    </main>
  );
}

/** 오른쪽 열: 고객 · 문의 정보 / 처리 기준 · 다음 조치 (A-200 · M-111 · M-202 · M-300 공통) */
export function SidePanels({ crm, raw }: { crm: CrmDetail; raw: RawDetail | null }) {
  const c = crm.case;
  const draft = crm.pendingDraft;
  const briefing = raw?.handoffs.at(-1)?.briefing ?? null;
  const customer = c.suppliedName ?? crm.contact?.current?.name?.value ?? c.suppliedEmail ?? '고객';
  return (
    <aside>
          <section className="card a-panel">
            <header>
              <h2 className="t-h2">고객 · 문의 정보</h2>
            </header>
            <dl className="a-kv">
              <dt>고객</dt>
              <dd>{customer}</dd>
              <dt>이메일</dt>
              <dd>{c.suppliedEmail ?? '—'}</dd>
              <dt>회사</dt>
              <dd>{crm.company?.canonicalName ?? '—'}</dd>
              <dt>접수 창구</dt>
              <dd>
                {label({ support: '고객문의', onboarding: '온보딩', sales: '영업 문의' }, c.recordType)} · {label(ORIGIN_LABEL, c.origin)}
              </dd>
              <dt>우선순위</dt>
              <dd>{label({ High: '높음', Medium: '보통', Low: '낮음' }, c.priority)}</dd>
              {Object.entries(raw?.case.known_facts ?? {}).map(([k, v]) => (
                <KV key={k} k={k} v={v} />
              ))}
              {crm.relatedCases.map((r) => (
                <KV key={r.id} k={r.relation === 'previous' ? '이전 문의' : '후속 문의'} v={`${shortNo(r.caseNumber)} · ${r.subject}`} />
              ))}
            </dl>
          </section>

          <section className="card a-panel">
            <header style={{ alignItems: 'center' }}>
              <h2 className="t-h2">처리 기준 · 다음 조치</h2>
              <span className="spacer" />
              <span className="chip chip-ai">AI 참고</span>
            </header>
            <dl className="a-kv">
              <dt>넘긴 이유</dt>
              <dd>{label(HANDOFF_LABEL, c.resolution.handoffReason)}</dd>
              <dt>고객 요청</dt>
              <dd>{briefing?.request ?? latestTriage(crm.agentLog)?.output.customerWants ?? c.summary ?? '—'}</dd>
              <dt>다음 조치</dt>
              <dd>{briefing?.nextAction ?? c.resolution.nextAction ?? '—'}</dd>
              {c.hold && (
                <>
                  <dt>보류 메모</dt>
                  <dd>{c.hold.note}</dd>
                </>
              )}
            </dl>
            <div className="a-evidence">
              근거
              {draft && Object.keys(draft.kbPassages).length ? (
                Object.entries(draft.kbPassages).map(([key, passage]) => (
                  <span key={key} className="tag" title={passage}>
                    매뉴얼 · {key}
                  </span>
                ))
              ) : (
                <span>참고한 매뉴얼 조항이 없어요</span>
              )}
            </div>
          </section>
    </aside>
  );
}

function KV({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v)}</dd>
    </>
  );
}

export function latestTriage(log: AgentLog[]): AgentLog | undefined {
  return [...log].reverse().find((l) => l.step === 'triage');
}

// ───────── 응대 이력 ─────────

type Row =
  | { kind: 'inbound'; at: string; key: string; body: string; summary: string | null }
  | { kind: 'log'; at: string; key: string; log: AgentLog }
  | { kind: 'activity'; at: string; key: string; a: Activity };

export function Timeline({ crm, customer, openRaw, onToggleRaw }: { crm: CrmDetail; customer: string; openRaw: Set<string>; onToggleRaw: (k: string) => void }) {
  const rows = useMemo<Row[]>(() => {
    const triages = crm.agentLog.filter((l) => l.step === 'triage');
    const out: Row[] = [];
    for (const t of crm.timeline) {
      if (t.kind === 'inbound') {
        // 그 메시지 바로 뒤에 돈 접수 Agent 결과를 "AI가 정리한 내용"으로 쓴다.
        const tri = triages.find((l) => l.at >= t.at);
        out.push({ kind: 'inbound', at: t.at, key: t.eventId, body: t.body, summary: tri?.output.customerWants ?? null });
      } else if (t.activity.direction !== 'inbound') {
        out.push({ kind: 'activity', at: t.at, key: t.activity.id, a: t.activity });
      }
    }
    for (const l of crm.agentLog) out.push({ kind: 'log', at: l.at, key: l.id, log: l });
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [crm]);

  const lastInbound = [...rows].reverse().find((r) => r.kind === 'inbound')?.key;
  const origin = label(ORIGIN_LABEL, crm.case.origin);

  return (
    <div>
      {rows.map((r) => {
        if (r.kind === 'inbound') {
          const open = openRaw.has(r.key);
          const hasSummary = Boolean(r.summary) && r.summary !== r.body;
          return (
            <div className="a-msg" key={r.key}>
              <div className="a-msg-head">
                <b>{customer} 고객</b>
                <span title={fullTime(r.at)}>
                  {origin} · {hm(r.at)}
                </span>
                <span className="spacer" />
                {r.key === lastInbound && <span className="tag tag-dark">최신 고객 메시지</span>}
              </div>
              {hasSummary ? (
                <>
                  <span className="a-msg-label">AI가 정리한 내용</span>
                  <p className="a-msg-body">{r.summary}</p>
                  {open && (
                    <div className="a-raw">
                      <small>고객 원문 그대로</small>
                      <p className="a-msg-body" style={{ marginTop: 0 }}>
                        {r.body}
                      </p>
                    </div>
                  )}
                  <button type="button" className="a-linkbtn" onClick={() => onToggleRaw(r.key)}>
                    {open ? '원문 닫기' : '원문 보기'}
                    {open ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
                  </button>
                </>
              ) : (
                <p className="a-msg-body">{r.body}</p>
              )}
            </div>
          );
        }
        if (r.kind === 'log') return <LogRow key={r.key} log={r.log} intent={crm.case.caseReason} />;
        return <ActivityRow key={r.key} a={r.a} />;
      })}
      {!rows.length && <div className="empty">아직 응대 이력이 없어요</div>}
    </div>
  );
}

function LogRow({ log, intent }: { log: AgentLog; intent: string }) {
  const o = log.output;
  if (log.step === 'triage') {
    return (
      <>
        <div className="a-logrow">
          <span>
            <span className="tag">AI 분류</span>
          </span>
          <span>
            {label(REASON_LABEL, intent)} · {o.urgency === 'high' ? '우선순위 높음' : '일반'} (감정 {o.sentiment ?? '—'}
            {o.threat ? ' · 위협 표현 감지' : ''})
          </span>
          <time title={fullTime(log.at)}>{hm(log.at)}</time>
        </div>
        <div className="a-logrow">
          <span>
            <span className="tag">감정 정리</span>
          </span>
          <span>
            <Todo what="거친 표현 정리본 · 정리 내역 (지금은 접수 Agent의 요약만 있어요)" />
          </span>
          <time />
        </div>
      </>
    );
  }
  const tools = [...new Set((o.trace ?? []).flatMap((t) => t.calls.map((c) => c.tool)))];
  const keys = [...new Set((o.trace ?? []).flatMap((t) => t.calls.flatMap((c) => (Array.isArray(c.input.keys) ? (c.input.keys as string[]) : []))))];
  return (
    <div className="a-logrow">
      <span>
        <span className="tag">AI 조회</span>
      </span>
      <span>
        {tools.length ? tools.map((t) => label(TOOL_LABEL, t)).join(' · ') : '도구 호출 없음'}
        {keys.length ? ` · 매뉴얼 ${keys.join(', ')}` : ''}
        {o.steps ? ` · ${o.steps}단계` : ''}
      </span>
      <time title={fullTime(log.at)}>{hm(log.at)}</time>
    </div>
  );
}

const SUBTYPE_LABEL: Record<string, string> = {
  ack: '접수 안내',
  auto: 'AI 자동 답변',
  auto_send: 'AI 자동 답변',
  approved: '초안 그대로',
  approved_edited: '수정해서 발송',
  human_reply: '직접 작성',
};

function ActivityRow({ a }: { a: Activity }) {
  if (a.type === 'email') {
    const byHuman = a.actor.type === 'user';
    const edited = (a.meta.editTags?.length ?? 0) > 0;
    const how = byHuman ? (a.subtype === 'human_reply' ? '직접 작성' : edited ? '수정해서 발송' : label(SUBTYPE_LABEL, a.subtype, '발송')) : null;
    return (
      <div className={`a-msg ${byHuman ? 'is-human' : 'is-ai'}`}>
        <div className="a-msg-head">
          <b>{byHuman ? `${a.actor.id ?? '상담원'} 발송 · ${how}` : 'AI 자동 답변'}</b>
          <span title={fullTime(a.occurredAt)}>
            {byHuman ? '' : '고객에게 발송됨 · '}
            {hm(a.occurredAt)}
          </span>
          <span className="spacer" />
          <span className={`tag ${byHuman ? 'tag-blue' : 'tag-purple'}`}>발송 완료</span>
        </div>
        <p className="a-msg-body">{a.body ?? a.summary}</p>
      </div>
    );
  }
  const tagText = a.type === 'note' ? '메모' : a.subtype === 'handoff' ? '넘김' : a.subtype === 'close' || a.subtype === 'closed' ? '종결' : '상태';
  const who = a.actor.type === 'user' ? `${a.actor.id ?? '상담원'} · ` : '';
  const reason = a.meta.handoffReason ? ` · ${label(HANDOFF_LABEL, a.meta.handoffReason)}` : '';
  return (
    <div className="a-logrow">
      <span>
        <span className={`tag${tagText === '종결' ? ' tag-dark' : a.actor.type === 'user' ? ' tag-blue' : ''}`}>{tagText}</span>
      </span>
      <span>
        {who}
        {a.type === 'note' ? a.body ?? a.summary : a.summary}
        {reason}
        {a.meta.nextAction ? ` · ${a.meta.nextAction}` : ''}
      </span>
      <time title={fullTime(a.occurredAt)}>{hm(a.occurredAt)}</time>
    </div>
  );
}

// ───────── A-200-P01 발송 확인 ─────────

export function SendConfirm(p: {
  no: string;
  subject: string;
  body: string;
  kind: SendKind;
  after: 'wait' | 'close';
  onAfter: (v: 'wait' | 'close') => void;
  busy: boolean;
  failure: string | null;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <Modal onClose={p.onCancel}>
      <h2 className="t-modal">이 답변을 보낼까요?</h2>
      <p className="modal-sub">
        {p.no} · {p.subject}
      </p>

      <div className="row gap-8" style={{ marginTop: 22 }}>
        <b className="t-13">보낼 답변</b>
        <span className="chip chip-ai">{SEND_KIND_LABEL[p.kind]}</span>
      </div>
      {/* 높이 고정 · 안쪽만 스크롤 (A-200-P01_spec) */}
      <div className="a-send-box is-fixed scroll">{p.body}</div>

      <b className="t-13" style={{ display: 'block', margin: '22px 0 10px' }}>
        보낸 뒤
      </b>
      <div role="radiogroup">
        <RadioCard
          checked={p.after === 'wait'}
          onSelect={() => p.onAfter('wait')}
          title="고객 답을 기다려요"
          desc="고객 회신 대기로 옮겨요"
          extra={<Todo what="보낸 뒤 처리 AI 추천" />}
        />
        <RadioCard checked={p.after === 'close'} onSelect={() => p.onAfter('close')} title="이 답변으로 종결해요" desc="바로 종결 처리해요" />
      </div>
      <p className="note" style={{ marginTop: 18 }}>
        고객 답을 기다리는 건은 오래 답이 없으면 자동 종결돼요 (서버 설정 기준)
      </p>
      {p.failure && <p className="field-error">{p.failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={p.onCancel} disabled={p.busy}>
          취소
        </button>
        <button type="button" className={`btn btn-md btn-primary${p.busy ? ' is-loading' : ''}`} onClick={() => !p.busy && p.onSend()}>
          {p.busy ? '보내는 중' : '보내기'}
        </button>
      </div>
    </Modal>
  );
}

// ───────── A-200-P02 발송 완료 ─────────

function SentDone({ no, closed, currentId, onClose }: { no: string; closed: boolean; currentId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data } = useLive(loadCases, [], []);
  const next = data ? firstToSee(data.filter((c) => c.id !== currentId))[0]?.c ?? null : null;
  return (
    <Modal onClose={onClose}>
      <div className="a-done-icon">
        <Check size={26} strokeWidth={2} color="#24cd5d" />
      </div>
      <h2 className="t-modal" style={{ textAlign: 'center' }}>
        고객에게 보냈어요
      </h2>
      <p className="modal-sub" style={{ textAlign: 'center' }}>
        {no} · {closed ? '종결했어요' : '고객 회신 대기로 옮겼어요'}
      </p>
      <button
        type="button"
        className="btn btn-lg btn-primary btn-block"
        style={{ marginTop: 22 }}
        disabled={!next}
        onClick={() => next && navigate(`/A-200/${next.id}`, { state: { from: '/A-100' } })}
      >
        {next ? '다음 급한 건 응답하기' : '급한 건이 없어요'}
      </button>
      <button type="button" className="btn btn-md btn-line btn-block" style={{ marginTop: 10 }} onClick={() => {
          toast('고객에게 보냈어요');
          navigate('/A-100');
        }}
      >
        문의함으로
      </button>
    </Modal>
  );
}

// ───────── A-200-P03 관리자에게 넘기기 ─────────

const HANDOVER_REASONS = [
  { key: 'authority', title: '권한 밖', desc: '법적 판단이나 금액 결정이 필요해요' },
  { key: 'expertise', title: '전문 분야 아님', desc: '다른 팀의 기준이 필요해요' },
  { key: 'hard', title: '응대 어려움', desc: '오늘 고감정 응대가 많거나 감정 부담이 커요' },
  { key: 'other', title: '기타', desc: '직접 입력' },
];

function HandoverModal({ no, subject, onClose }: { no: string; subject: string; onClose: () => void }) {
  const [reason, setReason] = useState('authority');
  const [memo, setMemo] = useState('');
  return (
    <Modal onClose={onClose}>
      <h2 className="t-modal">관리자에게 넘길까요?</h2>
      <p className="modal-sub">
        {no} · {subject}
      </p>
      <b className="t-13" style={{ display: 'block', margin: '22px 0 10px' }}>
        넘기는 이유 <span className="brand">필수</span>
      </b>
      <div role="radiogroup">
        {HANDOVER_REASONS.map((r) => (
          <RadioCard key={r.key} checked={reason === r.key} onSelect={() => setReason(r.key)} title={r.title} desc={r.desc} />
        ))}
      </div>
      <b className="t-13" style={{ display: 'block', margin: '22px 0 8px' }}>
        관리자에게 남길 말 <span className="hint" style={{ fontWeight: 400 }}>선택</span>
      </b>
      <textarea className="textarea" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
      <p className="note" style={{ marginTop: 18 }}>
        넘기면 이 건은 내 문의함에서 빠지고, AI 초안과 지금까지 대화가 그대로 관리자에게 가요
      </p>
      <div style={{ marginTop: 14 }}>
        <Todo block what="상담원 → 관리자 이관 (관리자 이관함 · 담당자 개념이 백엔드에 없음)" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-primary" disabled>
          관리자에게 넘기기
        </button>
      </div>
    </Modal>
  );
}

// ───────── A-200-P04 답변 없이 종결 확인 / A-230-P01 지금 종결 확인 (같은 모달 · 문구만 다름) ─────────

export function CloseConfirm(p: { waiting: boolean; busy: boolean; failure: string | null; onCancel: () => void; onClose: (reason: string) => void }) {
  // 서버는 종결 사유가 필수다. Figma 팝업에는 사유 선택이 없어 화면별로 고정 사유를 보낸다.
  //   답변 없이 종결 → not_applicable(해당 없음) · 지금 종결(회신 대기) → no_response(고객 무응답)
  const reason = p.waiting ? 'no_response' : 'not_applicable';
  return (
    <Modal onClose={p.onCancel} width={520}>
      <h2 className="t-modal">
        {p.waiting ? '지금 이 문의를 종결할까요?' : '답변 없이 이 문의를 종결할까요?'}
      </h2>
      <p className="modal-sub t-13">{p.waiting ? '고객 답을 기다리지 않고 이 문의를 종결합니다.' : '고객에게 메시지를 보내지 않고 이 문의를 종결합니다.'}</p>
      {p.failure && <p className="field-error">{p.failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={p.onCancel} disabled={p.busy}>
          취소
        </button>
        <button type="button" className={`btn btn-md btn-primary${p.busy ? ' is-loading' : ''}`} onClick={() => !p.busy && p.onClose(reason)}>
          {p.busy ? '종결하는 중' : p.waiting ? '지금 종결' : '답변 없이 종결'}
        </button>
      </div>
    </Modal>
  );
}
