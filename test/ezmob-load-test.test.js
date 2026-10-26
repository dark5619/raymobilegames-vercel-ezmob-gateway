import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENDPOINT,
  MAX_QPS,
  REQUEST_TIMEOUT_MS,
  buildBidRequest,
  classifyResponse,
  createRateLimiter,
  main,
  resolveConfig,
  runLoadTest,
  sendBidRequest,
  validateEndpoint
} from '../scripts/ezmob-load-test.mjs';

// Automated tests must never reach EZmob: every test injects a mocked fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Real network access attempted from an automated test');
};

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/ezmob-load-test.mjs', import.meta.url));
const BLOCK_NETWORK_IMPORT = `data:text/javascript,${encodeURIComponent('globalThis.fetch = () => process.exit(99);')}`;
const TEST_IP = '203.0.113.77';
const TEST_IFA = '5f2b6c1e-8d3a-4e7b-9c0d-1a2b3c4d5e6f';
const BASE_ENV = Object.freeze({ EZMOB_TEST_DEVICE_IP: TEST_IP, EZMOB_TEST_IFA: TEST_IFA });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETAIL_LINE = /^\[(unexpected-status|timeout|network-error)\]/;
const silent = () => {};

function validConfig(overrides = {}) {
  const resolved = resolveConfig(BASE_ENV);
  assert.equal(resolved.ok, true);
  return { ...resolved.config, ...overrides };
}

// Timers oversleep (whole ms plus optional jitter); immediate() models one event-loop turn.
function virtualClock({ jitterMs = () => 0 } = {}) {
  let current = 0;
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => current,
    async sleep(ms, signal) {
      if (signal?.aborted) return;
      current += Math.max(1, Math.ceil(ms)) + jitterMs();
      await turn();
    },
    async immediate() {
      current += 0.1;
      await turn();
    }
  };
}

function mockFetch(clock, respond = () => new Response(null, { status: 204 })) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body), at: clock.now() };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function assertNoWindowExceeds(times, limit, windowMs = 1000) {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 0; i + limit < sorted.length; i += 1) {
    const spanMs = sorted[i + limit] - sorted[i];
    assert.ok(spanMs >= windowMs, `${limit + 1} requests were sent within ${spanMs} ms`);
  }
}

function largestBatch(times) {
  const perInstant = new Map();
  for (const time of times) perInstant.set(time, (perInstant.get(time) ?? 0) + 1);
  return Math.max(...perInstant.values());
}

function assertNoDeviceIdentifiers(text) {
  const lower = text.toLowerCase();
  assert.equal(lower.includes(TEST_IP), false, 'device IP leaked into output');
  assert.equal(lower.includes(TEST_IFA), false, 'IFA leaked into output');
  assert.equal(lower.includes(TEST_IFA.replaceAll('-', '')), false, 'IFA (without dashes) leaked into output');
}

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EZMOB_') || key === 'NODE_TEST_CONTEXT' || key === 'NODE_OPTIONS') delete env[key];
  }
  return { ...env, ...overrides };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30000 });
}

test('bid request matches the validated live Roku OpenRTB request', () => {
  const request = buildBidRequest({ requestId: 'request-1', impId: 'imp-1', deviceIp: TEST_IP, ifa: TEST_IFA });
  assert.deepEqual(request, {
    id: 'request-1',
    at: 1,
    tmax: 500,
    cur: ['USD'],
    imp: [
      {
        id: 'imp-1',
        secure: 1,
        video: {
          mimes: ['video/mp4'],
          minduration: 5,
          maxduration: 60,
          protocols: [2, 3, 5, 6],
          w: 1280,
          h: 720,
          startdelay: 0,
          linearity: 1,
          skip: 0,
          minbitrate: 300,
          maxbitrate: 12000,
          placement: 1,
          pos: 7,
          playbackmethod: [1]
        }
      }
    ],
    app: {
      name: 'Grab A Toy',
      bundle: '872115',
      domain: 'raymobile.games',
      storeurl: 'https://channelstore.roku.com/en-gb/details/e66e9e79ff8851a52bec86da46d73a39:8018d72e923a998f016da0daa8851f86/grab-a-toy',
      cat: ['IAB9-30'],
      ver: '1.1.8'
    },
    device: {
      devicetype: 3,
      make: 'Roku',
      model: '3940EU',
      os: 'Roku',
      osv: '16.0.4',
      ua: 'Roku/DVP-16.0 (16.0.4.834-CR)',
      lmt: 0,
      w: 1280,
      h: 720,
      ip: TEST_IP,
      ifa: TEST_IFA
    },
    regs: { coppa: 0 }
  });
});

test('every sent request has bundle 872115, devicetype 3, os Roku and no bidfloor', async () => {
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock);
  await runLoadTest(validConfig({ qps: 50, seconds: 2 }), { fetchImpl, clock, log: silent });

  assert.equal(calls.length, 100);
  for (const { url, options, body } of calls) {
    assert.equal(url, DEFAULT_ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(body.app.bundle, '872115');
    assert.equal(body.device.devicetype, 3);
    assert.equal(body.device.os, 'Roku');
    assert.equal(body.device.ip, TEST_IP);
    assert.equal(body.device.ifa, TEST_IFA);
    assert.equal(Object.hasOwn(body.imp[0], 'bidfloor'), false);
    assert.equal(Object.hasOwn(body.imp[0], 'bidfloorcur'), false);
  }
});

test('every request gets a new UUID request.id and a unique imp[0].id', async () => {
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock);
  await runLoadTest(validConfig({ qps: 100, seconds: 30 }), { fetchImpl, clock, log: silent });

  assert.equal(calls.length, 3000);
  const requestIds = new Set(calls.map(({ body }) => body.id));
  const impIds = new Set(calls.map(({ body }) => body.imp[0].id));
  assert.equal(requestIds.size, 3000);
  assert.equal(impIds.size, 3000);
  for (const { body } of calls) {
    assert.match(body.id, UUID_PATTERN);
    assert.equal(requestIds.has(body.imp[0].id), false);
  }
});

test('endpoint defaults to the plain-HTTP EZmob publisher URL', () => {
  assert.equal(DEFAULT_ENDPOINT, 'http://ads-n8it6d.rtbexchanges.com/openrtb/780760269');
  for (const env of [BASE_ENV, { ...BASE_ENV, EZMOB_LOAD_ENDPOINT: '' }]) {
    const { config } = resolveConfig(env);
    assert.equal(config.endpoint, DEFAULT_ENDPOINT);
    assert.equal(new URL(config.endpoint).protocol, 'http:');
  }
});

test('only the EZmob publisher endpoint is accepted as a target', () => {
  const https = 'https://ads-n8it6d.rtbexchanges.com/openrtb/780760269';
  assert.equal(validateEndpoint(https), https);
  assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_ENDPOINT: https }).config.endpoint, https);

  for (const url of [
    'http://example.com/openrtb/780760269',
    'http://ads-n8it6d.rtbexchanges.com/openrtb/000000000',
    'http://ads-n8it6d.rtbexchanges.com:8080/openrtb/780760269',
    'http://ads-n8it6d.rtbexchanges.com/openrtb/780760269?debug=1',
    'http://user:pass@ads-n8it6d.rtbexchanges.com/openrtb/780760269',
    'ftp://ads-n8it6d.rtbexchanges.com/openrtb/780760269',
    'not a url'
  ]) {
    assert.equal(validateEndpoint(url), null, url);
    assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_ENDPOINT: url }).ok, false, url);
  }
});

test('QPS defaults to 100 and cannot be configured above 100', () => {
  assert.equal(MAX_QPS, 100);
  assert.equal(resolveConfig(BASE_ENV).config.qps, 100);
  assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_QPS: '100' }).config.qps, 100);
  assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_QPS: '1' }).config.qps, 1);

  for (const value of ['101', '150', '1000', '0', '-1', '99.5', '1e2', 'abc']) {
    const resolved = resolveConfig({ ...BASE_ENV, EZMOB_LOAD_QPS: value });
    assert.equal(resolved.ok, false, value);
    assert.match(resolved.errors.join('\n'), /EZMOB_LOAD_QPS must be a whole number from 1 to 100/);
  }
});

test('duration defaults to 60 seconds and is limited to 1-300 seconds', () => {
  assert.equal(resolveConfig(BASE_ENV).config.seconds, 60);
  assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_SECONDS: '1' }).config.seconds, 1);
  assert.equal(resolveConfig({ ...BASE_ENV, EZMOB_LOAD_SECONDS: '300' }).config.seconds, 300);

  for (const value of ['0', '301', '3600', '1.5', 'sixty']) {
    const resolved = resolveConfig({ ...BASE_ENV, EZMOB_LOAD_SECONDS: value });
    assert.equal(resolved.ok, false, value);
    assert.match(resolved.errors.join('\n'), /EZMOB_LOAD_SECONDS must be a whole number from 1 to 300/);
  }
});

test('runLoadTest refuses more than 100 QPS even when called without resolveConfig', async () => {
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock);
  for (const qps of [101, 1000, 100.5]) {
    await assert.rejects(runLoadTest(validConfig({ qps }), { fetchImpl, clock, log: silent }), RangeError);
  }
  assert.equal(calls.length, 0);
});

test('missing device IP or IFA stops the run before any request is sent', async () => {
  assert.match(resolveConfig({ EZMOB_TEST_IFA: TEST_IFA }).errors.join('\n'), /EZMOB_TEST_DEVICE_IP is missing/);
  assert.match(resolveConfig({ EZMOB_TEST_DEVICE_IP: TEST_IP }).errors.join('\n'), /EZMOB_TEST_IFA is missing/);

  let fetchCalls = 0;
  const stdout = [];
  const stderr = [];
  const code = await main({
    env: { EZMOB_LOAD_QPS: '100', EZMOB_LOAD_SECONDS: '60' },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });

  assert.equal(code, 1);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join('\n'), /EZMOB_TEST_DEVICE_IP is missing/);
  assert.match(stderr.join('\n'), /EZMOB_TEST_IFA is missing/);

  const clock = virtualClock();
  const mocked = mockFetch(clock);
  await assert.rejects(
    runLoadTest(validConfig({ deviceIp: '', ifa: '' }), { fetchImpl: mocked.fetchImpl, clock, log: silent }),
    RangeError
  );
  assert.equal(mocked.calls.length, 0);
});

test('invalid device IP or IFA is rejected without echoing the value', () => {
  for (const [override, expected] of [
    [{ EZMOB_TEST_DEVICE_IP: '2001:db8::1' }, /must be an IPv4 address/],
    [{ EZMOB_TEST_DEVICE_IP: '192.168.1.50' }, /private, loopback or reserved/],
    [{ EZMOB_TEST_DEVICE_IP: '10.20.30.40' }, /private, loopback or reserved/],
    [{ EZMOB_TEST_IFA: 'not-a-roku-rida' }, /UUID format/],
    [{ EZMOB_TEST_IFA: '00000000-0000-0000-0000-000000000000' }, /non-zero Roku RIDA/]
  ]) {
    const resolved = resolveConfig({ ...BASE_ENV, ...override });
    assert.equal(resolved.ok, false);
    const text = resolved.errors.join('\n');
    assert.match(text, expected);
    for (const value of Object.values(override)) assert.equal(text.includes(value), false);
  }
});

test('the sliding-window limiter allows at most the cap within any one second', () => {
  const limiter = createRateLimiter(100);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.delayMs(0), 0);
    limiter.record(0);
  }
  assert.equal(limiter.delayMs(999), 1);
  assert.equal(limiter.delayMs(1000), 0);
  limiter.record(1000);
  assert.equal(limiter.delayMs(1000), 0);
});

test('100 QPS goes out in 100 ms batches of 10 and never exceeds 100 in any one-second window', async () => {
  const lateTimerMs = [16, 0, 9, 15, 2, 11, 5];
  let sleeps = 0;
  const clock = virtualClock({ jitterMs: () => lateTimerMs[sleeps++ % lateTimerMs.length] });
  const { calls, fetchImpl } = mockFetch(clock);
  const run = await runLoadTest(validConfig({ qps: 100, seconds: 60 }), { fetchImpl, clock, log: silent });

  const times = calls.map((call) => call.at);
  assert.equal(calls.length, 6000);
  assert.equal(run.stats.attempted, 6000);
  assert.equal(times.filter((time) => time === 0).length, 10);
  assert.ok(largestBatch(times) <= 10);
  assertNoWindowExceeds(times, 100);
  times.forEach((time, index) => {
    const lateMs = time - Math.floor(index / 10) * 100;
    assert.ok(lateMs >= 0 && lateMs < 50, `request ${index} went out ${lateMs} ms after its slot`);
  });
  assert.ok(run.sendWindowMs >= 60000 && run.sendWindowMs < 60100, `send window ${run.sendWindowMs} ms`);
});

test('a stalled event loop shifts the schedule instead of bursting above the cap', async () => {
  let sleeps = 0;
  const clock = virtualClock({ jitterMs: () => (++sleeps === 30 ? 700 : 0) });
  const { calls, fetchImpl } = mockFetch(clock);
  const run = await runLoadTest(validConfig({ qps: 100, seconds: 10 }), { fetchImpl, clock, log: silent });

  const times = calls.map((call) => call.at);
  assert.equal(calls.length, 1000);
  assert.ok(largestBatch(times) <= 10);
  assertNoWindowExceeds(times, 100);
  assert.ok(run.sendWindowMs >= 10700, `send window ${run.sendWindowMs} ms`);
});

test('real timers: 100 QPS for 2 seconds sends 200 requests without exceeding 100 in any second', async () => {
  const sentAt = [];
  const fetchImpl = async () => {
    sentAt.push(performance.now());
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(null, { status: 204 });
  };
  const run = await runLoadTest(validConfig({ qps: 100, seconds: 2 }), { fetchImpl, log: silent });

  assert.equal(sentAt.length, 200);
  assert.equal(run.stats.noBid, 200);
  assertNoWindowExceeds(sentAt, 100);
  assert.ok(run.sendWindowMs >= 2000 && run.sendWindowMs < 2500, `send window ${run.sendWindowMs} ms`);
});

test('HTTP 204 is counted as no_bid, not as an error', async () => {
  assert.equal(classifyResponse({ status: 204 }), 'no_bid');

  const clock = virtualClock();
  const { fetchImpl } = mockFetch(clock);
  const lines = [];
  const run = await runLoadTest(validConfig({ qps: 20, seconds: 3 }), { fetchImpl, clock, log: (line) => lines.push(line) });

  const { stats } = run;
  assert.equal(stats.noBid, 60);
  assert.equal(stats.completed, 60);
  assert.equal(stats.redirects + stats.http4xx + stats.http5xx + stats.timeouts + stats.networkErrors, 0);
  assert.equal(lines.some((line) => DETAIL_LINE.test(line)), false);
  assert.ok(lines.includes('  HTTP 204 no_bid: 60'));

  const code = await main({
    env: { ...BASE_ENV, EZMOB_LOAD_QPS: '10', EZMOB_LOAD_SECONDS: '1' },
    fetchImpl,
    clock,
    stdout: silent,
    stderr: silent
  });
  assert.equal(code, 0);
});

test('mixed outcomes are counted once each, logged with timestamp/request ID/status, and never retried', async () => {
  const responders = [
    () => new Response('{"id":"x","seatbid":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 202 }),
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/next' } }),
    () => new Response('bad request', { status: 400 }),
    () => new Response('unavailable', { status: 503 }),
    (call) => new Promise((_resolve, reject) => {
      call.options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
  ];
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock, (call, index) => responders[index % responders.length](call));
  const lines = [];
  const run = await runLoadTest(validConfig({ qps: 8, seconds: 2 }), {
    fetchImpl,
    clock,
    timeoutMs: 30,
    log: (line) => lines.push(line)
  });

  assert.equal(calls.length, 16);
  assert.deepEqual(
    {
      attempted: run.stats.attempted,
      completed: run.stats.completed,
      http200: run.stats.http200,
      http200Json: run.stats.http200Json,
      noBid: run.stats.noBid,
      other2xx: run.stats.other2xx,
      redirects: run.stats.redirects,
      http4xx: run.stats.http4xx,
      http5xx: run.stats.http5xx,
      timeouts: run.stats.timeouts,
      networkErrors: run.stats.networkErrors
    },
    {
      attempted: 16,
      completed: 16,
      http200: 2,
      http200Json: 2,
      noBid: 2,
      other2xx: 2,
      redirects: 2,
      http4xx: 2,
      http5xx: 2,
      timeouts: 2,
      networkErrors: 2
    }
  );

  const sentIds = new Set(calls.map(({ body }) => body.id));
  const detail = lines.filter((line) => DETAIL_LINE.test(line));
  assert.equal(detail.length, 12);
  for (const line of detail) {
    const match = line.match(/^\[[a-z-]+\] (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) request_id=(\S+)/);
    assert.ok(match, line);
    assert.ok(sentIds.has(match[2]), line);
  }
  for (const status of [202, 302, 400, 503]) {
    assert.equal(detail.filter((line) => line.includes(`status=${status}`)).length, 2, `status ${status}`);
  }
  assert.equal(detail.filter((line) => line.startsWith('[timeout]')).length, 2);
  assert.equal(detail.filter((line) => line.startsWith('[network-error]') && line.endsWith('error=ECONNRESET')).length, 2);
  assert.equal(lines.some((line) => line.includes('elsewhere.example')), false);
});

test('redirects are counted but never followed', async () => {
  const location = `https://elsewhere.example/landing?ip=${TEST_IP}&ifa=${TEST_IFA}`;
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock, () => new Response(null, { status: 307, headers: { location } }));
  const lines = [];
  const run = await runLoadTest(validConfig({ qps: 5, seconds: 1 }), { fetchImpl, clock, log: (line) => lines.push(line) });

  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ url, options }) => url === DEFAULT_ENDPOINT && options.redirect === 'manual'));
  assert.equal(run.stats.redirects, 5);
  assert.equal(lines.filter((line) => line.includes('status=307 redirect_not_followed location_present=true')).length, 5);
  assert.equal(lines.join('\n').includes('elsewhere.example'), false);
});

test('with the real fetch, a 302 is not followed and a slow response times out (local server only)', async (t) => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    req.resume();
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/landing' });
      res.end();
    } else if (req.url === '/slow') {
      setTimeout(() => res.end(), 1000).unref();
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const localOnlyFetch = (url, options) => {
    assert.ok(String(url).startsWith(`${base}/`), 'only the local test server may be contacted');
    return realFetch(url, options);
  };
  const bidRequest = buildBidRequest({ requestId: 'r-1', impId: 'i-1', deviceIp: TEST_IP, ifa: TEST_IFA });

  const redirect = await sendBidRequest({ endpoint: `${base}/redirect`, bidRequest, fetchImpl: localOnlyFetch });
  assert.equal(redirect.outcome, 'redirect');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.locationPresent, true);

  const slow = await sendBidRequest({ endpoint: `${base}/slow`, bidRequest, fetchImpl: localOnlyFetch, timeoutMs: 100 });
  assert.equal(slow.outcome, 'timeout');

  assert.deepEqual(paths, ['/redirect', '/slow']);
});

test('the default per-request timeout is 1200 ms', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 1200);
});

test('raw device IP and IFA never appear in normal console output', async (t) => {
  const echo = `ip=${TEST_IP}&ifa=${TEST_IFA}&IFA=${TEST_IFA.toUpperCase()}&rida=${TEST_IFA.replaceAll('-', '')}`;
  const responders = [
    () => new Response(`<VAST version="3.0"><Impression>https://t.example/i?${echo}</Impression></VAST>`, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }),
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 302, headers: { location: `https://t.example/r?${echo}` } }),
    () => new Response(echo, { status: 500 }),
    () => Promise.reject(new TypeError(`fetch failed ${echo}`, { cause: { code: 'ECONNRESET', message: echo } }))
  ];
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock, (call, index) => responders[index % responders.length](call));

  const captured = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const method of Object.keys(originals)) console[method] = (...args) => captured.push(args.join(' '));
  t.after(() => Object.assign(console, originals));

  const code = await main({ env: { ...BASE_ENV, EZMOB_LOAD_QPS: '25', EZMOB_LOAD_SECONDS: '6' }, fetchImpl, clock });
  Object.assign(console, originals);

  assert.equal(code, 0);
  assert.equal(calls.length, 150);
  assert.ok(calls.every(({ body }) => body.device.ip === TEST_IP && body.device.ifa === TEST_IFA));
  const output = captured.join('\n');
  assert.match(output, /EZMOB LOAD TEST START/);
  assert.match(output, /\[progress\] elapsed=5s/);
  assert.match(output, /EZMOB LOAD TEST COMPLETE/);
  assert.equal(output.includes('<VAST'), false, 'ad markup must not be printed outside debug mode');
  assertNoDeviceIdentifiers(output);
});

test('debug mode prints at most five HTTP 200 bodies, with the device IP and IFA redacted', async () => {
  const vast = (index) => `<VAST version="3.0"><Ad id="ad-${index}"/>` +
    `<Impression>https://t.example/i?ip=${TEST_IP}&ifa=${TEST_IFA.toUpperCase()}</Impression></VAST>`;
  const clock = virtualClock();
  const { fetchImpl } = mockFetch(clock, (_call, index) => new Response(vast(index), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  const lines = [];
  await runLoadTest(validConfig({ qps: 10, seconds: 1, debug: true }), { fetchImpl, clock, log: (line) => lines.push(line) });

  const debugLines = lines.filter((line) => line.startsWith('[debug]'));
  assert.equal(debugLines.length, 5);
  assert.ok(debugLines.every((line) => line.includes('<VAST version="3.0">') && line.includes('ip=[redacted]&ifa=[redacted]')));
  assertNoDeviceIdentifiers(lines.join('\n'));
});

test('progress is printed once every 5 seconds instead of once per request', async () => {
  const clock = virtualClock();
  const { fetchImpl } = mockFetch(clock);
  const lines = [];
  await runLoadTest(validConfig({ qps: 10, seconds: 12 }), { fetchImpl, clock, log: (line) => lines.push(line) });

  const progress = lines.filter((line) => line.startsWith('[progress]'));
  assert.deepEqual(
    progress.map((line) => line.match(/elapsed=(\d+)s attempted=(\d+)/).slice(1)),
    [['5', '50'], ['10', '100']]
  );
  assert.ok(lines.length < 40, `${lines.length} lines printed for 120 requests`);
});

test('start banner and summary report UTC times, counts and the first/last request IDs', async () => {
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock);
  const lines = [];
  const run = await runLoadTest(validConfig({ qps: 10, seconds: 2 }), { fetchImpl, clock, log: (line) => lines.push(line) });
  const isoUtc = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

  const start = lines.indexOf('EZMOB LOAD TEST START');
  assert.equal(start, 1);
  assert.match(lines[start + 1], new RegExp(`^UTC: ${isoUtc}$`));
  assert.deepEqual(lines.slice(start + 2, start + 6), [
    `Endpoint: ${DEFAULT_ENDPOINT}`,
    'QPS: 10',
    'Duration: 2 seconds',
    'Expected requests: 20'
  ]);

  assert.ok(lines.includes('EZMOB LOAD TEST COMPLETE'));
  assert.ok(lines.some((line) => new RegExp(`^UTC start: ${isoUtc}$`).test(line)));
  assert.ok(lines.some((line) => new RegExp(`^UTC end: ${isoUtc}$`).test(line)));
  assert.ok(lines.includes('Attempted requests: 20 (expected 20)'));
  assert.ok(lines.includes('Completed requests: 20'));
  assert.ok(lines.includes(`First request ID: ${calls[0].body.id}`));
  assert.ok(lines.includes(`Last request ID: ${calls.at(-1).body.id}`));
  assert.equal(run.stats.lastRequestId, calls.at(-1).body.id);
});

test('an interrupt stops new requests, drains in-flight ones and still prints the summary', async () => {
  const controller = new AbortController();
  const clock = virtualClock();
  const { calls, fetchImpl } = mockFetch(clock, (_call, index) => {
    if (index === 249) controller.abort();
    return new Response(null, { status: 204 });
  });
  const lines = [];
  const run = await runLoadTest(validConfig({ qps: 100, seconds: 60 }), {
    fetchImpl,
    clock,
    signal: controller.signal,
    log: (line) => lines.push(line)
  });

  assert.equal(calls.length, 250);
  assert.equal(run.interrupted, true);
  assert.equal(run.stats.completed, 250);
  assert.ok(lines.includes('EZMOB LOAD TEST COMPLETE'));
  assert.ok(lines.some((line) => line.startsWith('Stopped early by operator')));
});

test('CLI exits with a clear error and sends nothing when device IP and IFA are missing', () => {
  const result = runNode(['--import', BLOCK_NETWORK_IMPORT, SCRIPT_PATH], childEnv({
    EZMOB_LOAD_QPS: '1',
    EZMOB_LOAD_SECONDS: '1'
  }));

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /EZMOB_TEST_DEVICE_IP is missing/);
  assert.match(result.stderr, /EZMOB_TEST_IFA is missing/);
  assert.equal(result.stdout.includes('EZMOB LOAD TEST START'), false);
});

test('CLI refuses QPS above 100 before sending anything and does not print the IP or IFA', () => {
  const result = runNode(['--import', BLOCK_NETWORK_IMPORT, SCRIPT_PATH], childEnv({
    ...BASE_ENV,
    EZMOB_LOAD_QPS: '101',
    EZMOB_LOAD_SECONDS: '1'
  }));

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /EZMOB_LOAD_QPS must be a whole number from 1 to 100/);
  assert.equal(result.stdout.includes('EZMOB LOAD TEST START'), false);
  assertNoDeviceIdentifiers(`${result.stdout}\n${result.stderr}`);
});

test('node --test never executes the load-test script even though its name matches the default test glob', () => {
  const result = runNode(['--test', SCRIPT_PATH], childEnv());

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /skipped 1/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('EZMOB LOAD TEST'), false);
});
