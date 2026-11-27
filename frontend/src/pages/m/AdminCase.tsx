import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, errorText, type CrmDetail, type RawDetail } from '../../lib/api';
import { loadCases, useLive, type InboxCase } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { CLOSE_REASON_LABEL, HANDOFF_LABEL, ORIGIN_LABEL, OUTCOME_LABEL, REASON_LABEL, RISK_REASONS, label } from '../../lib/labels';
import { monthDayTime, receivedAt, relTime, shortNo } from '../../lib/format';
import { Modal, Sentiment, Todo, useToast } from '../../components/ui';
import { CloseConfirm, SendConfirm, SidePanels, Timeline, latestTriage, type SendKind } from '../a/CaseDetail';
import { STAGE_LABEL, assigneeOf, stageDetail, stageOf } from './model';
import '../a/a.css';
import './m.css';

type Detail = { crm: CrmDetail; raw: RawDetail | null };
type Screen = 'M-111' | 'M-202' | 'M-300' | 'M-310' | 'M-320';

/**
 * M-111 팀 문의함 · 문의 상세 (관리자는 확인만)
 * M-202 관리자 이관 · 이관 상세 (직접 처리 / 재배정 선택)
 * M-300 직접 처리 · 답변 작성 → M-310 고객 회신 대기 → M-320 종결
 */
export function AdminCase() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const by = session?.name ?? '';
  const navigate = useNavigate();
  const location = useLocation();
  const screen = (location.pathname.split('/')[1] ?? 'M-111') as Screen;
  const toast = useToast();

  const loader = useCallback(async (): Promise<Detail> => {
    const [crm, raw] = await Promise.all([api.crmCase(id), api.rawCase(id).catch(() => null)]);
    return { crm, raw };
  }, [id]);
  const { data, error, loading, reload } = useLive(loader, [id]);

  const [mode, setMode] = useState<'view' | 'edit' | 'write'>('view');
  const [text, setText] = useState('');
  const [popup, setPopup] = useState<null | 'send' | 'close' | 'reassign'>(null);
  const [after, setAfter] = useState<'wait' | 'close'>('wait');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [openRaw, setOpenRaw] = useState<Set<string>>(new Set());

  // 직접 처리 화면은 문의 상태에 따라 번호가 바뀐다.
  const st = data?.crm.case;
  const handling = screen === 'M-300' || screen === 'M-310' || screen === 'M-320';
  const canonical = !st || !handling ? null : st.status === 'Closed' ? 'M-320' : st.subStatus === 'Waiting on Customer' ? 'M-310' : 'M-300';
  useEffect(() => {
    if (canonical && canonical !== screen) navigate(`/${canonical}/${id}`, { replace: true });
  }, [canonical, screen, id, navigate]);

  if (error) return <main className="page"><div className="card error-box">{errorText(error)}</div></main>;
  if (loading && !data) return <main className="page"><div className="card loading">불러오는 중…</div></main>;
  if (!data) return null;

  const { crm, raw } = data;
  const c = crm.case;
  const asInbox: InboxCase = { ...c, raw: raw?.case ?? null };
  const stage = stageOf(asInbox);
  const who = assigneeOf(asInbox);
  const draft = crm.pendingDraft;
  const briefing = raw?.handoffs.at(-1)?.briefing ?? null;
  const aiDraft = draft?.body ?? briefing?.recommendedReply ?? '';
  const can = (a: CrmDetail['actions'][number]) => crm.actions.includes(a);
  const customer = c.suppliedName ?? crm.contact?.current?.name?.value ?? c.suppliedEmail ?? '고객';
  const reasonKey = c.resolution.handoffReason;
  const sendKind: SendKind = mode === 'write' ? 'written' : mode === 'edit' && text.trim() !== aiDraft.trim() ? 'edited' : 'draft';
  const outgoing = mode === 'view' ? aiDraft : text;
  const from = (location.state as { from?: string } | null)?.from;
  const back = screen === 'M-111' ? { to: from ?? '/M-110', text: '팀 문의함' } : { to: '/M-200', text: '관리자 이관' };
  const mineNow = who !== null && who === by;
  const closedEntry = [...c.statusHistory].reverse().find((h) => h.toStatus === 'Closed');

  const toggleRaw = (key: string) =>
    setOpenRaw((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const takeOver = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (can('takeover')) await api.takeover(c.id, by);
      navigate(`/M-300/${c.id}`);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (sendKind === 'draft' && draft && can('approve')) await api.approve(draft.id, by);
      else if (sendKind === 'edited' && draft && can('edit_approve')) await api.approve(draft.id, by, text);
      else await api.humanReply(c.id, by, outgoing);
      if (after === 'close') await api.close(c.id, by, 'resolved');
      toast(`${shortNo(c.caseNumber)} · 고객에게 보냈어요`);
      setMode('view');
      setPopup(null);
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
      toast(`${shortNo(c.caseNumber)} · 종결했어요`);
      setPopup(null);
      reload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <Link to={back.to} className="back">
        <ArrowLeft size={14} strokeWidth={2} />
        {back.text}
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
            {reasonKey && <span className={`tag${RISK_REASONS.has(reasonKey) ? ' tag-risk' : ''}`}>{label(HANDOFF_LABEL, reasonKey)}</span>}
          </div>
          <div className="card m-stagebar">
            <span className="hint">현재 단계</span>
            <i className="dot" style={{ background: stage === 'human' ? 'var(--secondary-500)' : stage === 'closed' ? 'var(--status-ok)' : stage === 'wait' ? 'var(--status-wait)' : 'var(--primary-500)' }} />
            <b>
              {STAGE_LABEL[stage]}
              {screen === 'M-310' || screen === 'M-320' ? '' : ` · ${stage === 'human' && mineNow && handling ? '관리자 직접 처리 중' : stageDetail(asInbox)}`}
            </b>
            <span className="hint" style={{ marginLeft: 10 }}>
              담당자
            </span>
            <b>{stage === 'ai' ? 'AI' : who ?? '담당 없음'}</b>
          </div>
        </div>
      </div>

      <div className="a-detail">
        <div>
          {screen === 'M-111' && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center' }}>
                <i className="dot" style={{ background: 'var(--secondary-500)' }} />
                <h2 className="t-h2">BATON 자동 배정 결과 · {stage === 'ai' ? 'AI' : who ?? '담당 없음'}</h2>
                <span className="spacer" />
                <span className="hint t-12">{relTime(raw?.case.updated_at ?? c.audit.updatedAt)}</span>
              </header>
              <p className="t-13 tertiary">
                {reasonKey
                  ? `${label(HANDOFF_LABEL, reasonKey)} 사유로 사람에게 넘어왔어요.`
                  : c.subStatus === 'Awaiting Approval'
                    ? 'AI가 초안을 만들었고, 사람의 승인을 기다리고 있어요.'
                    : 'AI가 처리하고 있는 문의예요.'}{' '}
                {c.resolution.nextAction ? `다음 조치: ${c.resolution.nextAction}` : ''} <Todo what="상담원 자동 배정과 배정 이유 설명 (업무량 · 경험 기준)" />
              </p>
              <div className="a-compose-actions">
                <button type="button" className="btn btn-sm btn-line" disabled={stage !== 'human'} onClick={() => setPopup('reassign')}>
                  담당자 변경
                </button>
                <span className="hint t-12">필요할 때만 바꿔요 · 바꾸면 AI 초안과 이력이 새 담당자에게 그대로 넘어가요</span>
              </div>
            </section>
          )}

          {screen === 'M-202' && (
            <section className="card a-panel m-escalated">
              <header style={{ alignItems: 'center' }}>
                <i className="dot dot-risk" />
                <h2 className="t-h2">상담원이 넘긴 문의예요</h2>
                <span className="spacer" />
                <span className="hint t-12">이관 시각 · 대기 시간</span>
              </header>
              <Todo block what="상담원이 넘긴 사유 · 메모 (A-200-P03 이관이 백엔드에 없음) — 지금 보이는 건 실제 이관 건이 아니라 화면 구성이에요" />
            </section>
          )}

          <section className="card a-panel">
            <header>
              <h2 className="t-h2">응대 이력</h2>
              <span className="hint t-12">시간 순서대로 모두 저장돼요</span>
            </header>
            <Timeline crm={crm} customer={customer} openRaw={openRaw} onToggleRaw={toggleRaw} />
          </section>

          {screen === 'M-111' && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center', marginBottom: 6 }}>
                <i className="dot" style={{ background: 'var(--secondary-500)' }} />
                <h2 className="t-h2">
                  {stage === 'closed' ? '종결된 문의예요' : stage === 'human' ? (who ? `${who} 님이 응대 중이에요` : '아직 맡은 사람이 없어요') : stage === 'wait' ? '고객 답을 기다리고 있어요' : 'AI가 응대 중이에요'}
                </h2>
              </header>
              <p className="t-13 tertiary">관리자는 확인만 해요. 필요할 때만 위 카드에서 담당자를 바꾸세요.</p>
            </section>
          )}

          {screen === 'M-202' && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center', marginBottom: 6 }}>
                <i className="dot dot-risk" />
                <h2 className="t-h2">어떻게 처리할까요?</h2>
              </header>
              <p className="t-13 tertiary">직접 답하거나, 다른 상담원에게 다시 배정할 수 있어요. AI 초안과 지금까지의 이력은 그대로 넘어가요.</p>
              {failure && <p className="field-error">{failure}</p>}
              <div className="a-compose-actions" style={{ paddingTop: 14, borderTop: '1px solid var(--border-default)' }}>
                <button type="button" className="btn btn-md btn-primary" disabled={busy || stage === 'closed'} onClick={takeOver}>
                  내가 직접 처리
                </button>
                <button type="button" className="btn btn-md btn-line" onClick={() => setPopup('reassign')}>
                  상담원에게 재배정
                </button>
                <span className="spacer" />
                <span className="hint t-12">재배정은 팀 상담원 전체에서 관리자가 직접 골라요</span>
              </div>
            </section>
          )}

          {screen === 'M-300' && (
            <section className="card a-panel a-compose">
              <header>
                <h2 className="t-h2">답변 작성</h2>
                {mode !== 'write' && aiDraft && <span className="chip chip-ai">AI 초안</span>}
                <span className="hint t-12">
                  관리자 {by}가 직접 처리 중이에요 ·{' '}
                  {mode === 'view' ? '이대로 보내면 “초안 그대로”로 기록돼요' : mode === 'edit' ? '원래 초안과 달라지면 “수정해서 발송”으로 기록돼요' : '“직접 작성”으로 기록돼요'}
                </span>
              </header>
              {mode === 'view' ? (
                <div className="a-compose-view">{aiDraft || <span className="hint">AI 초안이 없는 문의예요 · 직접 작성해 주세요</span>}</div>
              ) : (
                <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="고객에게 보낼 답변을 작성해 주세요" autoFocus />
              )}
              <div className="a-compose-actions">
                {mode === 'view' ? (
                  <>
                    <button type="button" className="btn btn-md btn-primary" disabled={!aiDraft} onClick={() => setPopup('send')}>
                      그대로 발송
                    </button>
                    <button
                      type="button"
                      className="btn btn-md btn-line"
                      disabled={!aiDraft}
                      onClick={() => {
                        setText(aiDraft);
                        setMode('edit');
                      }}
                    >
                      수정하기
                    </button>
                    <button
                      type="button"
                      className="btn btn-md btn-line"
                      onClick={() => {
                        setText('');
                        setMode('write');
                      }}
                    >
                      직접 작성
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-md btn-primary" disabled={!text.trim()} onClick={() => setPopup('send')}>
                      {mode === 'edit' ? '수정한 내용으로 발송' : '작성한 내용으로 발송'}
                    </button>
                    <button type="button" className="btn btn-md btn-line" onClick={() => setMode('view')}>
                      취소
                    </button>
                  </>
                )}
                <span className="spacer" />
                <button type="button" className="btn btn-md btn-line" disabled={!can('close')} onClick={() => setPopup('close')}>
                  답변 없이 종결
                </button>
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <span className="hint t-12">발송하면 고객 답장은 {by}에게 와요 · 수정해서 보내면 그 차이가 학습 데이터로 쌓여요</span>
                <span className="spacer" />
                <button type="button" className="t-12 strong" onClick={() => setPopup('reassign')}>
                  상담원에게 재배정
                </button>
              </div>
            </section>
          )}

          {screen === 'M-310' && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center', marginBottom: 6 }}>
                <i className="dot dot-wait" />
                <h2 className="t-h2">고객 답을 기다리고 있어요</h2>
              </header>
              <p className="t-13 tertiary">
                오래 답이 없으면 자동 종결돼요. 고객이 답장하면 담당자에게 다시 와요. <Todo what="자동 종결 예정일 조회" />
              </p>
            </section>
          )}

          {screen === 'M-320' && (
            <section className="card a-panel">
              <header style={{ alignItems: 'center', marginBottom: 6 }}>
                <i className="dot dot-ok" />
                <h2 className="t-h2">
                  {closedEntry?.changedBy.type === 'user' ? '사람이 종결했어요' : 'AI가 자동 종결했어요'} · {monthDayTime(closedEntry?.changedAt ?? c.audit.updatedAt)}
                </h2>
                <span className="spacer" />
                <span className="hint t-12">
                  {label(OUTCOME_LABEL, c.resolution.outcome, '답변 없이 종결')} · {label(CLOSE_REASON_LABEL, c.closeReason, '종결')}
                </span>
              </header>
              <p className="t-13 tertiary">종결된 문의라 여기서는 고칠 수 없어요.</p>
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
      {popup === 'close' && (
        <CloseConfirm
          waiting={screen === 'M-310'}
          busy={busy}
          failure={failure}
          onCancel={() => {
            setPopup(null);
            setFailure(null);
          }}
          onClose={closeCase}
        />
      )}
      {popup === 'reassign' && <ReassignModal current={who} c={asInbox} reassign={screen !== 'M-111'} reason={reasonKey} onClose={() => setPopup(null)} />}
    </main>
  );
}

/** M-111-P01 담당자 변경 / M-202-P01 재배정 (같은 모달) */
function ReassignModal({ current, c, reassign, reason, onClose }: { current: string | null; c: InboxCase; reassign: boolean; reason: string | null; onClose: () => void }) {
  const { data } = useLive(loadCases, [], []);
  const [pick, setPick] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
  const agents = useMemo(() => {
    const all = data ?? [];
    const names = [...new Set(all.map(assigneeOf).filter((n): n is string => Boolean(n)))];
    return names.map((name) => ({ name, open: all.filter((x) => assigneeOf(x) === name && x.status !== 'Closed').length }));
  }, [data]);

  return (
    <Modal onClose={onClose} width={660}>
      <h2 className="t-modal">{reassign ? '다른 상담원에게 재배정' : '담당자 변경'}</h2>
      <p className="modal-sub t-13">
        {reassign ? '상담원이 넘긴 문의예요. ' : ''}팀 상담원 전체에서 원하는 사람을 골라주세요. 근무 상태, 열린 문의 수, 고감정 응대 건수는 참고 정보예요.
      </p>
      <div className="note row gap-8" style={{ marginTop: 14 }}>
        <span className="mono">{shortNo(c.caseNumber)}</span>
        <b style={{ color: 'var(--gray-900)' }}>{c.subject}</b>
        <span className="tag">{label(REASON_LABEL, c.caseReason)}</span>
        {reason && <span className={`tag${RISK_REASONS.has(reason) ? ' tag-risk' : ''}`}>{label(HANDOFF_LABEL, reason)}</span>}
        <span className="spacer" />
        {c.signals && (
          <b className={`row${c.signals.sentiment >= 4 ? ' risk' : ''}`} style={{ gap: 6 }}>
            <i className={`dot${c.signals.sentiment >= 4 ? ' dot-risk' : ''}`} />
            감정 {c.signals.sentiment}
          </b>
        )}
      </div>
      <div role="radiogroup" style={{ marginTop: 12 }}>
        {agents.map((a) => (
          <button key={a.name} type="button" role="radio" aria-checked={pick === a.name} className="radio-card" onClick={() => setPick(a.name)}>
            <i className="radio" />
            <span className="avatar">{a.name.slice(0, 1)}</span>
            <span style={{ flex: 1 }}>
              <b>{a.name}</b>
              {a.name === current && (
                <span className="tag" style={{ marginLeft: 8 }}>
                  현재 담당
                </span>
              )}
            </span>
            <span className="t-12 hint" style={{ textAlign: 'right' }}>
              배정된 건
              <b style={{ display: 'block', color: 'var(--gray-900)', fontSize: 13 }}>{a.open}</b>
            </span>
          </button>
        ))}
        {!agents.length && <div className="empty">고를 수 있는 상담원이 없어요</div>}
      </div>
      <b className="t-13" style={{ display: 'block', margin: '18px 0 8px' }}>
        새 담당자에게 남길 말 <span className="hint" style={{ fontWeight: 400 }}>선택</span>
      </b>
      <textarea className="textarea" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
      <div style={{ marginTop: 14 }}>
        <Todo block what="담당자 지정 · 재배정 (상담원 목록 · 근무 상태 · 배정 API가 백엔드에 없음)" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-primary" disabled>
          {pick ? `${pick}님에게 재배정하기` : '재배정하기'}
        </button>
      </div>
    </Modal>
  );
}
