import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { loadCases, useLive } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { Modal, Todo } from '../../components/ui';
import { EMAIL_RE } from '../x/Login';
import { SettingsHead } from './SettingsShell';
import { assigneeOf } from './model';
import './m.css';

type Person = { name: string; email: string; role: string; access: string; me: boolean };

/** S-200 팀 · 권한 · 목록 / S-210 전체 관리자 목록 (+ S-200-P01 상담원 초대 · P02 역할 변경 · P03 조직도 · S-210-P01) */
export function Team({ scope }: { scope: 'team' | 'all' }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const [popup, setPopup] = useState<null | 'invite' | 'role' | 'org'>(null);
  const [target, setTarget] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const { data } = useLive(loadCases, [], []);

  // 백엔드에 구성원 목록이 없다. 지금 로그인한 사람과, 문의를 맡은 적 있는 이름만 보여준다.
  const people = useMemo<Person[]>(() => {
    const names = [...new Set((data ?? []).map(assigneeOf).filter((n): n is string => Boolean(n)))].filter((n) => n !== session?.name);
    return [
      { name: session?.name ?? '', email: session?.email ?? '', role: '관리자', access: '전체 접근', me: true },
      ...(scope === 'team' ? names.map((n) => ({ name: n, email: '', role: '상담원', access: '문의 조회·응대', me: false })) : []),
    ];
  }, [data, session, scope]);

  return (
    <main className="page">
      <SettingsHead
        tab="team"
        title="팀 · 권한"
        sub="상담원의 가입·근무 상태와 역할, 화면·기능 접근 범위를 관리해요 · 재배정은 상담원 전체에서 관리자가 직접 골라요"
        action={
          <button type="button" className="btn btn-md btn-primary" onClick={() => setPopup('invite')}>
            상담원 초대
          </button>
        }
      />

      <div className="row gap-10" style={{ marginTop: 6 }}>
        <div className="segment" role="group" aria-label="보기 범위" style={{ height: 34, padding: 3 }}>
          <button type="button" style={{ height: 26, fontSize: 12 }} aria-pressed={scope === 'team'} onClick={() => navigate('/S-200')}>
            관리자
          </button>
          <button type="button" style={{ height: 26, fontSize: 12 }} aria-pressed={scope === 'all'} onClick={() => navigate('/S-210')}>
            총관리자
          </button>
        </div>
        <button type="button" className="btn btn-sm btn-line" onClick={() => setPopup('org')}>
          조직도 보기
        </button>
        <span className="spacer" />
        {scope === 'team' && (
          <span className="m-filter">
            <span className="hint">팀 선택</span>
            <b style={{ paddingRight: 8 }}>
              <Todo what="팀 목록" />
            </b>
          </span>
        )}
      </div>

      <div className="table-wrap table-card" style={{ marginTop: 14 }}>
        <table className="table m-team">
          <thead>
            <tr>
              <th>이름</th>
              <th>가입 상태</th>
              <th>근무 상태</th>
              <th>역할</th>
              <th>소속 팀</th>
              <th>접근 범위</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.name} className={picked === p.name ? 'is-picked' : p.me ? 'is-me' : ''} onClick={() => setPicked((cur) => (cur === p.name ? null : p.name))}>
                <td>
                  <span className="row gap-10" style={{ justifyContent: 'center' }}>
                    <span className="avatar">{p.name.slice(0, 1)}</span>
                    <span style={{ textAlign: 'left' }}>
                      <b style={{ display: 'block', color: 'var(--gray-900)' }}>{p.name}</b>
                      <span className="hint t-12">{p.email || '—'}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <span className="hint">—</span>
                </td>
                <td>
                  <span className="hint">—</span>
                </td>
                <td>{p.role}</td>
                <td>
                  <span className="hint">—</span>
                </td>
                <td>{p.access}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-line"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTarget(p.name);
                      setPopup('role');
                    }}
                  >
                    역할·권한 편집
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12 }}>
        <Todo block what="구성원 · 총관리자 · 팀 · 역할 · 접근 범위 · 가입/근무 상태 · 초대 대기 · ‘팀 보기’ (계정과 팀이 백엔드에 없음) — 지금은 로그인한 사람과 문의를 맡은 적 있는 이름만 보여요" />
      </div>

      {popup === 'invite' && <InviteModal onClose={() => setPopup(null)} />}
      {popup === 'role' && <RoleModal name={target} onClose={() => setPopup(null)} />}
      {popup === 'org' && (
        <Modal onClose={() => setPopup(null)} width={880}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <h2 className="t-modal">{scope === 'all' ? '전체 조직도' : '소속 팀 조직도'}</h2>
              <p className="modal-sub t-13">
                {scope === 'all' ? '총관리자 아래 전체 관리자, 각 관리자 아래 소속 상담원이에요' : '총관리자 아래 우리 팀 관리자와 소속 상담원이에요'} · 구성원 {people.length}명
              </p>
            </div>
            <button type="button" className="btn btn-sm btn-line" style={{ width: 32, padding: 0 }} aria-label="닫기" onClick={() => setPopup(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="m-org">
            {people.map((p, i) => (
              <div key={p.name} className="m-org-card" style={{ marginLeft: i === 0 ? 0 : 28 }}>
                <span className="avatar">{p.name.slice(0, 1)}</span>
                <span>
                  <b>{p.name}</b>
                  <span className="hint t-12" style={{ display: 'block' }}>
                    {p.role}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <Todo block what="조직도 (총관리자 › 관리자 › 상담원 소속 정보가 백엔드에 없음)" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-md btn-primary" onClick={() => setPopup(null)}>
              닫기
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** S-200-P01 상담원 초대 (+ _invalid) */
function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const ok = EMAIL_RE.test(email.trim());
  return (
    <Modal onClose={onClose} width={520}>
      <h2 className="t-modal">상담원을 초대할까요?</h2>
      <p className="modal-sub t-13">초대 메일을 보내요. 가입하면 문의가 자동 배정돼요.</p>
      <label className="field-label" htmlFor="inv-email" style={{ marginTop: 18 }}>
        이메일
      </label>
      <input id="inv-email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} placeholder="name@company.com" autoFocus />
      <label className="field-label" htmlFor="inv-role" style={{ marginTop: 14 }}>
        역할
      </label>
      <select id="inv-role" className="input" defaultValue="agent">
        <option value="agent">상담원</option>
        <option value="admin">관리자</option>
      </select>
      {touched && email && !ok && (
        <p className="m-warnbox" style={{ marginTop: 14 }}>
          이메일 형식을 확인해 주세요. 예: name@company.com
        </p>
      )}
      <div style={{ marginTop: 14 }}>
        <Todo block what="초대 메일 발송 · ‘이미 팀에 있는 이메일’ / ‘초대 대기 중’ 확인 · 재전송 · 초대 취소" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-primary" disabled data-tip="초대 기능이 아직 없어요">
          초대 메일 보내기
        </button>
      </div>
    </Modal>
  );
}

const PERMS = [
  { key: 'cases', title: '문의 조회·응대', desc: '팀 문의함, 문의 상세, 상담원 응대' },
  { key: 'escalate', title: '관리자 이관·재배정', desc: '관리자 이관, 직접 처리, 재배정·담당자 변경' },
  { key: 'report', title: '리포트', desc: '운영 리포트, 고객 목소리' },
  { key: 'manual', title: '매뉴얼·접수 페이지', desc: '매뉴얼 설정, 접수 페이지 테스트·게시' },
  { key: 'team', title: '팀 관리', desc: '팀·권한, 상담원 초대' },
];

/** S-200-P02 역할·권한 편집 */
function RoleModal({ name, onClose }: { name: string; onClose: () => void }) {
  const initial = ['cases'];
  const [on, setOn] = useState<string[]>(initial);
  const changed = PERMS.filter((p) => on.includes(p.key) !== initial.includes(p.key));
  const toggle = (k: string) => setOn((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  return (
    <Modal onClose={onClose} width={600}>
      <h2 className="t-modal">{name} · 역할·권한 편집</h2>
      <p className="modal-sub t-13">이 설정은 화면과 기능 접근 범위에만 적용돼요. 재배정 모달의 상담원 선택에는 쓰이지 않아요.</p>
      <label className="field-label" htmlFor="role-sel" style={{ marginTop: 18 }}>
        역할
      </label>
      <select id="role-sel" className="input" defaultValue="agent">
        <option value="agent">상담원</option>
        <option value="admin">관리자</option>
      </select>
      <span className="field-label" style={{ marginTop: 16 }}>
        접근 권한
      </span>
      {PERMS.map((p) => (
        <label key={p.key} className={`m-perm${on.includes(p.key) ? ' is-on' : ''}`}>
          <input type="checkbox" checked={on.includes(p.key)} onChange={() => toggle(p.key)} />
          <span>
            <b>{p.title}</b>
            <span className="hint t-12" style={{ display: 'block' }}>
              {p.desc}
            </span>
          </span>
        </label>
      ))}
      {changed.length > 0 && (
        <div className="m-diffbox">
          <b>저장 전 변경 내용</b>
          {changed.map((p) => (
            <div key={p.key}>
              · {p.title}: {on.includes(p.key) ? '없음 → 있음' : '있음 → 없음'}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <Todo block what="역할 · 접근 범위 저장 (계정 · 권한이 백엔드에 없음)" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-md btn-line" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn btn-md btn-primary" disabled data-tip="저장 기능이 아직 없어요">
          {changed.length ? `변경 ${changed.length}건 저장` : '저장'}
        </button>
      </div>
    </Modal>
  );
}

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];
type Day = { open: boolean; from: string; to: string; lunchFrom: string; lunchTo: string };
const DEFAULT_DAY = (open: boolean): Day => ({ open, from: '09:00', to: '18:00', lunchFrom: '12:00', lunchTo: '13:00' });
const DEFAULT_WEEK: Record<string, Day> = Object.fromEntries(WEEK.map((d, i) => [d, DEFAULT_DAY(i < 5)]));

/** 지금 운영 중인지 — 화면에 적힌 시간으로만 계산한다 (저장된 설정이 아니다). */
function nowStatus(week: Record<string, Day>): { open: boolean; text: string } {
  const now = new Date();
  const key = WEEK[(now.getDay() + 6) % 7];
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = week[key];
  const open = today.open && hhmm >= today.from && hhmm < today.to;
  // 다음 운영 시작
  let next = '';
  for (let i = open ? 1 : 0; i < 8; i++) {
    const d = week[WEEK[(now.getDay() + 6 + i) % 7]];
    if (!d.open) continue;
    if (i === 0 && hhmm >= d.from) continue;
    next = `${i === 0 ? '오늘' : i === 1 ? '내일' : `${WEEK[(now.getDay() + 6 + i) % 7]}요일`} ${d.from}`;
    break;
  }
  return { open, text: open ? `오늘 ${today.to}에 끝나요${next ? ` · 다음 운영 ${next}` : ''}` : next ? `다음 운영 ${next}` : '운영하는 요일이 없어요' };
}

/** S-300 설정 · 운영 시간 */
export function Hours() {
  const [week, setWeek] = useState(DEFAULT_WEEK);
  const [holiday, setHoliday] = useState(true);
  const dirty = JSON.stringify(week) !== JSON.stringify(DEFAULT_WEEK) || !holiday;
  const set = (d: string, patch: Partial<Day>) => setWeek((w) => ({ ...w, [d]: { ...w[d], ...patch } }));
  const status = nowStatus(week);
  const time = (d: string, k: 'from' | 'to' | 'lunchFrom' | 'lunchTo') => (
    <input className="input mono" inputMode="numeric" maxLength={5} placeholder="00:00" value={week[d][k]} onChange={(e) => set(d, { [k]: e.target.value.replace(/[^0-9:]/g, '') })} />
  );

  return (
    <main className="page">
      <SettingsHead
        tab="hours"
        title="운영 시간"
        sub="고객 화면의 운영 시간 안내와 상담원 대기 시간 계산에 함께 쓰여요"
        action={
          <button type="button" className="btn btn-md btn-primary" disabled data-tip={dirty ? '운영 시간 저장 기능이 아직 없어요' : '바뀐 값이 없어요'}>
            변경 저장
          </button>
        }
      />
      <div className="m-two" style={{ gridTemplateColumns: '4fr 3fr' }}>
        <div>
          <section className="card a-panel">
            <header>
              <h2 className="t-h2">상담 운영 시간</h2>
              <span className="hint t-12">요일마다 운영 여부와 시간을 정해요</span>
            </header>
            {WEEK.map((d) => (
              <div key={d} className="m-hour">
                <b>{d}</b>
                <button type="button" className={`chip ${week[d].open ? 'chip-ai' : 'chip-gray'}`} style={{ borderRadius: 11 }} onClick={() => set(d, { open: !week[d].open })}>
                  <i className="dot" style={week[d].open ? { background: 'var(--primary-500)' } : undefined} />
                  {week[d].open ? '운영' : '휴무'}
                </button>
                {week[d].open ? (
                  <>
                    {time(d, 'from')}
                    <span className="hint">~</span>
                    {time(d, 'to')}
                    <span className="hint t-12" style={{ marginLeft: 18 }}>
                      점심
                    </span>
                    {time(d, 'lunchFrom')}
                    <span className="hint">~</span>
                    {time(d, 'lunchTo')}
                  </>
                ) : (
                  <span className="hint t-12">이날 들어온 문의는 다음 운영일 09:00부터 대기 시간을 세요</span>
                )}
              </div>
            ))}
          </section>

          <section className="card a-panel">
            <header>
              <h2 className="t-h2">공휴일 · 임시 휴무</h2>
              <span className="hint t-12">휴무일은 대기 시간에서 빠져요</span>
            </header>
            <div className="m-hour" style={{ gridTemplateColumns: '1fr auto' }}>
              <span>법정 공휴일은 자동으로 휴무</span>
              <button type="button" role="switch" aria-checked={holiday} className="m-switch" onClick={() => setHoliday((v) => !v)}>
                <i />
              </button>
            </div>
            <div className="row gap-10" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-sm btn-line" disabled data-tip="임시 휴무일 저장 기능이 아직 없어요">
                + 휴무일 추가
              </button>
              <Todo what="임시 휴무일 추가 · 삭제" />
            </div>
          </section>
        </div>

        <div>
          <div className={`card m-now${status.open ? '' : ' is-off'}`}>
            <i className={`dot ${status.open ? 'dot-ok' : ''}`} />
            <b>{status.open ? '지금 운영 중' : '운영 시간 아님'}</b>
            <span className="tertiary t-13">{status.text}</span>
          </div>
          <section className="card a-panel" style={{ marginTop: 14 }}>
            <header>
              <h2 className="t-h2">이 값을 쓰는 곳</h2>
              <span className="hint t-12">저장하면 바로 반영돼요</span>
            </header>
            <dl className="m-uses">
              <dt>고객 문의 창구</dt>
              <dd>
                상단 운영 시간 안내
                <br />
                운영 시간 밖이면 ‘문의 접수는 24시간’ 문구
              </dd>
              <dd className="mono brand">C-100</dd>
              <dt>상담원 문의함</dt>
              <dd>
                대기 시간은 운영 시간 안에서만 세요
                <br />
                운영 시간 밖 접수는 ‘업무 외 접수’ 표시
              </dd>
              <dd className="mono brand">A-100</dd>
              <dt>관리자 운영 현황</dt>
              <dd>팀 문의함 · 칸반의 대기 시간도 같은 기준</dd>
              <dd className="mono brand">M-100 · M-110</dd>
            </dl>
          </section>
          <div style={{ marginTop: 14 }}>
            <Todo block what="운영 시간 · 점심 · 휴무일 저장과 대기 시간 계산 반영 (운영 시간 설정이 백엔드에 없음) — 위 ‘지금 운영 중’은 화면에 적힌 값으로만 계산해요" />
          </div>
        </div>
      </div>
    </main>
  );
}
