'use strict';
// 15초마다: (1) 예정 시각이 된 LLM 재시도를 돌린다 (2) 오래 조용한 케이스를 닫는다(고객에게는 아무것도 안 보낸다).
const db = require('./db');
const cases = require('./cases');
const loop = require('./loop');

const INTERVAL_MS = 15_000;
const autoCloseDays = () => Number(process.env.AUTO_CLOSE_DAYS || 30);

function autoClose(now = Date.now()) {
  const cutoff = new Date(now - autoCloseDays() * 86_400_000).toISOString();
  // 승인 대기·발송 중인 케이스는 사람이 볼 일이 남아 있어 닫지 않는다. 마지막 메시지·활동 기준.
  const rows = db.all(`SELECT c.id FROM cases c
    WHERE c.state NOT IN ('CLOSED', 'AWAITING_APPROVAL')
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=c.id AND d.status='SENDING')
      AND max(c.created_at, COALESCE((SELECT MAX(occurred_at) FROM messages m WHERE m.case_id=c.id), ''),
              COALESCE((SELECT MAX(created_at) FROM activities a WHERE a.case_id=c.id), '')) < ?`, cutoff);
  for (const { id } of rows) {
    cases.setState(id, 'CLOSED', { closed_at: db.now() });
    db.insert('activities', { id: db.uuid(), case_id: id, type: 'auto_close', actor: 'system', payload: JSON.stringify({ reason: 'inactive', days: autoCloseDays() }), created_at: db.now() });
  }
  return rows.length;
}

let busy = false;
async function tick(now = Date.now()) {
  if (busy) return { skipped: true };
  busy = true;
  try {
    const due = db.all('SELECT case_id, retry_message_id FROM loops WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?', new Date(now).toISOString());
    for (const r of due) {
      // 그 메시지 회차가 지금 돌고 있으면(기동 직후 recover와 겹침) 건드리지 않는다 — 그 회차가 끝나며 예약을 지우거나 새로 건다
      if (!loop.releaseForRerun(r.case_id, r.retry_message_id)) continue;
      db.run('UPDATE loops SET next_retry_at=NULL WHERE case_id=?', r.case_id); // 시도 횟수(retry_count)는 남긴다
      await loop.runCycle(r.case_id, r.retry_message_id).catch((e) => console.error('[sweeper] retry', e));
    }
    return { retried: due.length, closed: autoClose(now) };
  } finally { busy = false; }
}

function start() {
  const t = setInterval(() => tick().catch((e) => console.error('[sweeper]', e)), INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}

module.exports = { tick, start, autoClose };
