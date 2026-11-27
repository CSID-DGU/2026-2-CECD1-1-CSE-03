import { useNavigate } from 'react-router-dom';
import { loadCases, useLive } from '../../lib/hooks';
import { Todo } from '../../components/ui';
import { stageOf } from './model';
import './m.css';

/** M-200 관리자 이관 · 검토 대기 / M-201 관리자 이관 · 오늘 조치한 건 */
export function Escalations({ tab }: { tab: 'waiting' | 'done' }) {
  const navigate = useNavigate();
  const { data } = useLive(loadCases, []);
  // 이관 데이터가 없어 화면 구성만 확인할 수 있도록, 사람 응대 단계의 아무 문의 하나를 미리 보기로 연다.
  const sample = (data ?? []).find((c) => stageOf(c) === 'human');

  return (
    <main className="page">
      <div className="row">
        <div>
          <h1 className="t-h1">관리자 이관</h1>
          <p className="hint t-13" style={{ marginTop: 6 }}>
            상담원이 사유를 남기고 넘긴 문의예요 · 직접 맡거나 다른 상담원에게 재배정하세요
          </p>
        </div>
        <span className="spacer" />
        <div className="segment" role="group" aria-label="이관 탭">
          <button type="button" aria-pressed={tab === 'waiting'} onClick={() => navigate('/M-200')}>
            검토 대기
          </button>
          <button type="button" aria-pressed={tab === 'done'} onClick={() => navigate('/M-201')}>
            오늘 조치한 건
          </button>
        </div>
      </div>

      <div className="table-wrap table-card" style={{ marginTop: 18 }}>
        <table className="table">
          <thead>
            <tr>
              <th>번호</th>
              <th>제목 · 고객</th>
              <th>검토 사유</th>
              <th>이관한 상담원</th>
              <th>이관 사유 · 메모</th>
              <th>{tab === 'waiting' ? '대기 시간' : '조치 · 문의 상태'}</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody />
        </table>
        <div className="empty">{tab === 'waiting' ? '검토를 기다리는 이관 문의가 없어요' : '오늘 조치한 이관 문의가 없어요'}</div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Todo block what="상담원 → 관리자 이관 (이관 사유 · 메모 · 검토 대기 목록 · 조치 기록이 백엔드에 없음) — 그래서 목록이 항상 비어 있어요" />
      </div>
      {sample && (
        <p className="hint t-12" style={{ marginTop: 12 }}>
          화면 구성 미리 보기 (실제 이관 건 아님):{' '}
          <button type="button" className="brand strong" onClick={() => navigate(`/M-202/${sample.id}`)}>
            M-202 이관 상세
          </button>{' '}
          ·{' '}
          <button type="button" className="brand strong" onClick={() => navigate(`/M-300/${sample.id}`)}>
            M-300 직접 처리
          </button>
        </p>
      )}
    </main>
  );
}
