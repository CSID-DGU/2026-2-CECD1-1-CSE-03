import type { InboxCase } from '../../lib/hooks';
import { isToday } from '../../lib/format';

// 관리자 콘솔의 다섯 단계 (Figma M-100 단계별 칸반) ↔ 백엔드 상태
//   신규 접수      = New
//   AI 응대 중     = Working (하위 상태 없음 — 접수 · 답장 Agent가 처리 중)
//   사람 응대      = Escalated · On Hold · Awaiting Approval
//   고객 회신 대기 = Waiting on Customer
//   종결           = Closed
// Figma의 '관리자 검토 대기(상담원 → 관리자 이관)'는 백엔드에 없어 사람 응대 안에서 구분하지 못한다.

export type Stage = 'new' | 'ai' | 'human' | 'wait' | 'closed';

export const STAGES: { key: Stage; label: string; desc: string }[] = [
  { key: 'new', label: '신규 접수', desc: '분류 중인 신규 문의' },
  { key: 'ai', label: 'AI 응대 중', desc: 'AI가 직접 응대하는 문의' },
  { key: 'human', label: '사람 응대', desc: '사람이 정해야 하는 문의' },
  { key: 'wait', label: '고객 회신 대기', desc: '고객 답을 기다리는 문의' },
  { key: 'closed', label: '종결', desc: 'AI 자동 종결 · 사람 종결' },
];

export const STAGE_LABEL: Record<Stage, string> = Object.fromEntries(STAGES.map((s) => [s.key, s.label])) as Record<Stage, string>;

export function stageOf(c: InboxCase): Stage {
  if (c.status === 'Closed') return 'closed';
  if (c.subStatus === 'Waiting on Customer') return 'wait';
  if (c.status === 'Escalated' || c.status === 'On Hold' || c.subStatus === 'Awaiting Approval') return 'human';
  if (c.status === 'New') return 'new';
  return 'ai';
}

/** 단계 아래 작은 글씨 (Figma: 분류 중 · AI 자동 응대 · 상담원 담당 …) */
export function stageDetail(c: InboxCase): string {
  switch (stageOf(c)) {
    case 'new':
      return '분류 중';
    case 'ai':
      return 'AI 자동 응대';
    case 'human':
      return c.status === 'On Hold' ? '보류' : c.subStatus === 'Awaiting Approval' ? '초안 승인 대기' : assigneeOf(c) ? '상담원 담당' : '담당 없음';
    case 'wait':
      return c.resolution.outcome === 'auto_answered' ? 'AI 발송' : '상담원 발송';
    case 'closed':
      return closedByHuman(c) ? '사람 종결' : 'AI 자동 종결';
  }
}

/** 담당자 — 사람이 인수 · 답변한 경우에만 서버가 이름을 남긴다 (assignee). */
export function assigneeOf(c: InboxCase): string | null {
  return c.raw?.assignee ?? (c.owner.type === 'user' ? c.owner.id : null);
}

export function closedByHuman(c: InboxCase): boolean {
  const last = [...c.statusHistory].reverse().find((h) => h.toStatus === 'Closed');
  return last?.changedBy.type === 'user';
}

export function closedAt(c: InboxCase): string {
  return c.raw?.closed_at ?? [...c.statusHistory].reverse().find((h) => h.toStatus === 'Closed')?.changedAt ?? c.audit.updatedAt;
}

export const receivedToday = (c: InboxCase) => isToday(c.audit.createdAt);
export const closedToday = (c: InboxCase) => c.status === 'Closed' && isToday(closedAt(c));
