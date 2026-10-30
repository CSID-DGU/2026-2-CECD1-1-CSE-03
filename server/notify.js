'use strict';
// 사람이 봐야 할 일(넘김·승인 대기 초안)을 Slack 호환 웹훅으로 알린다. NOTIFY_WEBHOOK_URL 없으면 아무것도 안 한다.
// 본문에 고객 이메일·전화·메시지 내용을 넣지 않는다 — 채널 이름·케이스 번호·사유만. 실패해도 루프는 모른다(fire-and-forget).
const db = require('./db');
const events = require('./events');
const policy = require('./policy');

function text(kind, { caseId, reason }) {
  const c = db.get('SELECT channel FROM cases WHERE id=?', caseId);
  const pack = c ? policy.load(c.channel) : null;
  return `[${pack?.label || c?.channel || '-'}] ${pack?.notify?.channel || ''} 케이스 ${String(caseId).slice(0, 8)} — ${kind}${reason ? `: ${reason}` : ''}`.replace(/\s+/g, ' ');
}

function start(url = process.env.NOTIFY_WEBHOOK_URL) {
  if (!url) return () => {};
  return events.subscribe(({ name, data }) => {
    let t = null;
    if (name === 'handoff.created') t = text('사람에게 넘김', data);
    else if (name === 'draft.created' && data.status === 'PENDING' && !data.auto) t = text('승인 대기 초안', data);
    else if (name === 'auto_send.failed' && data.status === 'PENDING') t = text('자동 발송 막힘 — 승인 대기 초안', data);
    if (!t) return;
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }), signal: AbortSignal.timeout(5000) })
      .catch((e) => console.warn('[notify]', e.message));
  });
}

module.exports = { start, text };
