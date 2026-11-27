import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CaseDoc, type RawCase } from './api';

type Loadable<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

/** 값을 불러오고, 서버 이벤트(/api/events)가 오면 다시 불러온다. */
export function useLive<T>(loader: () => Promise<T>, deps: unknown[], events: string[] = LIVE_EVENTS): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    loaderRef
      .current()
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (mine === seq.current) setError(e);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!events.length) return;
    const es = new EventSource('/api/events');
    let timer: number | undefined;
    const onEvent = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 250);
    };
    events.forEach((name) => es.addEventListener(name, onEvent));
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  return { data, error, loading, reload };
}

const LIVE_EVENTS = ['case.updated', 'case.reopened', 'message.created', 'draft.created', 'draft.updated', 'handoff.created'];

/** CRM 문서 + 원본 케이스 줄을 id로 합친 한 건. */
export type InboxCase = CaseDoc & { raw: RawCase | null };

export async function loadCases(): Promise<InboxCase[]> {
  const [crm, raw] = await Promise.all([api.crmCases(), api.rawCases()]);
  const byId = new Map(raw.map((r) => [r.id, r]));
  return crm.items.map((c) => ({ ...c, raw: byId.get(c.id) ?? null }));
}

/** 1분마다 다시 그려 대기 시간을 갱신한다. */
export function useNow(intervalMs = 60000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * 목록 → 상세 → 뒤로 가기 때 스크롤 위치를 그대로 둔다 (A-200 · M-111 스펙 ①).
 * 떠날 때 위치를 탭 안에 적어 두고, 데이터가 준비되면 한 번 되돌린다.
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    try {
      const y = Number(sessionStorage.getItem(`baton.scroll:${key}`) ?? 0);
      if (y > 0) window.scrollTo(0, y);
    } catch {
      /* 저장소를 못 쓰면 맨 위에서 시작한다 */
    }
  }, [key, ready]);
  useEffect(
    () => () => {
      try {
        sessionStorage.setItem(`baton.scroll:${key}`, String(window.scrollY));
      } catch {
        /* noop */
      }
    },
    [key],
  );
}
