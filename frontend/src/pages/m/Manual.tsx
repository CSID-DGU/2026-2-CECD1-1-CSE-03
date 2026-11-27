import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Pencil, X } from 'lucide-react';
import { ApiError, api, errorText, get, post, type CrmDetail } from '../../lib/api';
import { useLive } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { CHANNEL_LABEL, HANDOFF_LABEL, REASON_LABEL, label } from '../../lib/labels';
import { Modal, Todo, useToast } from '../../components/ui';
import { COMPANY } from '../../components/Gnb';
import { SettingsHead } from './SettingsShell';
import '../a/a.css';
import './m.css';

// S-110 매뉴얼 설정 + S-120 답변 시뮬레이션 (같은 화면의 왼쪽 · 오른쪽)
// 기존 백오피스의 "지식 · 정책" 기능(server/console.js)에 연결한다.

type Level = 'L0' | 'L1' | 'L2' | 'H';
type Intent = { level: Level; description: string; kb?: string[]; caseType?: string; caseReason?: string };
type Pack = {
  channel: string;
  label: string;
  intents: Record<string, Intent>;
  handoffReasons: string[];
  thresholds: { confidenceMin: number; maxRounds: number; repeatLimit: number; maxLength: number };
  guard: { forbiddenWords: string[]; forbiddenWordsEn?: string[] };
};
type PolicyView = { pack: Pack; version: string; live: boolean; invalid: boolean; problems: { path: string; msg: string }[] };
type KbView = { srcHash: string; version: string; sections: { key: string; title: string; chars: number; expired: boolean }[] };
type Draft = { id: string; status: 'converting' | 'ready' | 'failed' | 'published' | 'discarded'; sourceName: string | null; origin: string; error: string | null; updatedAt: string };
type ConsoleInfo = { admin: boolean; writable: boolean; actor: string | null; channels: { channel: string; label: string }[] };

const LEVELS: { key: Level; text: string }[] = [
  { key: 'L2', text: 'AI 자동' },
  { key: 'L1', text: '승인 후 발송' },
  { key: 'H', text: '사람 전달' },
];
const TYPE_LABEL: Record<string, string> = { Question: '질문', Problem: '장애' };
const HIDDEN_INTENTS = new Set(['ack', 'ignore']);

function consoleError(e: unknown): string {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      not_admin: '이 이름은 서버의 ADMIN_USERS 에 없어서 게시할 수 없어요.',
      console_write_untrusted: '이 접속 경로에서는 설정을 바꿀 수 없어요 (localhost 에서만 가능).',
      stale: '그 사이 다른 사람이 게시했어요. 새로고침해 주세요.',
      l2_not_eligible: 'AI 자동으로 올릴 조건(검토 50건 · 무수정 90% · 치명 0건)을 아직 채우지 못했어요.',
      invalid: '규칙에 맞지 않는 값이 있어요.',
      unsupported_format: '지원하지 않는 파일 형식이에요.',
      convert_busy: '이미 분석 중인 파일이 있어요.',
      job_too_large: '파일이 너무 커요.',
      budget_headroom: '토큰 예산이 부족해 분석할 수 없어요.',
    };
    return map[e.code] ?? errorText(e);
  }
  return errorText(e);
}

export function Manual() {
  const { session } = useSession();
  const by = session?.name ?? '';
  const q = `by=${encodeURIComponent(by)}`;
  const toast = useToast();
  const [channel, setChannel] = useState('support');
  const [pack, setPack] = useState<Pack | null>(null);
  const [popup, setPopup] = useState<null | 'publish' | 'rules'>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [word, setWord] = useState('');

  const loader = useCallback(async () => {
    const [info, policy, kb, drafts] = await Promise.all([
      get<ConsoleInfo>(`/api/console?${q}`),
      get<PolicyView>(`/api/console/policy/${channel}?${q}`),
      get<KbView>(`/api/console/kb/${channel}?lang=ko&${q}`),
      get<{ items: Draft[] }>(`/api/console/drafts?channel=${channel}&${q}`),
    ]);
    return { info, policy, kb, drafts: drafts.items.filter((d) => d.status === 'converting' || d.status === 'ready' || d.status === 'failed') };
  }, [channel, q]);
  const { data, error, loading, reload } = useLive(loader, [channel], ['config.changed']);

  // 서버 값이 바뀌면(채널 전환 · 게시 후) 편집본을 서버 값으로 맞춘다.
  const serverVersion = data?.policy.version;
  useEffect(() => {
    if (data) setPack(structuredClone(data.policy.pack));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVersion, channel]);

  // 분석 중인 초안이 있으면 3초마다 다시 확인한다.
  const converting = data?.drafts.some((d) => d.status === 'converting');
  useEffect(() => {
    if (!converting) return;
    const t = window.setInterval(reload, 3000);
    return () => window.clearInterval(t);
  }, [converting, reload]);

  // 게시본과 달라진 점 — 게시 확인 팝업(S-110-P04)과 초안 안내 줄에 쓴다
  const changes = useMemo(() => {
    if (!data || !pack) return [] as string[];
    const live = data.policy.pack;
    const out: string[] = [];
    const name: Record<string, string> = { L2: 'AI 자동', L1: '승인 후 발송', H: '사람 전달', L0: '섀도' };
    for (const [k, v] of Object.entries(pack.intents)) {
      const before = live.intents[k]?.level;
      if (before && before !== v.level) out.push(`처리 수준: ${v.description} · ${name[before]} → ${name[v.level]}`);
    }
    const added = pack.guard.forbiddenWords.filter((w) => !live.guard.forbiddenWords.includes(w));
    const removed = live.guard.forbiddenWords.filter((w) => !pack.guard.forbiddenWords.includes(w));
    if (added.length) out.push(`금지 표현 추가: ${added.join(', ')}`);
    if (removed.length) out.push(`금지 표현 삭제: ${removed.join(', ')}`);
    const tl: Record<string, string> = { confidenceMin: '답변 확신도 기준', repeatLimit: '같은 질문 반복 한도', maxRounds: '왕복 한도', maxLength: '답변 최대 길이' };
    (Object.keys(tl) as (keyof Pack['thresholds'])[]).forEach((k) => {
      if (pack.thresholds[k] !== live.thresholds[k]) out.push(`${tl[k]} ${live.thresholds[k]} → ${pack.thresholds[k]}`);
    });
    return out;
  }, [data, pack]);
  const dirty = changes.length > 0;
  const canWrite = Boolean(data?.info.admin);
  const intents = useMemo(() => Object.entries(pack?.intents ?? {}).filter(([k]) => !HIDDEN_INTENTS.has(k)), [pack]);
  const countLevel = (l: Level) => intents.filter(([, v]) => v.level === l).length;

  const setLevel = (name: string, level: Level) => setPack((p) => (p ? { ...p, intents: { ...p.intents, [name]: { ...p.intents[name], level } } } : p));
  const setWords = (words: string[]) => setPack((p) => (p ? { ...p, guard: { ...p.guard, forbiddenWords: words } } : p));

  const publish = async () => {
    if (!data || !pack) return;
    setBusy(true);
    setFailure(null);
    try {
      await post(`/api/console/policy/${channel}/publish`, { by, pack, baseVersion: data.policy.version });
      toast('처리 규칙을 게시했어요');
      setPopup(null);
      reload();
    } catch (e) {
      setFailure(consoleError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <main className="page"><div className="card error-box">{errorText(error)}</div></main>;
  if ((loading && !data) || !data || !pack) return <main className="page"><div className="card loading">불러오는 중…</div></main>;

  const t = pack.thresholds;
  return (
    <main className="page">
      <SettingsHead
        tab="manual"
        title="매뉴얼 설정"
        sub="매뉴얼을 읽고 만든 카테고리 · 처리 규칙 · 접수 페이지를 확인하고 고쳐요"
        action={
          <>
            <span className={`chip ${dirty ? 'chip-ai' : 'chip-done'}`}>{dirty ? '편집 중인 초안' : `게시됨 ${data.policy.version.slice(0, 6)}`}</span>
            <button type="button" className="btn btn-md btn-primary" disabled={!dirty || !canWrite} title={!canWrite ? 'ADMIN_USERS 에 등록된 이름만 게시할 수 있어요' : !dirty ? '바꾼 내용이 없어요' : undefined} onClick={() => setPopup('publish')}>
              게시하기
            </button>
          </>
        }
      />

      <div className="row gap-10" style={{ marginTop: 4, flexWrap: 'wrap' }}>
        <span className="m-step is-done">
          <Check size={13} strokeWidth={2.5} /> 매뉴얼 업로드
        </span>
        <span className={`m-step ${converting ? 'is-on' : 'is-done'}`}>
          {converting ? <b>2</b> : <Check size={13} strokeWidth={2.5} />} AI 분석
        </span>
        <span className={`m-step${converting ? '' : ' is-on'}`}>
          <b>3</b> 카테고리 · 규칙 확인
        </span>
        <span className="m-step">
          <b>4</b> 접수 페이지 게시
        </span>
        <span className="spacer" />
        <div className="segment" role="group" aria-label="접수 창구">
          {data.info.channels.map((ch) => (
            <button key={ch.channel} type="button" aria-pressed={channel === ch.channel} onClick={() => setChannel(ch.channel)}>
              {label(CHANNEL_LABEL, ch.channel)}
            </button>
          ))}
        </div>
      </div>
      <div className="m-draftbar">
        <span className={`chip ${dirty ? 'chip-ai' : 'chip-gray'}`}>{dirty ? '편집 중인 초안' : '게시본'}</span>
        <span className="t-13">
          현재 게시본 <b className="mono">{data.policy.version.slice(0, 6)}</b> · {dirty ? `게시본 대비 변경 ${changes.length}건` : '게시본과 같아요'}
        </span>
        <span className="spacer" />
        <span className="hint t-12">게시하기 전까지 고객에게 보이지 않아요</span>
      </div>
      {!canWrite && (
        <div style={{ marginTop: 12 }}>
          <div className="todo-block">지금 이름({by})은 서버의 ADMIN_USERS 에 없어 보기만 할 수 있어요. 게시 · 업로드는 관리자 이름으로 로그인해야 해요.</div>
        </div>
      )}

      <div className="m-two" style={{ gridTemplateColumns: '608fr 392fr' }}>
        <div>
          <Uploads channel={channel} by={by} kb={data.kb} drafts={data.drafts} canWrite={canWrite} onChanged={reload} />

          <section className="card a-panel">
            <header style={{ alignItems: 'center' }}>
              <h2 className="t-h2">AI가 매뉴얼에서 찾은 것</h2>
              <span className="spacer" />
              <span className="chip chip-ai">분석 요약</span>
            </header>
            <div className="m-found">
              <div>
                <span>문의 카테고리</span>
                <b>{intents.length}</b>
              </div>
              <div>
                <span>응대 지식</span>
                <b>{data.kb.sections.length}</b>
              </div>
              <div>
                <span>커스텀 필드</span>
                <b>
                  <Todo what="접수 폼 커스텀 필드" />
                </b>
              </div>
              <div>
                <span>금지 표현</span>
                <b>{pack.guard.forbiddenWords.length}</b>
              </div>
            </div>
          </section>

          <section className="card a-panel">
            <header style={{ alignItems: 'center' }}>
              <h2 className="t-h2">문의 카테고리와 처리 수준</h2>
              <span className="hint t-12">
                AI 자동 {countLevel('L2')} · 승인 후 발송 {countLevel('L1')} · 사람 전달 {countLevel('H')}
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm btn-line" disabled title="기능 구현 필요: 화면에서 카테고리 추가">
                + 카테고리 추가
              </button>
            </header>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table m-levels">
                <thead>
                  <tr>
                    <th>카테고리</th>
                    <th>유형</th>
                    <th>처리 수준</th>
                    <th>매뉴얼 근거</th>
                  </tr>
                </thead>
                <tbody>
                  {intents.map(([name, it]) => (
                    <tr key={name} style={{ cursor: 'default' }}>
                      <td className="left" title={name}>
                        <b style={{ color: 'var(--gray-900)', whiteSpace: 'normal' }}>{it.description}</b>
                      </td>
                      <td>
                        <span className="tag">{label(TYPE_LABEL, it.caseType, label(REASON_LABEL, it.caseReason))}</span>
                      </td>
                      <td>
                        <div className="m-level" role="group" aria-label={`${it.description} 처리 수준`}>
                          {LEVELS.map((l) => (
                            <button key={l.key} type="button" aria-pressed={it.level === l.key} disabled={!canWrite} onClick={() => setLevel(name, l.key)}>
                              {l.text}
                            </button>
                          ))}
                        </div>
                        {it.level === 'L0' && <div className="cell-sub">섀도 (초안만 만들고 보내지 않음)</div>}
                      </td>
                      <td>
                        {(it.kb ?? []).length ? (
                          (it.kb ?? []).map((k) => (
                            <button key={k} type="button" className="m-kbref" onClick={() => setEvidence(k)}>
                              § {k}
                            </button>
                          ))
                        ) : (
                          <span className="hint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card a-panel">
            <header>
              <h2 className="t-h2">접수 폼 커스텀 필드</h2>
              <span className="hint t-12">매뉴얼의 “접수 시 확인 사항”에서 뽑았어요</span>
            </header>
            <Todo block what="접수 폼 커스텀 필드 (주문번호 · 연락처 · 사진 첨부 같은 추가 입력칸)" />
          </section>

          <section className="card a-panel">
            <header>
              <h2 className="t-h2">AI가 쓰면 안 되는 표현</h2>
              <span className="hint t-12">답변 초안에 나오면 발송을 막고 사람에게 넘겨요</span>
            </header>
            <div className="x-chips">
              {pack.guard.forbiddenWords.map((w) => (
                <span key={w} className="m-word">
                  {w}
                  {canWrite && (
                    <button type="button" aria-label={`${w} 삭제`} onClick={() => setWords(pack.guard.forbiddenWords.filter((x) => x !== w))}>
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
              {canWrite && (
                <form
                  className="m-word"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = word.trim();
                    if (v && !pack.guard.forbiddenWords.includes(v)) setWords([...pack.guard.forbiddenWords, v]);
                    setWord('');
                  }}
                >
                  <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="+ 추가" aria-label="금지 표현 추가" />
                </form>
              )}
            </div>
          </section>

          <section className="card a-panel">
            <header style={{ alignItems: 'center' }}>
              <h2 className="t-h2">사람에게 넘기는 규칙</h2>
              <span className="spacer" />
              <button type="button" className="btn btn-sm btn-line" disabled title="기능 구현 필요: 규칙 추가">
                + 규칙 추가
              </button>
            </header>
            <Rule when={`답변 확신도 ${t.confidenceMin} 미만`} then="사람에게 넘겨요 (확신도 낮음)" onEdit={canWrite ? () => setPopup('rules') : undefined} />
            <Rule when={`같은 질문 ${t.repeatLimit}회 반복 · 왕복 ${t.maxRounds}회 초과`} then="진척 없음으로 사람 연결" onEdit={canWrite ? () => setPopup('rules') : undefined} />
            <Rule when={`답변 ${t.maxLength}자 초과 · 금지 표현 · 금액/날짜 임의 안내`} then="본문 검사에서 막고 사람에게 넘김" onEdit={canWrite ? () => setPopup('rules') : undefined} />
            {pack.handoffReasons.map((r) => (
              <Rule key={r} when={label(HANDOFF_LABEL, r)} then="즉시 사람 전달" />
            ))}
          </section>
        </div>

        <Simulation channel={channel} pack={pack} dirty={dirty} version={data.policy.version} />
      </div>

      {popup === 'publish' && (
        <Modal
          onClose={() => {
            setPopup(null);
            setFailure(null);
          }}
          width={520}
        >
          <h2 className="t-modal">접수 페이지를 게시할까요?</h2>
          <p className="modal-sub t-13">
            {label(CHANNEL_LABEL, channel)} 창구에 적용되는 버전이 <b className="mono">{data.policy.version.slice(0, 6)}</b>에서 새 버전으로 바뀌어요.
          </p>
          <div className="m-diffbox">
            <b>게시 전 확인 · 변경 내용</b>
            {changes.map((c) => (
              <div key={c}>· {c}</div>
            ))}
          </div>
          {failure && <p className="field-error">{failure}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-md btn-line" onClick={() => setPopup(null)} disabled={busy}>
              취소
            </button>
            <button type="button" className={`btn btn-md btn-primary${busy ? ' is-loading' : ''}`} onClick={() => !busy && publish()}>
              {busy ? '게시하는 중' : '게시하기'}
            </button>
          </div>
        </Modal>
      )}
      {popup === 'rules' && <RulesModal pack={pack} onClose={() => setPopup(null)} onSave={(th) => setPack((p) => (p ? { ...p, thresholds: th } : p))} />}
      {evidence && (
        <EvidencePanel
          channel={channel}
          q={q}
          sectionKey={evidence}
          usedBy={intents.filter(([, v]) => (v.kb ?? []).includes(evidence)).map(([, v]) => `${v.description} · ${LEVELS.find((l) => l.key === v.level)?.text ?? '섀도'}`)}
          onClose={() => setEvidence(null)}
        />
      )}
    </main>
  );
}

function Rule({ when, then, onEdit }: { when: string; then: string; onEdit?: () => void }) {
  return (
    <div className="m-rule">
      <b>{when}</b>
      <ArrowRight size={13} color="#8490a0" />
      <span>{then}</span>
      <span className="spacer" />
      {onEdit && (
        <button type="button" aria-label="규칙 편집" onClick={onEdit}>
          <Pencil size={14} strokeWidth={1.75} color="#4e5868" />
        </button>
      )}
    </div>
  );
}

/** S-110-P02 넘기는 규칙 편집 */
function RulesModal({ pack, onClose, onSave }: { pack: Pack; onClose: () => void; onSave: (t: Pack['thresholds']) => void }) {
  const [t, setT] = useState(pack.thresholds);
  const num = (key: keyof Pack['thresholds'], step: number, min: number, max: number, text: string) => (
    <label style={{ display: 'block', marginTop: 14 }}>
      <span className="field-label">{text}</span>
      <input type="number" className="input mono" step={step} min={min} max={max} value={t[key]} onChange={(e) => setT({ ...t, [key]: Number(e.target.value) })} />
    </label>
  );
  return (
    <Modal onClose={onClose} width={440}>
      <h2 className="t-modal">사람에게 넘기는 규칙 수정</h2>
      <p className="modal-sub t-13">저장하면 초안에만 반영돼요. ‘게시하기’를 눌러야 실제로 적용돼요.</p>
      {num('confidenceMin', 0.05, 0, 1, '답변 확신도 기준 (이 값 미만이면 사람에게)')}
      {num('repeatLimit', 1, 1, 10, '같은 질문 반복 한도 (회)')}
      {num('maxRounds', 1, 1, 50, '왕복 한도 (회)')}
      {num('maxLength', 50, 100, 5000, '답변 최대 길이 (자)')}
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-md btn-primary"
          onClick={() => {
            onSave(t);
            onClose();
          }}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}

/** S-110-P01 매뉴얼 조항 — 오른쪽 사이드 패널 (딤 없음) */
function EvidencePanel({ channel, q, sectionKey, usedBy, onClose }: { channel: string; q: string; sectionKey: string; usedBy: string[]; onClose: () => void }) {
  const { data } = useLive(() => get<{ raw: string }>(`/api/console/kb/${channel}?lang=ko&${q}`), [channel, sectionKey], []);
  // kb/*.md 는 "## key" 로 조항을 나눈다.
  const text = useMemo(() => {
    if (!data) return null;
    const parts = data.raw.split(/^##\s+/m);
    const hit = parts.find((p) => p.split(/\r?\n/)[0].trim() === sectionKey);
    return hit ? hit.split(/\r?\n/).slice(1).join('\n').trim() : '';
  }, [data, sectionKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="m-sidepanel scroll" role="dialog" aria-label="매뉴얼 조항">
      <div className="row">
        <h2 className="t-modal" style={{ flex: 1 }}>
          매뉴얼 조항
        </h2>
        <button type="button" className="btn btn-sm btn-line" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="m-diffbox" style={{ background: '#fff' }}>
        <span className="tag tag-purple">§ {sectionKey}</span>
        <p className="a-msg-body" style={{ fontSize: 13 }}>
          {text === null ? '불러오는 중…' : text || '이 조항의 본문을 찾지 못했어요.'}
        </p>
      </div>
      <b className="t-13" style={{ display: 'block', margin: '18px 0 8px' }}>
        이 조항을 쓰는 카테고리
      </b>
      {usedBy.map((u) => (
        <p key={u} className="note" style={{ marginTop: 6, color: 'var(--gray-800)' }}>
          {u}
        </p>
      ))}
      {!usedBy.length && <p className="hint t-12">이 조항을 쓰는 카테고리가 없어요</p>}
      <p className="hint t-12" style={{ marginTop: 16, lineHeight: '19px' }}>
        AI는 이 조항을 근거로 답변을 만들고, 답변마다 어느 조항을 참고했는지 함께 보여줘요. 조항 내용은 게시된 매뉴얼(kb/{channel}.md)에서 가져왔어요.
      </p>
    </aside>
  );
}

/** 업로드한 매뉴얼: 현재 지식 + 분석 초안 + 파일 올리기 (S-110 · _drag · _notpdf · _wait · _new · P03) */
function Uploads({ channel, by, kb, drafts, canWrite, onChanged }: { channel: string; by: string; kb: KbView; drafts: Draft[]; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'publish' | 'discard'; draft: Draft }>(null);

  const pick = (f: File | undefined) => {
    setFailure(null);
    if (!f) return;
    if (f.name.split('.').pop()?.toLowerCase() !== 'pdf') {
      setFailure(`PDF 파일만 올릴 수 있어요 · ‘${f.name}’는 추가하지 않았어요`);
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setFailure(`10MB까지 올릴 수 있어요 · ‘${f.name}’는 추가하지 않았어요`);
      return;
    }
    setFile(f);
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await post(`/api/console/kb/${channel}/convert`, { by, lang: 'ko', filename: file.name, contentBase64: btoa(bin), mode: replace ? 'replace' : 'merge' });
      toast('AI 분석을 시작했어요');
      setFile(null);
      setReplace(false);
      onChanged();
    } catch (e) {
      setFailure(consoleError(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    setFailure(null);
    try {
      if (confirm.kind === 'discard') {
        await post(`/api/console/drafts/${confirm.draft.id}/discard`, { by });
        toast('매뉴얼 파일을 삭제했어요');
      } else {
        const detail = await get<{ revision: number }>(`/api/console/drafts/${confirm.draft.id}?by=${encodeURIComponent(by)}`);
        await post(`/api/console/drafts/${confirm.draft.id}/publish`, { by, revision: detail.revision, baseHash: kb.srcHash });
        toast('매뉴얼을 게시했어요');
      }
      setConfirm(null);
      onChanged();
    } catch (e) {
      setFailure(consoleError(e));
    } finally {
      setBusy(false);
    }
  };

  const chars = kb.sections.reduce((n, s) => n + s.chars, 0);
  const done = drafts.some((d) => d.status === 'ready');
  return (
    <section className="card a-panel">
      <header style={{ alignItems: 'center' }}>
        <h2 className="t-h2">업로드한 매뉴얼</h2>
        <span className="spacer" />
        <span className={`chip ${kb.sections.length ? 'chip-human' : 'chip-gray'}`}>{kb.sections.length ? (done ? '분석 완료' : '게시 중') : '업로드한 파일 없음'}</span>
      </header>
      {kb.sections.length ? (
        <div className="m-file">
          <span className="mono hint t-12">KB</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>
              {label(CHANNEL_LABEL, channel)} 매뉴얼 (kb/{channel}.md)
            </b>
            <span className="hint t-12" style={{ display: 'block' }}>
              조항 {kb.sections.length}개 인식 · {chars.toLocaleString()}자 · 버전 {kb.version.slice(0, 6)}
            </span>
          </span>
          <span className="chip chip-human">게시 중</span>
          <button
            type="button"
            className="btn btn-sm btn-line"
            disabled={!canWrite}
            onClick={() => {
              setReplace(true);
              input.current?.click();
            }}
          >
            교체
          </button>
        </div>
      ) : (
        <div className="m-file">
          <span className="hint t-13">업로드한 매뉴얼이 없어요 · 아래 영역에 PDF를 놓거나 파일을 선택하세요</span>
        </div>
      )}
      {drafts.map((d) => (
        <div key={d.id} className="m-file">
          <span className="mono hint t-12">{(d.sourceName?.split('.').pop() ?? 'DOC').toUpperCase()}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{d.sourceName ?? '편집 초안'}</b>
            <span className="hint t-12" style={{ display: 'block' }}>
              {d.status === 'converting' ? 'AI가 매뉴얼을 읽고 있어요' : d.status === 'failed' ? `분석 실패 · ${d.error ?? ''}` : '분석 완료 · 게시하면 답변에 쓰여요'}
            </span>
          </span>
          <span className={`chip ${d.status === 'ready' ? 'chip-human' : d.status === 'failed' ? 'chip-risk' : 'chip-ai'}`}>{d.status === 'ready' ? '분석 완료' : d.status === 'failed' ? '실패' : 'AI 분석 중'}</span>
          {d.status === 'ready' && (
            <button type="button" className="btn btn-sm btn-line" disabled={!canWrite} onClick={() => setConfirm({ kind: 'publish', draft: d })}>
              게시
            </button>
          )}
          <button type="button" className="btn btn-sm btn-line" disabled={!canWrite || d.status === 'converting'} onClick={() => setConfirm({ kind: 'discard', draft: d })}>
            삭제
          </button>
        </div>
      ))}
      {file && (
        <div className="m-file is-pending">
          <span className="mono hint t-12">PDF</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{file.name}</b>
            <span className="hint t-12" style={{ display: 'block' }}>
              {(file.size / 1024 / 1024).toFixed(1)}MB · 분석 대기{replace ? ' · 지금 매뉴얼을 이 파일로 교체해요' : ''}
            </span>
          </span>
          <span className="chip chip-wait">분석 대기</span>
          <button
            type="button"
            className="btn btn-sm btn-line"
            onClick={() => {
              setFile(null);
              setReplace(false);
            }}
          >
            삭제
          </button>
        </div>
      )}

      <div
        className={`m-drop${drag ? ' is-drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          setReplace(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <b>{drag ? '여기에 놓으면 PDF가 추가돼요' : 'PDF 파일을 여기에 끌어다 놓거나 파일을 선택하세요'}</b>
        <p className="hint t-12">{drag ? '놓는 즉시 위 파일 목록에 분석 대기로 추가돼요' : '올린 뒤 ‘AI 분석 시작’을 눌러요 · 한 번에 한 파일, 10MB까지'}</p>
        <input
          ref={input}
          type="file"
          hidden
          accept=".pdf"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn-sm btn-line"
          onClick={() => {
            setReplace(false);
            input.current?.click();
          }}
        >
          파일 선택
        </button>
        {failure && !confirm && <p className="field-error">{failure}</p>}
      </div>
      <div className="row gap-10" style={{ marginTop: 12 }}>
        <button type="button" className={`btn btn-sm btn-primary${busy && !confirm ? ' is-loading' : ''}`} disabled={!file || !canWrite} onClick={() => !busy && start()}>
          {busy && !confirm ? '올리는 중' : 'AI 분석 시작'}
        </button>
        <span className="hint t-12">바꾸려면 파일 행의 ‘교체’, 더하려면 위 영역에 PDF를 놓으세요. 결과는 편집 초안에만 반영돼요.</span>
      </div>

      {confirm && (
        <Modal
          onClose={() => {
            setConfirm(null);
            setFailure(null);
          }}
          width={520}
        >
          <h2 className="t-modal">{confirm.kind === 'publish' ? `‘${confirm.draft.sourceName ?? '분석 결과'}’을 게시할까요?` : `‘${confirm.draft.sourceName ?? '분석 결과'}’을 삭제할까요?`}</h2>
          <p className="modal-sub t-13">
            {confirm.kind === 'publish' ? '게시하면 AI가 이 매뉴얼을 근거로 답해요. 이전 버전은 변경 이력에 남아요.' : '편집 중인 초안의 파일 목록에서 제거돼요. 운영 중인 게시본은 그대로예요.'}
          </p>
          {failure && <p className="field-error">{failure}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-md btn-line" onClick={() => setConfirm(null)} disabled={busy}>
              취소
            </button>
            <button type="button" className={`btn btn-md ${confirm.kind === 'publish' ? 'btn-primary' : 'btn-danger btn-line'}`} onClick={act} disabled={busy}>
              {confirm.kind === 'publish' ? '게시하기' : '삭제'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ───────── S-120 답변 시뮬레이션 ─────────

type SimMode = 'ai' | 'approve' | 'human' | 'ignored' | 'running';
const SIM_MODE: Record<SimMode, { text: string; chip: string; status: string; wait: string }> = {
  ai: { text: 'AI 자동', chip: 'chip-ai', status: '처리 완료 · AI 자동 답변', wait: '' },
  approve: { text: '승인 후 발송', chip: 'chip-wait', status: '담당자 확인 중', wait: '담당자가 확인하고 있어요 · 확인한 뒤 보내드려요' },
  human: { text: '사람 전달', chip: 'chip-risk', status: '상담원 확인 중', wait: '상담원이 확인하고 있어요 · 확인한 뒤 답변드려요' },
  ignored: { text: '응대 불필요', chip: 'chip-gray', status: '처리 완료 · 응대 불필요', wait: '답변이 필요 없는 문의로 분류됐어요' },
  running: { text: '처리 중', chip: 'chip-gray', status: '처리 중', wait: '' },
};

function Simulation({ channel, pack, dirty, version }: { channel: string; pack: Pack; dirty: boolean; version: string }) {
  const { session } = useSession();
  const by = session?.name ?? '';
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CrmDetail | null>(null);
  const [busy, setBusy] = useState<null | 'submit' | 'approve' | 'reply'>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [agentReply, setAgentReply] = useState('');
  const [adding, setAdding] = useState(false);
  const stamp = useRef(0);

  const reset = () => {
    setSent([]);
    setCaseId(null);
    setDetail(null);
    setFailure(null);
    setText('');
    setAdding(false);
  };

  // 에이전트가 끝낼 때까지 1초마다 최대 20번 확인한다.
  const follow = async (id: string) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => window.setTimeout(res, 1000));
      const d = await api.crmCase(id);
      setDetail(d);
      if (d.case.status !== 'New' && !(d.case.status === 'Working' && !d.case.subStatus)) break;
    }
  };

  const submit = async () => {
    const body = text.trim();
    if (body.length < 2) return;
    setBusy('submit');
    setFailure(null);
    try {
      if (!stamp.current) stamp.current = Date.now();
      const r = await post<{ caseId: string }>('/api/test/inbound', {
        channel,
        from: `sim+${stamp.current}@baton.test`,
        name: '시뮬레이션',
        subject: (sent[0] ?? body).slice(0, 40),
        body,
      });
      setSent((p) => [...p, body]);
      setText('');
      setAdding(false);
      setCaseId(r.caseId);
      await follow(r.caseId);
    } catch (e) {
      setFailure(e instanceof ApiError && e.status === 404 ? '이 서버에서는 테스트 접수가 꺼져 있어요 (운영 모드).' : errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'approve' | 'reply') => {
    if (!detail || !caseId) return;
    setBusy(kind);
    setFailure(null);
    try {
      if (kind === 'approve' && detail.pendingDraft) await api.approve(detail.pendingDraft.id, by);
      if (kind === 'reply') await api.humanReply(caseId, by, agentReply.trim());
      setAgentReply('');
      setDetail(await api.crmCase(caseId));
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const c = detail?.case;
  const answers = (detail?.timeline ?? []).flatMap((t) => (t.kind === 'activity' && t.activity.type === 'email' && t.activity.direction === 'outbound' && t.activity.subtype !== 'ack' ? [t.activity] : []));
  const intent = c?.intent ? pack.intents[c.intent] : undefined;
  const mode: SimMode | null = !c
    ? null
    : c.subStatus === 'Awaiting Approval'
      ? 'approve'
      : c.status === 'Escalated' || c.status === 'On Hold'
        ? 'human'
        : c.resolution.outcome === 'auto_answered' || c.subStatus === 'Waiting on Customer'
          ? 'ai'
          : c.status === 'Closed'
            ? 'ignored'
            : 'running';
  const keys = [...new Set((detail?.agentLog ?? []).flatMap((l) => (l.output.trace ?? []).flatMap((t) => t.calls.flatMap((call) => (Array.isArray(call.input.keys) ? (call.input.keys as string[]) : [])))))];
  const no = c ? c.caseNumber.slice(-4) : '';
  const m = mode ? SIM_MODE[mode] : null;

  return (
    <aside className="card a-panel" style={{ position: 'sticky', top: 76 }}>
      <header style={{ alignItems: 'center' }}>
        <h2 className="t-h2">고객 화면 미리보기 · 답변 시뮬레이션</h2>
        <span className="spacer" />
        <button type="button" className="t-12 strong brand" onClick={reset}>
          다시 테스트
        </button>
      </header>
      <div className="segment" role="group" aria-label="시뮬레이션 기준" style={{ height: 36, padding: 3 }}>
        <button type="button" style={{ height: 28, fontSize: 12 }} aria-pressed="false" disabled title="기능 구현 필요: 수정 중인 초안으로 시뮬레이션">
          수정 중인 초안
        </button>
        <button type="button" style={{ height: 28, fontSize: 12 }} aria-pressed="true">
          현재 게시본 {version.slice(0, 6)}
        </button>
      </div>
      <div className="todo-block" style={{ alignItems: 'flex-start', marginTop: 10 }}>
        <span>
          <b>실제 테스트 접수예요.</b> 서버의 테스트 접수(/api/test/inbound)를 쓰기 때문에 문의함과 통계에 들어가요. 가짜 주소(@baton.test)로 접수하고 게시본 규칙으로 처리돼요.
          {dirty ? ' 왼쪽에서 고친 초안은 게시 전이라 반영되지 않아요.' : ''} <Todo what="문의함 · 통계에 남지 않는 시연 모드, 수정 중인 초안으로 시뮬레이션" />
        </span>
      </div>

      <div className="row gap-8" style={{ margin: '14px 0 8px' }}>
        <span className="chip chip-human">고객이 보는 화면</span>
        <span className="spacer" />
        <span className="chip chip-ai">게시본 {version.slice(0, 6)}</span>
      </div>
      <div className="m-sim">
        <b style={{ fontSize: 15 }}>{COMPANY} 고객센터</b>
        {!sent.length ? (
          <>
            <p className="tertiary t-13" style={{ margin: '8px 0 10px' }}>
              무엇을 도와드릴까요?
            </p>
            <span className="field-label">
              문의 내용 <span className="risk">*</span>
            </span>
            <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="고객 문의를 적어 보세요" disabled={busy !== null} />
            <p className="hint t-12" style={{ margin: '8px 0 10px' }}>
              접수하면 AI가 먼저 답하거나, 담당자가 확인한 뒤 보내드려요
            </p>
            <button type="button" className={`btn btn-md btn-primary btn-block${busy === 'submit' ? ' is-loading' : ''}`} disabled={text.trim().length < 2} onClick={() => !busy && submit()}>
              {busy === 'submit' ? '접수하는 중' : '테스트 접수'}
            </button>
          </>
        ) : (
          <>
            <p className="row gap-8 t-12 strong" style={{ margin: '10px 0' }}>
              <i className={`dot ${mode === 'ai' || mode === 'ignored' ? 'dot-ok' : 'dot-wait'}`} />
              {c ? `접수 완료 · ${no}` : '접수 중'}
              <span className="spacer" />
              <span className="hint" style={{ fontWeight: 400 }}>
                {m?.status ?? '처리 중'}
              </span>
            </p>
            {sent.map((t, i) => (
              <div key={i}>
                <p className="m-bubble is-me">{t}</p>
                {i === 0 && c && <p className="m-bubble is-sys">문의가 접수됐어요 · 접수번호 {no}</p>}
                {i > 0 && <p className="m-bubble is-sys">추가 내용이 같은 문의에 전달됐어요</p>}
              </div>
            ))}
            {answers.map((a) => (
              <p key={a.id} className="m-bubble">
                {a.body ?? a.summary}
              </p>
            ))}
            {m?.wait && <p className="m-bubble is-sys">{m.wait}</p>}
            {adding ? (
              <div style={{ marginTop: 10 }}>
                <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="이어서 보낼 내용" autoFocus />
                <div className="row gap-8" style={{ marginTop: 8 }}>
                  <button type="button" className={`btn btn-sm btn-primary${busy === 'submit' ? ' is-loading' : ''}`} disabled={text.trim().length < 2} onClick={() => !busy && submit()}>
                    {busy === 'submit' ? '보내는 중' : '보내기'}
                  </button>
                  <button type="button" className="btn btn-sm btn-line" onClick={() => setAdding(false)}>
                    취소
                  </button>
                </div>
              </div>
            ) : (
              c &&
              mode !== 'running' && (
                <div className="row gap-8" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-sm btn-line" onClick={() => setAdding(true)}>
                    {answers.length ? '답장' : '내용 추가'}
                  </button>
                </div>
              )
            )}
          </>
        )}
        {failure && <p className="field-error">{failure}</p>}
      </div>

      <div className="row gap-8" style={{ margin: '16px 0 8px', paddingTop: 14, borderTop: '1px solid var(--border-default)' }}>
        <span className="tag tag-dark">관리자용 처리 근거</span>
        <span className="hint t-12">고객에게는 보이지 않아요</span>
        <span className="spacer" />
        {m && mode !== 'running' && <span className={`chip ${m.chip}`}>{m.text}</span>}
      </div>
      <div className="note" style={{ color: 'var(--gray-700)' }}>
        {!c || !m ? (
          '고객 화면에 문의 내용을 적고 ‘테스트 접수’를 누르면, 바톤이 어떻게 분류하고 처리하는지 여기에서 보여줘요.'
        ) : (
          <>
            <dl className="a-kv" style={{ gridTemplateColumns: '86px minmax(0,1fr)' }}>
              <dt>적용된 매뉴얼</dt>
              <dd>게시본 {version.slice(0, 6)}</dd>
              <dt>분류</dt>
              <dd>
                {intent?.description ?? c.intent ?? '—'} · {label(REASON_LABEL, c.caseReason)}
              </dd>
              <dt>처리 수준</dt>
              <dd>{m.text}</dd>
              <dt>적용 규칙</dt>
              <dd>{c.resolution.handoffReason ? `넘기는 규칙 · ${label(HANDOFF_LABEL, c.resolution.handoffReason)}` : '기본 규칙 · 카테고리 처리 수준'}</dd>
              <dt>근거 조항</dt>
              <dd>{keys.length ? keys.map((k) => `§ ${k}`).join(' · ') : '—'}</dd>
            </dl>

            {mode === 'ai' && answers.length > 0 && (
              <>
                <b className="t-13" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--gray-900)' }}>
                  AI가 자동으로 보낸 답변
                </b>
                <p className="m-bubble" style={{ maxWidth: '100%', marginTop: 0 }}>
                  {answers.at(-1)?.body}
                </p>
              </>
            )}

            {mode === 'approve' && detail?.pendingDraft && (
              <>
                <b className="t-13" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--gray-900)' }}>
                  AI 초안 · 담당자 확인 중
                </b>
                <p className="m-bubble" style={{ maxWidth: '100%', marginTop: 0 }}>
                  {detail.pendingDraft.body}
                </p>
                <button type="button" className={`btn btn-md btn-primary btn-block${busy === 'approve' ? ' is-loading' : ''}`} style={{ marginTop: 10 }} onClick={() => !busy && act('approve')}>
                  {busy === 'approve' ? '보내는 중' : '테스트 승인·발송'}
                </button>
              </>
            )}

            {mode === 'human' && (
              <>
                <b className="t-13" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--gray-900)' }}>
                  테스트 상담원 답변
                </b>
                <textarea className="textarea" rows={3} value={agentReply} onChange={(e) => setAgentReply(e.target.value)} placeholder="상담원이 보낼 답변을 적어 보세요" />
                <button type="button" className={`btn btn-md btn-primary btn-block${busy === 'reply' ? ' is-loading' : ''}`} style={{ marginTop: 10 }} disabled={!agentReply.trim()} onClick={() => !busy && act('reply')}>
                  {busy === 'reply' ? '보내는 중' : '테스트 상담원 답변 보내기'}
                </button>
                <p className="hint t-12" style={{ marginTop: 8 }}>
                  자동 배정 <Todo what="상담원 자동 배정" />
                </p>
              </>
            )}
            {answers.length > 0 && mode !== 'ai' && (
              <p className="t-12 strong" style={{ marginTop: 10, color: 'var(--gray-900)' }}>
                ✓ 답변이 고객에게 전달됐어요
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
