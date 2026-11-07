'use strict';
// 접속기록 — 고객 정보 조회·인증 실패·발송·정보주체 요청을 JSONL 한 줄씩 덧붙인다({at, action, user, ip, ...}).
// start 하지 않으면 아무것도 쓰지 않는다(테스트·데모·:memory:). 고객 본문·주소는 넣지 않는다.
// 단순화: 파일 하나에 덧붙이기만 — 회전·위변조 방지·외부 보관은 후속. 쓰기 실패는 stderr만 남기고 요청·발송은 그대로 간다(가용성 우선).
const fs = require('node:fs');
const db = require('./db');
const events = require('./events');

let file = null;
let stop = null;

function write({ action, user = null, ip = null, ...rest }) {
  if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify({ at: db.now(), action, user, ip, ...rest })}\n`); } catch (e) { console.error('[accesslog]', e.message); }
}

// 발송은 이벤트(draft.updated SENT)로 받는다 — 발송 코드는 건드리지 않는다. HTTP 요청 밖이라 ip는 없다.
// events.emit은 동기라 여기서 던지면 내보낸 쪽으로 번진다 — 본문 전체를 감싼다.
function onEvent({ name, data }) {
  try {
    if (name !== 'draft.updated' || data?.status !== 'SENT') return;
    const by = db.get('SELECT approved_by FROM drafts WHERE id=?', data.draftId)?.approved_by ?? null;
    write({ action: 'send', user: by, by, caseId: data.caseId, draftId: data.draftId, auto: by === 'agent:auto' });
  } catch (e) { console.error('[accesslog]', e.message); }
}

/** 기록 시작 — 두 번째 호출은 무시한다. 돌려주는 함수로 끈다(테스트용). subscribe:false = 발송 구독 없이 write만(별도 스크립트). */
function start(f, { subscribe = true } = {}) {
  if (stop) return stop;
  file = f;
  const unsub = subscribe ? events.subscribe(onEvent) : () => {};
  stop = () => { unsub(); file = null; stop = null; };
  return stop;
}

module.exports = { start, write };
