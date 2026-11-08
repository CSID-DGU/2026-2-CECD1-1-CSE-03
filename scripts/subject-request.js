'use strict';
// 정보주체 요청(열람·삭제) — 서버와 같은 DB 파일(DB_PATH)에 직접 붙는다. 서버가 돌고 있어도 된다(파일 DB는 잠금을 기다린다).
//   node --no-warnings=ExperimentalWarning scripts/subject-request.js export <email> --by <이름> → 그 주소의 케이스 묶음 JSON을 stdout(처리 기록 + CRM 문서: 케이스·이벤트·활동·문의자)
//   node --no-warnings=ExperimentalWarning scripts/subject-request.js delete <email> --by <이름> → 종결 케이스를 제자리 가명화(server/retention.js)
// 둘 다 --by(처리자)가 있어야 한다 — 열람도 고객 원문을 내보내므로 접속기록에 누가 했는지 남긴다.
// delete는 종결 케이스만 다룬다. 종결 아닌 케이스가 있으면 그 id를 출력하고 exit 1 — 먼저 대시보드에서 종결한다.
// 케이스마다 짧은 트랜잭션 하나씩 파기하고, 그 사이 회신으로 다시 열렸거나 회차가 도는 케이스는 건너뛰고 id를 출력한다(exit 1). 사유는 stderr에 건수로.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const accesslog = require('../server/accesslog');
const cases = require('../server/cases');
const retention = require('../server/retention');
const collections = require('../server/collections');
const store = require('../server/store');
const kb = require('../server/kb');
const policy = require('../server/policy');
const { read } = require('../server/config-read');

const USAGE = '사용법: subject-request.js export|delete <email> --by <이름>';

function main(argv = process.argv.slice(2)) {
  const [cmd, email] = argv;
  const i = argv.indexOf('--by');
  const by = i > 0 ? argv[i + 1] : null;
  if (!['export', 'delete'].includes(cmd) || !email || !by) { console.error(USAGE); return 2; }
  const file = db.file();
  // 없는 경로면 init이 빈 DB를 새로 만들어 "대상 없음"으로 끝난다 — 경로 오타를 삭제 완료로 착각하지 않게 막는다
  if (!file || !fs.existsSync(file)) { console.error(`DB 파일이 없다: ${file || ':memory:'} — 서버와 같은 DB_PATH로 실행한다`); return 2; }
  db.init(file);
  // 고객이 게시한 KB·정책을 읽는다 — 없으면 열람·파기의 CRM 문서가 이미지 팩 값(caseType 등)으로 덮인다. 깨진 원문 경고는 stderr로(stdout JSON은 그대로)
  const onInvalid = ({ kind, channel, lang, error }) => console.error(`경고: ${kind}:${channel}${lang ? `:${lang}` : ''} 저장된 원문을 쓸 수 없어(${error}) 그 대상은 사람에게 넘기는 쪽으로 닫힌다`);
  kb.setReader(read, { onInvalid });
  policy.setReader(read, { onInvalid });
  // 서버와 같은 접속기록 파일(DB 폴더)에 요청 한 줄 — 발송 구독은 없다
  accesslog.start(path.join(path.dirname(file), 'access.jsonl'), { subscribe: false });
  const found = retention.findSubject(email);
  if (cmd === 'export') {
    // CRM 문서는 처리 기록에서 다시 계산한 지금 값으로 낸다(서버의 지연 동기화를 기다리지 않는다)
    const out = found.map((c) => {
      db.tx(() => collections.syncCase(c.id));
      const doc = store.get('cases', c.id)?.doc ?? null;
      const contact = doc?.contactId ? store.get('contacts', doc.contactId)?.doc ?? null : null;
      return { ...cases.getCase(c.id), crm: { case: doc, events: store.find('inbound_events', { resolvedCaseId: c.id }), activities: store.find('activities', { caseId: c.id }), contact } };
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    accesslog.write({ action: 'subject.export', user: by, by, cases: found.length });
    return 0;
  }
  const open = found.filter((c) => c.state !== 'CLOSED');
  if (open.length) {
    console.error(`종결되지 않은 케이스 ${open.length}건 — 대시보드에서 종결한 뒤 다시 실행한다`);
    for (const c of open) console.log(c.id);
    return 1;
  }
  const skipped = found.filter((c) => !retention.purge(c.id, { reason: 'subject_request', actor: by }));
  if (skipped.length < found.length) retention.checkpoint();
  accesslog.write({ action: 'subject.delete', user: by, by, cases: found.length - skipped.length });
  // 파기가 거절된 까닭 — 종결이 아니면 그 사이 다시 열렸고, 종결인데 거절됐으면 회차가 리스를 쥐고 있었다(retention.purge)
  const reopened = skipped.filter((c) => db.get('SELECT state FROM cases WHERE id=?', c.id).state !== 'CLOSED').length;
  const why = [reopened && `그 사이 다시 열림 ${reopened}건 — 종결 뒤`, skipped.length - reopened && `회차가 도는 중 ${skipped.length - reopened}건 — 잠시 뒤`].filter(Boolean).join(', ');
  console.error(`파기 ${found.length - skipped.length}건${skipped.length ? `, 건너뜀 ${skipped.length}건(${why} 다시 실행)` : ''}`);
  for (const c of skipped) console.log(c.id);
  return skipped.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
