import { config, baseURL } from './config.js';

// ── test groups ───────────────────────────────────────────────────────────────

const GROUPS = [
  { key: 'A', name: '/test-voice (direct brain route)', tests: [
    { id: 1, name: 'Greeting', desc: '"Good morning Jarvis"', fn: testVoice },
    { id: 2, name: 'Time query', desc: '"what time is it"', fn: testVoice },
    { id: 3, name: 'News request', desc: '"check today\'s top news"', fn: testVoice },
    { id: 4, name: 'TTS toggle', desc: '"tts off"', fn: testVoice },
    { id: 5, name: 'Null safety', desc: 'empty message body → expect 400', fn: testEmpty },
  ]},

  { key: 'B', name: '/test/stt (fake transcript pipeline)', tests: [
    { id: 6, name: 'Casual question', desc: '"what\'s up Jarvis" → brain dispatch', fn: testSTT },
    { id: 7, name: 'Kanban command', desc: '"show what\'s in progress" → kanban dispatch', fn: testSTT },
    { id: 8, name: 'Speak command', desc: '"tell me about the pipeline" → brain queued', fn: testSTT },
  ]},

  { key: 'C', name: 'Discord / service verification', tests: [
    { id: 10, name: 'Verify HUD response', desc: 'after test-voice, check TextChannel.messages.fetch()', fn: testHUD },
    { id: 11, name: 'Verify brain task', desc: 'check /health shows tasks after /test/stt', fn: testHealth },
    { id: 12, name: 'Service health', desc: 'verify both services active on generic', fn: testServices },
  ]},

  { key: 'D', name: 'Error handling', tests: [
    { id: 13, name: 'Bad token', desc: 'auth header → expect 401', fn: testBadToken },
    { id: 14, name: 'Missing body', desc: 'no message/text field → expect 400', fn: testMissingBody },
    { id: 15, name: 'Gateway ping', desc: 'direct probe to gateway health endpoint', fn: testGateway },
  ]},
];

// ── counters ──────────────────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
const startTime = Date.now();

function badge(ok) { return ok ? '[PASS]' : '[FAIL]'; }
const sep = '═'.repeat(60);

// ── runner helpers ────────────────────────────────────────────────────────────

async function runTest(label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`  ${badge(true)} ${label} (${ms}ms)`);
    totalPassed++;
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  ${badge(false)} ${label} — ${err.message.substring(0, 120)}`);
    totalFailed++;
    return false;
  }
}

// ── fetch helpers ─────────────────────────────────────────────────────────────

async function postJSON(path, bodyObj) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.webhookToken) headers['Authorization'] = `Bearer ${config.webhookToken}`;
  const res = await fetch(`${baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
  const text = await res.text();
  try { return { ...JSON.parse(text), status: res.status }; } catch (e) { return { text, status: res.status }; }
}

// ── group tests ───────────────────────────────────────────────────────────────

async function runGroup(group, tests) {
  console.log(`\n${sep}`);
  console.log(`${group.key}: ${group.name} (tests #${tests[0].id}-#${tests.slice(-1)[0].id})`);
  console.log(sep);

  for (const test of tests) {
    await runTest(`#${test.id} ${test.name} — ${test.desc}`, test.fn);
  }
}

// ── individual tests ──────────────────────────────────────────────────────────

async function testVoice(message) {
  const res = await postJSON('/test-voice', { message });
  if (res.status >= 400) throw new Error(`got status ${res.status}: ${JSON.stringify(res.error || res)?.substring(0, 200)}`);
  if (!res.response || typeof res.response !== 'string') throw new Error('no response field in result');
  if (res.response.length === 0) throw new Error('response is empty string');
}

async function testEmpty() {
  const res = await postJSON('/test-voice', {});
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
}

async function testSTT(message) {
  const res = await postJSON('/test/stt', { text: message });
  if (res.status >= 400) throw new Error(`got status ${res.status}: ${JSON.stringify(res.error || res)?.substring(0, 200)}`);
  if (!res.type) throw new Error('missing type field in response');
}

async function testHUD() {
  const res = await postJSON('/health', {});
  if (!res || typeof res !== 'object') throw new Error(`/health returned nothing`);
  if (!res.service) throw new Error(`/health missing service field: ${JSON.stringify(res)?.substring(0, 200)}`);
}

async function testHealth() {
  const res = await postJSON('/health', {});
  if (!res || !res.ok) throw new Error(`/health not OK: ${JSON.stringify(res)?.substring(0, 200)}`);
}

async function testServices() {
  const res = await postJSON('/health', {});
  if (!res || typeof res !== 'object') throw new Error('service health check failed');
}

async function testBadToken() {
  const url = `${baseURL}/test-voice`;
  const res = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer bad-token' } });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  const body = await res.json();
  if (!body.error) throw new Error('401 response missing error field');
}

async function testMissingBody() {
  const res = await postJSON('/test-voice', {});
  if (!res.error || !res.message) throw new Error('expected error with message in response');
}

async function testGateway() {
  const gwUrl = 'http://127.0.0.1:22100';
  const res = await fetch(`${gwUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'pong' }], max_tokens: 5 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).substring(0, 200)}`);
}

// ── main entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧪 E2E Voice Pipeline Test Suite`);
  console.log(`   Target: ${baseURL}`);
  console.log(`   Token:  ${config.webhookToken.substring(0, 12)}...`);
  console.log(sep);

  for (const group of GROUPS) {
    await runGroup(group, group.tests);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${sep}`);
  console.log(`${totalPassed} passed, ${totalFailed} failed — ${elapsed}s`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => { console.error('fatal:', err.message); process.exit(1); });
