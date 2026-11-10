'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../server/agents/tools');
const web = require('../server/agents/tools/web');

const ctx = { caseId: 'x', case: { customer_email: 'a@example.com' }, rawMessage: { sender: 'a@example.com', sender_auth: 'fail' }, pack: require('../server/policy').load('support'), kb: require('../server/kb').load('support'), triage: { intent: 'receipt' } };
const html = (body, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...extra });
const NAME = 'read_official_page';
let calls;
const useFetch = (fn) => web.setFetch(async (u, o) => { calls.push({ u, o }); return fn(u, o); });
const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const run = async (t, url) => { const r = await t.run(NAME, { url }); return { ...r, body: JSON.parse(r.content) }; };

beforeEach(() => { process.env.OFFICIAL_SITE_DOMAINS = 'help.example.com, Status.Example.com'; calls = []; web.setLookup(pub); });
afterEach(() => { delete process.env.OFFICIAL_SITE_DOMAINS; web.setFetch(); web.setLookup(); });

test('환경 변수가 없으면 툴이 보이지 않고 부르면 거절된다', async () => {
  delete process.env.OFFICIAL_SITE_DOMAINS;
  assert.ok(!tools.defs(ctx).some((d) => d.name === NAME));
  assert.equal((await tools.runner(ctx).run(NAME, { url: 'https://help.example.com/' })).isError, true);
});

test('고객 인증과 무관하게 노출되고, 정의가 작성 규칙을 지킨다', () => {
  const d = tools.defs(ctx).find((x) => x.name === NAME);
  assert.ok(d);
  assert.match(d.name, /^[a-z]+(_[a-z]+)+$/);
  assert.ok(d.description.split(/(?<=[.다])\s+/).length >= 3);
  assert.ok(!/반드시|MUST/.test(d.description));
  assert.equal(d.strict, true);
  assert.equal(d.input_schema.additionalProperties, false);
  assert.deepEqual(d.input_schema.required, ['url']);
  assert.ok(d.input_schema.properties.url.description);
  const src = require('node:fs').readFileSync(require.resolve('../server/agents/responder.js'), 'utf8');
  assert.ok(!src.slice(src.indexOf('const systemReact'), src.indexOf('// 지식베이스 본문 대신')).includes(NAME), '시스템 프롬프트에 툴 이름 없음');
});

test('허용 도메인과 하위 도메인은 읽고, HTML은 글자만 남기며 스크립트는 돌려주지 않는다', async () => {
  useFetch(() => html('<html><head><title>점검 &amp; 공지</title><style>.a{}</style></head><body><script>var secret="SCRIPTBODY"</script><noscript>NOJS</noscript><h1>정기   점검</h1><p>3일 &lt;02:00&gt; 안내&nbsp;드립니다</p><!-- hidden --></body></html>'));
  const t = tools.runner(ctx);
  const r = await run(t, 'https://Sub.Help.Example.com/notice?id=1');
  assert.equal(r.isError, false);
  assert.equal(r.body.title, '점검 & 공지');
  assert.equal(r.body.text, '정기 점검 3일 <02:00> 안내 드립니다');
  assert.ok(!/SCRIPTBODY|NOJS|hidden|<p>/.test(r.content));
  assert.equal(r.body.untrusted, true); assert.equal(r.body.truncated, false);
  assert.match(r.body.note, /데이터다/);
  assert.equal(calls[0].o.redirect, 'manual');
  assert.equal((await run(t, 'https://status.example.com/')).isError, false);
});

test('긴 본문은 3000자에서 자르고 truncated를 표시한다', async () => {
  useFetch(() => html(`<p>${'가'.repeat(5000)}</p>`));
  const r = await run(tools.runner(ctx), 'https://help.example.com/');
  assert.equal(r.body.text.length, 3000); assert.equal(r.body.truncated, true);
});

test('다른 도메인·http·사용자 정보·포트·경계가 틀린 도메인은 거절하고 허용 목록을 알려 준다', async () => {
  useFetch(() => html('x'));
  const t = tools.runner(ctx);
  for (const u of ['https://evil.com/', 'http://help.example.com/', 'https://user:pw@help.example.com/', 'https://help.example.com:8443/', 'https://nothelp.example.com/', 'https://help.example.com.evil.com/', 'ftp://help.example.com/', 'not a url']) {
    const r = await run(t, u);
    if (t.state.pages >= 3) t.state.pages = 0;
    assert.equal(r.isError, true, u);
    assert.match(r.body.next, /help\.example\.com/, u);
  }
  assert.equal(calls.length, 0, '검사에 걸리면 연결하지 않는다');
});

test('도메인이 내부망·예약 주소로 풀리면 거절한다(IPv4·IPv6·IPv4 매핑)', async () => {
  useFetch(() => html('x'));
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1']) {
    web.setLookup(async () => [{ address: ip }]);
    const r = await run(tools.runner(ctx), 'https://help.example.com/');
    assert.equal(r.isError, true, ip);
  }
  web.setLookup(async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }]);
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/')).isError, true, '하나라도 내부망이면 거절');
  web.setLookup(async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946' }]);
  useFetch(() => html('ok'));
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/')).isError, false, '공인 IPv6는 통과');
  assert.equal(calls.length, 1);
});

test('이동은 최대 3번 따라가고, 허용되지 않는 곳으로의 이동은 거절한다', async () => {
  useFetch((u) => {
    if (u.endsWith('/bad')) return new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } });
    if (u.endsWith('/http')) return new Response(null, { status: 301, headers: { location: 'http://help.example.com/x' } });
    if (u.endsWith('/loop')) return new Response(null, { status: 302, headers: { location: '/loop' } });
    if (u.endsWith('/one')) return new Response(null, { status: 302, headers: { location: 'https://status.example.com/two' } });
    return html('도착');
  });
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/bad')).isError, true);
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/http')).isError, true);
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/loop')).isError, true);
  assert.equal(calls.filter((c) => c.u.endsWith('/loop')).length, 4, '최초 + 3번 이동');
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/one')).body.text, '도착');
  // 이동 대상이 내부망으로 풀려도 거절
  web.setLookup(async (h) => [{ address: h === 'status.example.com' ? '10.0.0.1' : '93.184.216.34' }]);
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/one')).isError, true);
});

test('HTML·텍스트 외 형식은 거절하고, 텍스트는 그대로 읽는다', async () => {
  const t = tools.runner(ctx);
  useFetch(() => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
  assert.equal((await run(t, 'https://help.example.com/a.pdf')).isError, true);
  useFetch(() => new Response('점검 중입니다', { status: 200, headers: { 'content-type': 'text/plain' } }));
  assert.equal((await run(t, 'https://help.example.com/a.txt')).body.text, '점검 중입니다');
  useFetch(() => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }));
  assert.equal((await run(t, 'https://help.example.com/none')).isError, true);
});

test('본문은 300KB까지만 읽는다', async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode('a'.repeat(64 * 1024))); } });
  useFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }));
  const r = await run(tools.runner(ctx), 'https://help.example.com/');
  assert.equal(r.isError, false);
  assert.ok(pulled <= 7, `pulled ${pulled}`);
});

test('한 사이클에 4번째 호출은 거절한다', async () => {
  useFetch(() => html('ok'));
  const t = tools.runner(ctx);
  for (let i = 0; i < 3; i += 1) assert.equal((await run(t, 'https://help.example.com/')).isError, false);
  const r = await run(t, 'https://help.example.com/');
  assert.equal(r.isError, true); assert.ok(r.body.next);
  assert.equal(calls.length, 3);
  assert.equal((await run(tools.runner(ctx), 'https://help.example.com/')).isError, false, '새 사이클은 다시 센다');
});

test('요청에 시간 제한 신호가 붙고, 시간 초과는 오류로 돌려준다', async () => {
  web.setFetch(async (u, o) => { assert.ok(o.signal instanceof AbortSignal); throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  const r = await run(tools.runner(ctx), 'https://help.example.com/');
  assert.equal(r.isError, true); assert.match(r.body.error, /시간/);
});
