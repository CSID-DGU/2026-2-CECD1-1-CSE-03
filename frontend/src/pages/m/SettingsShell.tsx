import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import './m.css';

/** 설정 화면 공통 머리: 제목 · 오른쪽 위 버튼 · 하위 탭 '매뉴얼 · 팀·권한 · 운영 시간' (Interaction Rules › 설정 탭) */
export function SettingsHead({ tab, title, sub, action }: { tab: 'manual' | 'team' | 'hours'; title: string; sub: string; action?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="t-h1">{title}</h1>
          <p className="hint t-13" style={{ marginTop: 6 }}>
            {sub}
          </p>
        </div>
        <span className="spacer" />
        <div className="row gap-10">{action}</div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <div className="segment" role="group" aria-label="설정 탭">
          <button type="button" aria-pressed={tab === 'manual'} onClick={() => navigate('/S-110')}>
            매뉴얼
          </button>
          <button type="button" aria-pressed={tab === 'team'} onClick={() => navigate('/S-200')}>
            팀 · 권한
          </button>
          <button type="button" aria-pressed={tab === 'hours'} onClick={() => navigate('/S-300')}>
            운영 시간
          </button>
        </div>
      </div>
    </>
  );
}
