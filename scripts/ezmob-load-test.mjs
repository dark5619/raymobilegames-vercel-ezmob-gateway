// TEMPORARY DIAGNOSTIC TOOL - EZmob/Limelight OpenRTB load test. Remove after troubleshooting.
//
// EZmob samples roughly 1 in 1000 bid requests, so a few manual Roku tests can still show as
// 0 QPS / 0 Opportunities. EZmob asked for a short, controlled test volume (about 100 QPS)
// against publisher 780760269 (Grab A Toy, bundle 872115, Roku CTV).
//
// Run manually, only during the diagnostic window agreed with EZmob. This file is not used by
// the gateway, is not deployed, and is not reachable over HTTP.
// Usage: README.md, section "EZmob Temporary Load Test".

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const MAX_QPS = 100;
export const DEFAULT_QPS = 100;
export const MAX_SECONDS = 300;
export const DEFAULT_SECONDS = 60;
export const DEFAULT_ENDPOINT = 'http://ads-n8it6d.rtbexchanges.com/openrtb/780760269';
export const REQUEST_TIMEOUT_MS = 1200;

const ENDPOINT_HOST = 'ads-n8it6d.rtbexchanges.com';
const ENDPOINT_PATH = '/openrtb/780760269';
const SLOTS_PER_SECOND = 10;
const SLOT_MS = 1000 / SLOTS_PER_SECOND;
const RATE_WINDOW_MS = 1000;
const SPIN_MS = 20;
const PROGRESS_INTERVAL_MS = 5000;
const MAX_DETAIL_LINES = 100;
const MAX_DEBUG_BODIES = 5;
const RULE = '-'.repeat(40);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Roku settings show the LAN address, but EZmob needs the public IP the gateway forwards.
const NON_PUBLIC_IPV4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}

const REQUEST_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  Accept: 'application/json'
});

const OUTCOME_COUNTERS = Object.freeze({
  http_200: 'http200',
  no_bid: 'noBid',
  other_2xx: 'other2xx',
  redirect: 'redirects',
  http_4xx: 'http4xx',
  http_5xx: 'http5xx',
  other_status: 'otherStatus',
  timeout: 'timeouts',
  network_error: 'networkErrors'
});

const REAL_CLOCK = Object.freeze({
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    });
  },
  immediate: () => new Promise((resolve) => setImmediate(resolve))
});

export function buildBidRequest({ requestId, impId, deviceIp, ifa }) {
  return {
    id: requestId,
    at: 1,
    tmax: 500,
    cur: ['USD'],
    imp: [
      {
        id: impId,
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
      ip: deviceIp,
      ifa
    },
    regs: {
      coppa: 0
    }
  };
}

function parseWholeNumber(value, fallback) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

export function validateEndpoint(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== ENDPOINT_HOST || url.pathname !== ENDPOINT_PATH) return null;
    if (url.port || url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${ENDPOINT_HOST}${ENDPOINT_PATH}`;
  } catch {
    return null;
  }
}

export function resolveConfig(env = process.env) {
  const errors = [];
  const deviceIp = String(env.EZMOB_TEST_DEVICE_IP ?? '').trim();
  const ifa = String(env.EZMOB_TEST_IFA ?? '').trim();

  if (!deviceIp) {
    errors.push('EZMOB_TEST_DEVICE_IP is missing. Set it to the public IPv4 address of the Roku test device.');
  } else if (!net.isIPv4(deviceIp)) {
    errors.push('EZMOB_TEST_DEVICE_IP must be an IPv4 address (value not shown).');
  } else if (NON_PUBLIC_IPV4.check(deviceIp, 'ipv4')) {
    errors.push('EZMOB_TEST_DEVICE_IP is a private, loopback or reserved address (value not shown). Use the public IP of the Roku test device.');
  }

  if (!ifa) {
    errors.push('EZMOB_TEST_IFA is missing. Set it to the Roku RIDA of the test device.');
  } else if (!UUID_PATTERN.test(ifa) || ifa === ZERO_UUID) {
    errors.push('EZMOB_TEST_IFA must be a non-zero Roku RIDA in UUID format (value not shown).');
  }

  const qps = parseWholeNumber(env.EZMOB_LOAD_QPS, DEFAULT_QPS);
  if (!(qps >= 1 && qps <= MAX_QPS)) {
    errors.push(`EZMOB_LOAD_QPS must be a whole number from 1 to ${MAX_QPS}.`);
  }

  const seconds = parseWholeNumber(env.EZMOB_LOAD_SECONDS, DEFAULT_SECONDS);
  if (!(seconds >= 1 && seconds <= MAX_SECONDS)) {
    errors.push(`EZMOB_LOAD_SECONDS must be a whole number from 1 to ${MAX_SECONDS}.`);
  }

  const endpoint = validateEndpoint(String(env.EZMOB_LOAD_ENDPOINT ?? '').trim() || DEFAULT_ENDPOINT);
  if (!endpoint) {
    errors.push(`EZMOB_LOAD_ENDPOINT must be http(s)://${ENDPOINT_HOST}${ENDPOINT_PATH}; this tool refuses any other target.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      endpoint,
      qps,
      seconds,
      deviceIp,
      ifa,
      debug: /^(1|true|yes)$/i.test(String(env.EZMOB_LOAD_DEBUG ?? '').trim())
    }
  };
}

function assertRunnable(config) {
  const { qps, seconds, endpoint, deviceIp, ifa } = config ?? {};
  if (!Number.isInteger(qps) || qps < 1 || qps > MAX_QPS) {
    throw new RangeError(`qps must be a whole number from 1 to ${MAX_QPS}`);
  }
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new RangeError(`seconds must be a whole number from 1 to ${MAX_SECONDS}`);
  }
  if (!endpoint || validateEndpoint(endpoint) !== endpoint) {
    throw new RangeError('endpoint must be the EZmob publisher endpoint');
  }
  if (!deviceIp || !ifa) {
    throw new RangeError('device IP and IFA are required');
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRedactor(values) {
  const needles = new Set();
  for (const value of values) {
    const text = String(value ?? '').trim();
    // Anything shorter cannot be an IPv4 address or RIDA, and would mangle unrelated output.
    if (text.length < 7) continue;
    needles.add(text);
    if (text.includes('-')) needles.add(text.replaceAll('-', ''));
  }
  if (needles.size === 0) return (line) => String(line);

  const pattern = new RegExp(
    [...needles].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
    'gi'
  );
  return (line) => String(line).replace(pattern, '[redacted]');
}

// Hard cap: never more than maxPerWindow sends in any rolling window, whatever the timer jitter.
// Sends are recorded only after fetch has been called, so the cap also holds at the hand-off.
export function createRateLimiter(maxPerWindow, windowMs = RATE_WINDOW_MS) {
  const sentAt = [];
  let oldest = 0;
  return {
    delayMs(nowMs) {
      if (sentAt.length < maxPerWindow) return 0;
      return Math.max(0, sentAt[oldest] + windowMs - nowMs);
    },
    record(nowMs) {
      if (sentAt.length < maxPerWindow) {
        sentAt.push(nowMs);
        return;
      }
      sentAt[oldest] = nowMs;
      oldest = (oldest + 1) % maxPerWindow;
    }
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] ?? '') : '';
}

async function drainBody(response, keepText) {
  try {
    if (keepText && typeof response.text === 'function') return await response.text();
    if (typeof response.arrayBuffer === 'function') await response.arrayBuffer();
  } catch {
    // The HTTP outcome is already known; a failed body read does not change it.
  }
  return null;
}

function errorCode(error) {
  return String(error?.cause?.code || error?.code || error?.name || 'unknown').slice(0, 64);
}

export function classifyResponse(response) {
  const status = Number(response?.status);
  if (response?.type === 'opaqueredirect') return 'redirect';
  if (status === 200) return 'http_200';
  if (status === 204) return 'no_bid';
  if (status >= 200 && status < 300) return 'other_2xx';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'http_4xx';
  if (status >= 500 && status < 600) return 'http_5xx';
  return 'other_status';
}

export async function sendBidRequest({
  endpoint,
  bidRequest,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  clock = REAL_CLOCK,
  keepBody = false
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedMs = clock.now();

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS },
      body: JSON.stringify(bidRequest),
      redirect: 'manual',
      signal: controller.signal
    });
    const responseTimeMs = clock.now() - startedMs;
    const outcome = classifyResponse(response);
    const contentType = headerValue(response.headers, 'content-type');
    const locationPresent = Boolean(headerValue(response.headers, 'location'));
    const body = await drainBody(response, keepBody && outcome === 'http_200');
    return {
      outcome,
      status: response.status,
      responseTimeMs,
      jsonContentType: /json/i.test(contentType),
      locationPresent,
      body
    };
  } catch (error) {
    return { outcome: timedOut ? 'timeout' : 'network_error', errorCode: errorCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

function createStats() {
  return {
    attempted: 0,
    completed: 0,
    http200: 0,
    http200Json: 0,
    noBid: 0,
    other2xx: 0,
    redirects: 0,
    http4xx: 0,
    http5xx: 0,
    otherStatus: 0,
    timeouts: 0,
    networkErrors: 0,
    responses: 0,
    responseTimeTotalMs: 0,
    responseTimeMinMs: Infinity,
    responseTimeMaxMs: 0,
    firstRequestId: null,
    lastRequestId: null
  };
}

function recordResult(stats, result) {
  stats.completed += 1;
  stats[OUTCOME_COUNTERS[result.outcome]] += 1;
  if (result.outcome === 'http_200' && result.jsonContentType) stats.http200Json += 1;
  if (Number.isFinite(result.responseTimeMs)) {
    stats.responses += 1;
    stats.responseTimeTotalMs += result.responseTimeMs;
    stats.responseTimeMinMs = Math.min(stats.responseTimeMinMs, result.responseTimeMs);
    stats.responseTimeMaxMs = Math.max(stats.responseTimeMaxMs, result.responseTimeMs);
  }
}

function countErrors(stats) {
  return stats.redirects + stats.http4xx + stats.http5xx + stats.otherStatus + stats.timeouts + stats.networkErrors;
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(2);
}

function formatStartBanner(config, expectedRequests, startedAt, timeoutMs) {
  const lines = [
    RULE,
    'EZMOB LOAD TEST START',
    `UTC: ${startedAt.toISOString()}`,
    `Endpoint: ${config.endpoint}`,
    `QPS: ${config.qps}`,
    `Duration: ${config.seconds} seconds`,
    `Expected requests: ${expectedRequests}`,
    `Request timeout: ${timeoutMs} ms (no retries, redirects not followed)`
  ];
  if (config.debug) {
    lines.push(`Debug: on (bodies of the first ${MAX_DEBUG_BODIES} HTTP 200 responses are printed, device IP/IFA redacted)`);
  }
  lines.push(RULE);
  return lines;
}

function formatProgress(stats, elapsedMs) {
  const other2xx = stats.other2xx > 0 ? ` other2xx=${stats.other2xx}` : '';
  return `[progress] elapsed=${Math.floor(elapsedMs / 1000)}s attempted=${stats.attempted} ` +
    `completed=${stats.completed} inflight=${stats.attempted - stats.completed} ` +
    `200=${stats.http200} 204=${stats.noBid}${other2xx} errors=${countErrors(stats)}`;
}

function formatDetail(at, requestId, result, timeoutMs) {
  const prefix = `${at.toISOString()} request_id=${requestId}`;
  if (result.outcome === 'timeout') return `[timeout] ${prefix} no response within ${timeoutMs} ms`;
  if (result.outcome === 'network_error') return `[network-error] ${prefix} error=${result.errorCode}`;
  if (result.outcome === 'redirect') {
    return `[unexpected-status] ${prefix} status=${result.status} redirect_not_followed location_present=${result.locationPresent}`;
  }
  return `[unexpected-status] ${prefix} status=${result.status}`;
}

function formatSummary(run, timeoutMs) {
  const { stats } = run;
  const sendSeconds = run.sendWindowMs / 1000;
  const achievedQps = sendSeconds > 0 ? (stats.attempted / sendSeconds).toFixed(1) : 'n/a';
  const responseTimes = stats.responses > 0
    ? `avg ${(stats.responseTimeTotalMs / stats.responses).toFixed(1)} ms, ` +
      `min ${stats.responseTimeMinMs.toFixed(1)} ms, max ${stats.responseTimeMaxMs.toFixed(1)} ms`
    : 'n/a (no HTTP responses)';

  const lines = [RULE, 'EZMOB LOAD TEST COMPLETE'];
  if (run.interrupted) {
    lines.push('Stopped early by operator (Ctrl+C): the remaining scheduled requests were not sent.');
  }
  lines.push(
    `UTC start: ${run.startedAt.toISOString()}`,
    `UTC end: ${run.endedAt.toISOString()}`,
    `Actual duration: ${formatSeconds(run.durationMs)} seconds`,
    `Send window: ${formatSeconds(run.sendWindowMs)} seconds (achieved ${achievedQps} QPS)`,
    `Attempted requests: ${stats.attempted} (expected ${run.expectedRequests})`,
    `Completed requests: ${stats.completed}`,
    'Response counts:',
    `  HTTP 200: ${stats.http200} (JSON content-type: ${stats.http200Json})`,
    `  HTTP 204 no_bid: ${stats.noBid}`,
    `  Other 2xx: ${stats.other2xx}`,
    `  Redirects (3xx, not followed): ${stats.redirects}`,
    `  HTTP 4xx: ${stats.http4xx}`,
    `  HTTP 5xx: ${stats.http5xx}`
  );
  if (stats.otherStatus > 0) lines.push(`  Other HTTP status: ${stats.otherStatus}`);
  lines.push(
    'Timeouts/errors:',
    `  Timeouts (no response within ${timeoutMs} ms): ${stats.timeouts}`,
    `  Network errors: ${stats.networkErrors}`,
    `Response time (HTTP responses only): ${responseTimes}`,
    `First request ID: ${stats.firstRequestId ?? 'n/a'}`,
    `Last request ID: ${stats.lastRequestId ?? 'n/a'}`
  );
  if (run.suppressedDetailLines > 0) {
    lines.push(`Per-request detail lines suppressed after the first ${MAX_DETAIL_LINES}: ${run.suppressedDetailLines}`);
  }
  lines.push(RULE);
  return lines;
}

async function sleepUntil(clock, targetMs, signal) {
  while (!signal?.aborted) {
    const remainingMs = targetMs - clock.now();
    if (remainingMs <= 0) return;
    await clock.sleep(remainingMs, signal);
  }
}

// Timers can fire ~16 ms late (Windows timer resolution). A late wake after a rate-limit wait
// would be inherited by every later request one window on, so the delay would keep growing.
// Finish such waits by yielding to the event loop instead.
async function waitPrecisely(clock, targetMs, signal) {
  while (!signal?.aborted) {
    const remainingMs = targetMs - clock.now();
    if (remainingMs <= 0) return;
    if (remainingMs > SPIN_MS) await clock.sleep(remainingMs - SPIN_MS, signal);
    else await clock.immediate();
  }
}

export async function runLoadTest(config, {
  fetchImpl = globalThis.fetch,
  clock = REAL_CLOCK,
  wallClock = () => new Date(),
  log = (line) => console.log(line),
  signal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  createId = () => crypto.randomUUID()
} = {}) {
  assertRunnable(config);

  const redact = createRedactor([config.deviceIp, config.ifa]);
  const print = (line) => log(redact(line));
  const qps = Math.min(config.qps, MAX_QPS);
  const totalSlots = config.seconds * SLOTS_PER_SECOND;
  const expectedRequests = qps * config.seconds;
  const limiter = createRateLimiter(qps);
  const stats = createStats();
  const inflight = new Set();
  const stopped = () => Boolean(signal?.aborted);
  let detailLines = 0;
  let suppressedDetailLines = 0;
  let debugBodies = 0;
  let reportError = null;

  function report(requestId, result) {
    recordResult(stats, result);

    if (result.body !== null && result.body !== undefined && debugBodies < MAX_DEBUG_BODIES) {
      debugBodies += 1;
      print(`[debug] ${wallClock().toISOString()} request_id=${requestId} status=${result.status} body=${result.body}`);
    }

    if (result.outcome === 'http_200' || result.outcome === 'no_bid') return;
    if (detailLines >= MAX_DETAIL_LINES) {
      suppressedDetailLines += 1;
      return;
    }
    detailLines += 1;
    print(formatDetail(wallClock(), requestId, result, timeoutMs));
    if (detailLines === MAX_DETAIL_LINES) {
      print(`[note] ${MAX_DETAIL_LINES} per-request lines printed; further ones are suppressed (totals are still counted).`);
    }
  }

  function dispatch() {
    const requestId = createId();
    const bidRequest = buildBidRequest({
      requestId,
      impId: createId(),
      deviceIp: config.deviceIp,
      ifa: config.ifa
    });
    stats.attempted += 1;
    stats.firstRequestId ??= requestId;
    stats.lastRequestId = requestId;

    const pending = sendBidRequest({
      endpoint: config.endpoint,
      bidRequest,
      fetchImpl,
      timeoutMs,
      clock,
      keepBody: Boolean(config.debug)
    })
      .then((result) => report(requestId, result))
      .catch((error) => {
        reportError ??= error;
      })
      .finally(() => inflight.delete(pending));
    inflight.add(pending);
  }

  const startedAt = wallClock();
  const startMs = clock.now();
  for (const line of formatStartBanner(config, expectedRequests, startedAt, timeoutMs)) print(line);

  let scheduleBaseMs = startMs;
  let nextProgressMs = PROGRESS_INTERVAL_MS;
  for (let slot = 0; slot < totalSlots && !stopped(); slot += 1) {
    const slotStartMs = scheduleBaseMs + slot * SLOT_MS;
    await sleepUntil(clock, slotStartMs, signal);
    const lateMs = clock.now() - slotStartMs;
    // After a stall, shift the rest of the schedule instead of bursting to catch up.
    if (lateMs >= SLOT_MS) scheduleBaseMs += lateMs;

    const elapsedMs = clock.now() - startMs;
    if (elapsedMs >= nextProgressMs) {
      print(formatProgress(stats, elapsedMs));
      while (nextProgressMs <= elapsedMs) nextProgressMs += PROGRESS_INTERVAL_MS;
    }

    const quota = Math.ceil(((slot + 1) * qps) / SLOTS_PER_SECOND) - Math.ceil((slot * qps) / SLOTS_PER_SECOND);
    for (let sent = 0; sent < quota && !stopped();) {
      const nowMs = clock.now();
      const waitMs = limiter.delayMs(nowMs);
      if (waitMs > 0) {
        await waitPrecisely(clock, nowMs + waitMs, signal);
        continue;
      }
      dispatch();
      limiter.record(clock.now());
      sent += 1;
    }
  }

  await sleepUntil(clock, scheduleBaseMs + totalSlots * SLOT_MS, signal);
  const sendWindowMs = clock.now() - startMs;
  await Promise.allSettled([...inflight]);
  if (reportError) throw reportError;

  const run = {
    stats,
    expectedRequests,
    startedAt,
    endedAt: wallClock(),
    durationMs: clock.now() - startMs,
    sendWindowMs,
    interrupted: stats.attempted < expectedRequests,
    suppressedDetailLines
  };
  for (const line of formatSummary(run, timeoutMs)) print(line);
  return run;
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
  clock = REAL_CLOCK
} = {}) {
  const redact = createRedactor([env.EZMOB_TEST_DEVICE_IP, env.EZMOB_TEST_IFA]);
  const out = (line) => stdout(redact(line));
  const err = (line) => stderr(redact(line));

  const resolved = resolveConfig(env);
  if (!resolved.ok) {
    err('EZMOB LOAD TEST NOT STARTED - configuration error:');
    for (const message of resolved.errors) err(`  - ${message}`);
    err('No requests were sent. See "EZmob Temporary Load Test" in README.md.');
    return 1;
  }

  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    out(`[interrupt] Stopping: no new requests will be sent; waiting up to ${REQUEST_TIMEOUT_MS} ms for in-flight requests. Press Ctrl+C again to quit immediately.`);
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    const run = await runLoadTest(resolved.config, { fetchImpl, clock, log: out, signal: controller.signal });
    return run.interrupted ? 130 : 0;
  } catch (error) {
    err(`EZMOB LOAD TEST FAILED: ${error?.message ?? error}`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function isEntryPoint() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // node --test's default glob (**/*-test.mjs) matches this file name, so `npm test` launches it
  // as a test file. A test-runner process must never send traffic.
  if (process.env.NODE_TEST_CONTEXT) {
    const { test } = await import('node:test');
    test('scripts/ezmob-load-test.mjs is a manual CLI tool and is not run by node --test', { skip: true }, () => {});
  } else {
    process.exitCode = await main();
  }
}
