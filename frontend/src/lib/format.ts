// 시간 표기 — Figma A-100_time_spec "마지막 응답 · 대기 시간 표기" 규칙.

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n: number) => String(n).padStart(2, '0');

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function hm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 오늘 → 시:분 · 어제 → 어제 시:분 · 2~6일 전 → 요일 시:분 · 그 전 → 날짜만 */
export function relTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return hm(iso);
  if (days === 1) return `어제 ${hm(iso)}`;
  if (days <= 6) return `${DAYS[d.getDay()]} ${hm(iso)}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 마우스를 올렸을 때 보여줄 전체 시각 — 2026년 11월 13일 (금) 17:50 */
export function fullTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) ${hm(iso)}`;
}

export function monthDayTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm(iso)}`;
}

export function receivedAt(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return `오늘 ${hm(iso)} 접수`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm(iso)} 접수`;
}

/**
 * 대기 시간(분). Figma는 운영 시간(S-300) 안에서만 세라고 하지만
 * 백엔드에 운영 시간 설정이 없어 단순 경과 시간으로 센다. (기능 구현 필요: 운영 시간 기준 계산)
 */
export function waitMinutes(sinceIso: string | null | undefined, now = new Date()): number {
  if (!sinceIso) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(sinceIso).getTime()) / 60000));
}

/** 1시간 미만 'N분' · 1시간 이상 'N시간 MM분' */
export function waitText(min: number): string {
  if (min < 60) return `${pad(min)}분`;
  return `${Math.floor(min / 60)}시간 ${pad(min % 60)}분`;
}

/** "N분 전 · N시간 전 · N일 전" — 고객 회신 대기 탭 */
export function agoText(iso: string | null | undefined, now = new Date()): string {
  const min = waitMinutes(iso, now);
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 1440)}일 전`;
}

export function isToday(iso: string | null | undefined, now = new Date()): boolean {
  if (!iso) return false;
  return startOfDay(new Date(iso)) === startOfDay(now);
}

/** 번호 칸 — 8자리 caseNumber의 뒤 4자리 (Figma 표기 0142) */
export function shortNo(caseNumber: string): string {
  return caseNumber.slice(-4);
}
