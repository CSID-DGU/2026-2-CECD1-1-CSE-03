'use strict';
// 담당자 빈 시간 조회 툴. 원본은 business.js의 meeting(요일·시간 틀 + 이미 찬 시간). 읽기 전용 — 예약하지 않는다. 확정은 담당자가 한다.
// 날짜를 쓰는 툴이라 팩이 날짜 언급을 허용하는 채널(guard.allowDates, 지금은 onboarding)에서만 보인다.
const { obj, out } = require('./schema');
const biz = require('./business');

const COUNT = 3;
const HORIZON_DAYS = 21;
const KST = 9 * 3600e3; // 시간대 고정(Asia/Seoul). 한계: 고객사 캘린더 연동 때 그쪽 시간대를 쓴다
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 틀이 없거나 시간대가 한국이 아니면 툴을 숨긴다(이 툴은 한국 시간만 계산한다)
const config = () => {
  let m; try { m = biz.load().meeting; } catch { return null; }
  return m && (m.timezone ?? 'Asia/Seoul') === 'Asia/Seoul' ? m : null;
};

function defs(ctx) {
  if (!biz.file() || !ctx.pack?.guard?.allowDates || !config()) return [];
  return [{
    name: 'find_meeting_slots',
    strict: true,
    description: '온보딩 담당자가 미팅을 잡을 수 있는 빈 시간 후보를 가까운 순서로 3개 돌려준다(날짜, 요일 한 글자, 시작 시각, 한국 시간). 고객이 미팅 가능한 시간을 묻거나 일정을 잡고 싶어 할 때 쓴다. 후보를 답장에 쓰면 근거에 tool:find_meeting_slots를 넣는다. 후보일 뿐 예약되지 않았다 — 답장에는 "가능한 후보"로 적고, 고객이 고르면 담당자가 확정한다고 다른 문장으로 쓴다. 날짜와 같은 문장에 "드리겠습니다·연락·회신·예정" 같은 약속 말을 붙이지 않는다(검사기가 기한 약속으로 막는다). 고객 개인 정보는 돌려주지 않는다.',
    input_schema: obj(),
  }];
}

function slots(now = Date.now()) {
  const m = config();
  const days = new Set((m.weekdays || []).map(Number));
  const busy = new Set((m.busy || []).map(String));
  const from = now + (Number(m.minLeadHours) || 0) * 3600e3;
  const found = [];
  const times = (m.times || []).filter((t) => TIME_RE.test(t)).sort(); // 형식이 틀린 시간은 버리고, 하루 안에서 이른 순
  const day0 = new Date(now + KST); day0.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < HORIZON_DAYS && found.length < COUNT; i++) {
    const d = new Date(day0.getTime() + i * 86400e3);
    if (!days.has(d.getUTCDay())) continue;
    const date = d.toISOString().slice(0, 10);
    for (const time of times) {
      const [h, mi] = String(time).split(':').map(Number);
      const at = d.getTime() + (h * 60 + mi) * 60e3 - KST; // 한국 시각 → UTC
      if (at < from || busy.has(`${date}T${time}`)) continue;
      found.push({ date, weekday: WEEKDAY[d.getUTCDay()], time });
      if (found.length >= COUNT) break;
    }
  }
  return { timezone: 'Asia/Seoul', slots: found, note: '후보일 뿐 예약되지 않았다. 고객이 고르면 담당자가 확정한다.' };
}

function handlers() {
  return { find_meeting_slots: () => out(slots()) };
}

module.exports = { defs, handlers, slots };
