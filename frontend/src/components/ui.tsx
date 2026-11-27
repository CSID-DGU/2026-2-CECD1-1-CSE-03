import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Wrench } from 'lucide-react';

/** 백엔드 · 에이전트에 없는 기능 자리에 붙이는 표시. */
export function Todo({ what, block }: { what?: string; block?: boolean }) {
  const title = what ? `기능 구현 필요: ${what}` : '기능 구현 필요';
  if (block) {
    return (
      <div className="todo-block" role="note">
        <Wrench size={14} strokeWidth={1.75} />
        <span>
          <b>기능 구현 필요</b>
          {what ? ` · ${what}` : ''}
        </span>
      </div>
    );
  }
  return (
    <span className="todo" title={title}>
      <Wrench size={11} strokeWidth={1.75} />
      기능 구현 필요
    </span>
  );
}

/** 감정 0~5 — 4 이상은 빨강 (Figma A-100). */
export function Sentiment({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="hint">—</span>;
  const high = value >= 4;
  return (
    <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
      <i className={`dot${high ? ' dot-risk' : ''}`} />
      <b className={high ? 'risk' : 'tertiary'} style={{ fontSize: 13 }}>
        {value}
      </b>
    </span>
  );
}

export function Modal({ children, onClose, width = 520 }: { children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal scroll" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} style={{ width, outline: 'none' }}>
        {children}
      </div>
    </div>
  );
}

export function RadioCard({
  checked,
  onSelect,
  title,
  desc,
  extra,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  desc?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="radio-card" onClick={onSelect}>
      <i className="radio" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="row gap-8">
          <b style={{ fontSize: 14 }}>{title}</b>
          {extra}
        </span>
        {desc && (
          <span className="hint" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
            {desc}
          </span>
        )}
        {children}
      </span>
    </button>
  );
}

// ───────── 토스트: 하단 가운데 3초 ─────────

const ToastContext = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: 'var(--status-ok)' }}>
            <Check size={12} strokeWidth={3} color="#fff" />
          </span>
          {msg}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
