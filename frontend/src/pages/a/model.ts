import type { InboxCase } from '../../lib/hooks';
import { HANDOFF_LABEL, RISK_REASONS, label } from '../../lib/labels';
import { waitMinutes } from '../../lib/format';

// Figma A 콘솔의 두 상태를 백엔드 상태에 대응시킨다.
//   답변 필요      = 사람에게 넘어온 건(Escalated) · 보류(On Hold) · 초안 승인 대기(Awaiting Approval)
//   고객 회신 대기 = Waiting on Customer
// 접수만 됐거나 AI가 처리 중인 건(New · Working)은 상담원이 할 일이 없어 문의함에 넣지 않는다.

export type Bucket = 'need' | 'wait' | 'closed' | 'ai';

export function bucketOf(c: InboxCase): Bucket {
  if (c.status === 'Closed') return 'closed';
  if (c.subStatus === 'Waiting on Customer') return 'wait';
  if (c.status === 'Escalated' || c.status === 'On Hold' || c.subStatus === 'Awaiting Approval') return 'need';
  return 'ai';
}

export type ReviewReason = { text: string; risk: boolean } | null;

/** 검토 사유 칸 */
export function reviewReason(c: InboxCase): ReviewReason {
  const r = c.resolution.handoffReason;
  if (c.signals?.threat) return { text: label(HANDOFF_LABEL, r ?? 'threat'), risk: true };
  if (r) return { text: label(HANDOFF_LABEL, r), risk: RISK_REASONS.has(r) };
  if (c.status === 'On Hold') return { text: '보류', risk: false };
  if (c.subStatus === 'Awaiting Approval') return { text: '초안 승인 대기', risk: false };
  return null;
}

/** 사람이 맡은 뒤 고객이 다시 쓴 건 = 새 답장 */
export function hasNewReply(c: InboxCase): boolean {
  return bucketOf(c) === 'need' && c.raw?.responder === 'human' && c.raw.lastMessageDirection === 'in' && priorHumanTouch(c);
}

function priorHumanTouch(c: InboxCase): boolean {
  return c.statusHistory.some((h) => h.toSubStatus === 'Waiting on Customer' || h.changedBy.type === 'user');
}

/**
 * 배정 이유 칸. Figma: 재문의 · 고객 답장 · 재배정 · 자동 배정.
 * 백엔드에는 상담원 배정이 없어 '재배정 · 자동 배정'은 만들 수 없다. 알 수 있는 두 가지만 보여준다.
 */
export function assignReason(c: InboxCase): string | null {
  if (hasNewReply(c)) return '고객 답장';
  if (c.raw?.reaskedAfterHandoff || c.relatedCaseId) return '재문의';
  return null;
}

/** 대기 시작 시각 — 고객의 마지막 메시지, 없으면 마지막 변경 시각 */
export function waitingSince(c: InboxCase): string {
  if (c.raw?.lastMessageDirection === 'in' && c.raw.lastMessageAt) return c.raw.lastMessageAt;
  return c.audit.updatedAt;
}

export function waitOf(c: InboxCase, now: Date): number {
  return waitMinutes(waitingSince(c), now);
}

export type FirstCard = { c: InboxCase; tag: string; risk: boolean; why: string };

/** 위험 신호 = 법적 언급 · 감정 4 이상. 이 건만 빨강으로 보여준다 (A-100 스펙 ⑦⑧). */
export function isRisk(c: InboxCase): boolean {
  const r = c.resolution.handoffReason;
  return Boolean(c.signals?.threat) || r === 'legal_threat' || r === 'threat' || (c.signals?.sentiment ?? 0) >= 4;
}

/**
 * 먼저 볼 건 — 법적 언급 › 감정 4 이상 › 새 답장 › 재문의 › 대기 시간 순으로 3건.
 * 조건에 맞는 건이 3건보다 적으면 남은 답변 필요 건을 오래 기다린 순으로 채운다.
 * 위험 신호는 빨강, 아니면 파랑. (Design Library › Interaction Rules › 콘솔 화면)
 */
export function firstToSee(list: InboxCase[], now = new Date()): FirstCard[] {
  const scored = list
    .filter((c) => bucketOf(c) === 'need')
    .map((c) => {
      const r = c.resolution.handoffReason;
      const s = c.signals?.sentiment ?? 0;
      const legal = Boolean(c.signals?.threat) || r === 'legal_threat' || r === 'threat';
      const rank = legal ? 0 : s >= 4 ? 1 : hasNewReply(c) ? 2 : assignReason(c) === '재문의' ? 3 : 4;
      // 카드 태그는 검토 사유나 배정 이유 키워드 하나
      const tag = rank === 2 ? '새 답장' : rank === 3 ? '재문의' : reviewReason(c)?.text ?? assignReason(c) ?? '답변 필요';
      return { c, rank, tag, risk: isRisk(c), s, wait: waitOf(c, now) };
    })
    .sort((a, b) => a.rank - b.rank || b.wait - a.wait)
    .slice(0, 3);

  return scored.map(({ c, tag, risk, s }) => ({
    c,
    tag,
    risk,
    why: [c.resolution.nextAction ?? c.summary ?? '', s ? `감정 ${s}` : ''].filter(Boolean).join(' · '),
  }));
}

/**
 * 마지막 응답 칸 — 'AI 안내 · 14:34' / '상담원 답변 · 13:10'(내가 맡은 건은 '내 답변') / null(응답 없음).
 * 목록 API에는 보낸 사람이 없어 처리 결과로 가린다: 사람이 답했거나 승인한 건은 상담원, 그 밖은 AI.
 */
export function lastReply(c: InboxCase, me?: string): { who: string; at: string } | null {
  if (c.raw?.lastMessageDirection !== 'out' || !c.raw.lastMessageAt) return null;
  const o = c.resolution.outcome;
  const human = o === 'human_answered' || o === 'answered_after_approval';
  const mine = Boolean(me) && (c.raw.assignee === me || c.owner.id === me);
  return { who: human ? (mine ? '내 답변' : '상담원 답변') : 'AI 안내', at: c.raw.lastMessageAt };
}

export function matches(c: InboxCase, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return true;
  return [c.caseNumber, c.subject, c.suppliedName, c.suppliedEmail, c.summary, c.raw?.lastMessagePreview]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(s));
}

export type SortKey = 'recent' | 'longest';

export function sortCases(list: InboxCase[], sort: SortKey, now: Date): InboxCase[] {
  const copy = [...list];
  if (sort === 'recent') copy.sort((a, b) => b.audit.createdAt.localeCompare(a.audit.createdAt));
  else copy.sort((a, b) => waitOf(b, now) - waitOf(a, now) || a.audit.createdAt.localeCompare(b.audit.createdAt));
  return copy;
}
