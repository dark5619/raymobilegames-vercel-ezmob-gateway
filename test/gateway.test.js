import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenRtbRequest } from '../src/openrtb.js';
import { handleRokuVast, validateUpstreamUrl } from '../src/gateway.js';
import { EMPTY_VAST } from '../src/vast.js';

async function withCapturedLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (line) => {
    try {
      logs.push(JSON.parse(line));
    } catch {
      logs.push({ raw: line });
    }
  };
  try {
    await fn(logs);
  } finally {
    console.log = original;
  }
  return logs;
}

function makeReq(url, headers = {}) {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'gateway.example.test',
      'x-forwarded-proto': 'https',
      'x-vercel-forwarded-for': '203.0.113.10',
      'user-agent': 'Roku/DVP-15.0',
      ...headers
    }
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = JSON.stringify(body); return this; }
  };
}

const EZMOB_HTTP_URL = 'http://ads-n8it6d.rtbexchanges.com/openrtb/780760269';
const EZMOB_HTTPS_URL = 'https://ads-n8it6d.rtbexchanges.com/openrtb/780760269';

const baseEnv = {
  EZMOB_OPENRTB_URL: EZMOB_HTTP_URL,
  EZMOB_TMAX_MS: '500',
  EZMOB_HTTP_TIMEOUT_MS: '1200',
  APP_BUNDLE: '872115',
  EZMOB_BID_FLOOR_USD: ''
};

test('LAT off includes Roku RIDA in device.ifa', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'test-rida', w: '1920', h: '1080' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(request.device.lmt, 0);
  assert.equal(request.device.ifa, 'test-rida');
  assert.equal(request.device.devicetype, 3);
  assert.equal(request.app.bundle, '872115');
});

test('LAT on omits device.ifa even when query contains an RIDA', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '1', ifa: 'must-not-forward' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(request.device.lmt, 1);
  assert.equal(Object.hasOwn(request.device, 'ifa'), false);
});

test('bid floor is omitted when it has not been confirmed/configured', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(Object.hasOwn(request.imp[0], 'bidfloor'), false);
});

test('HTTP 204 returns safe empty VAST', async () => {
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake&w=1280&h=720');
  const res = makeRes();
  const fetchImpl = async () => ({ status: 204, ok: true, json: async () => ({}) });
  await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, EMPTY_VAST);
  assert.match(res.headers['content-type'], /application\/xml/);
});

test('VAST 3 adm is returned to Roku', async () => {
  const vast = '<?xml version="1.0"?><VAST version="3.0"><Ad id="1"></Ad></VAST>';
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake');
  const res = makeRes();
  const fetchImpl = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.app.bundle, '872115');
    assert.equal(requestBody.device.ifa, 'fake');
    return {
      status: 200,
      ok: true,
      json: async () => ({ seatbid: [{ bid: [{ id: 'b1', price: 2.1, adm: vast }] }] })
    };
  };
  await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
  assert.equal(res.body, vast);
});

test('VAST 4 is rejected for Roku RAF compatibility', async () => {
  const vast4 = '<?xml version="1.0"?><VAST version="4.2"><Ad id="1"></Ad></VAST>';
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake');
  const res = makeRes();
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ seatbid: [{ bid: [{ id: 'b1', price: 3, adm: vast4 }] }] })
  });
  await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
  assert.equal(res.body, EMPTY_VAST);
});

test('exact EZmob HTTP OpenRTB endpoint is accepted', () => {
  assert.equal(validateUpstreamUrl(EZMOB_HTTP_URL), EZMOB_HTTP_URL);
});

test('exact EZmob HTTPS OpenRTB endpoint is accepted', () => {
  assert.equal(validateUpstreamUrl(EZMOB_HTTPS_URL), EZMOB_HTTPS_URL);
});

test('another HTTP hostname is rejected', () => {
  assert.equal(
    validateUpstreamUrl('http://evil.example/openrtb/780760269'),
    null
  );
});

test('another path is rejected', () => {
  assert.equal(
    validateUpstreamUrl('http://ads-n8it6d.rtbexchanges.com/openrtb/000000000'),
    null
  );
});

test('EZmob HTTP diagnostic endpoint is used for the upstream POST', async () => {
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake');
  const res = makeRes();
  let postedUrl = null;
  let fetchOptions = null;
  const fetchImpl = async (url, options) => {
    postedUrl = url;
    fetchOptions = options;
    return {
      status: 204,
      ok: true,
      redirected: false,
      url: EZMOB_HTTP_URL,
      headers: { 'content-type': 'application/json' },
      json: async () => ({})
    };
  };
  await handleRokuVast(req, res, {
    env: { ...baseEnv, EZMOB_OPENRTB_URL: EZMOB_HTTP_URL },
    fetchImpl
  });
  assert.equal(postedUrl, EZMOB_HTTP_URL);
  assert.equal(fetchOptions.redirect, 'manual');
  assert.equal(res.body, EMPTY_VAST);
});

test('openrtb_raw_request logs the exact EZmob bid body before fetch', async () => {
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake&w=1280&h=720&app_version=1.2.3');
  const res = makeRes();
  let postedUrl = null;
  let fetchOptions = null;
  let rawLogBeforeFetch = null;

  const logs = await withCapturedLogs(async (captured) => {
    const fetchImpl = async (url, options) => {
      postedUrl = url;
      fetchOptions = options;
      rawLogBeforeFetch = captured.find((entry) => entry.event === 'openrtb_raw_request') || null;
      return {
        status: 204,
        ok: true,
        redirected: false,
        url: EZMOB_HTTP_URL,
        headers: {}
      };
    };
    await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
  });

  const sentBody = JSON.parse(fetchOptions.body);
  const rawLog = logs.find((entry) => entry.event === 'openrtb_raw_request');
  const summaryLog = logs.find((entry) => entry.event === 'openrtb_request');
  const responseLog = logs.find((entry) => entry.event === 'openrtb_response');
  const noBidLog = logs.find((entry) => entry.event === 'no_bid');

  assert.ok(rawLogBeforeFetch);
  assert.equal(rawLog.request_id, sentBody.id);
  assert.deepEqual(rawLog.body, sentBody);
  assert.equal(rawLog.endpoint, EZMOB_HTTP_URL);
  assert.equal(postedUrl, EZMOB_HTTP_URL);
  assert.equal(fetchOptions.redirect, 'manual');
  assert.equal(Object.hasOwn(sentBody.imp[0], 'bidfloor'), false);
  assert.equal(sentBody.app.bundle, '872115');
  assert.equal(sentBody.tmax, 500);
  assert.equal(summaryLog.request_id, sentBody.id);
  assert.equal(summaryLog.bundle, '872115');
  assert.equal(summaryLog.configured_protocol, 'http');
  assert.equal(summaryLog.bidfloor_present, false);
  assert.equal(responseLog.status, 204);
  assert.equal(responseLog.redirected, false);
  assert.equal(noBidLog.reason, 'http_204');
});

test('unapproved HTTP hostname does not call upstream or log a raw payload', async () => {
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake');
  const res = makeRes();
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { status: 204, ok: true, json: async () => ({}) };
  };
  const logs = await withCapturedLogs(async () => {
    await handleRokuVast(req, res, {
      env: { ...baseEnv, EZMOB_OPENRTB_URL: 'http://evil.example/openrtb/780760269' },
      fetchImpl
    });
  });
  assert.equal(fetchCalled, false);
  assert.equal(res.body, EMPTY_VAST);
  assert.equal(logs.some((entry) => entry.event === 'openrtb_raw_request'), false);
});

test('highest priced compatible VAST bid is selected', async () => {
  const low = '<VAST version="3.0"><Ad id="low"></Ad></VAST>';
  const high = '<VAST version="3.0"><Ad id="high"></Ad></VAST>';
  const req = makeReq('/roku/vast?context=mission5&lmt=0&ifa=fake');
  const res = makeRes();
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      seatbid: [{ bid: [
        { id: 'b1', price: 1.1, adm: low },
        { id: 'b2', price: 2.2, adm: high }
      ] }]
    })
  });
  await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
  assert.equal(res.body, high);
});

test('IPv4 is written to device.ip', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(request.device.ip, '203.0.113.10');
  assert.equal(Object.hasOwn(request.device, 'ipv6'), false);
});

test('IPv6 is written to device.ipv6 and never device.ip', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720' },
    clientIp: '2001:db8::1',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(request.device.ipv6, '2001:db8::1');
  assert.equal(Object.hasOwn(request.device, 'ip'), false);
});

test('invalid client IP is omitted', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720' },
    clientIp: 'not-an-ip',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(Object.hasOwn(request.device, 'ip'), false);
  assert.equal(Object.hasOwn(request.device, 'ipv6'), false);
});

test('app.cat exists and app.ver is forwarded', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720', app_version: '1.2.3' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.deepEqual(request.app.cat, ['IAB9-30']);
  assert.equal(request.app.ver, '1.2.3');
  assert.equal(Object.hasOwn(request.app, 'publisher'), false);
});

test('device screen dimensions and default CTV placement are set', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: baseEnv
  });
  assert.equal(request.device.w, 1280);
  assert.equal(request.device.h, 720);
  assert.equal(request.imp[0].video.placement, 1);
  assert.equal(request.imp[0].video.pos, 7);
  assert.equal(request.imp[0].video.linearity, 1);
  assert.equal(request.imp[0].video.skip, 0);
  assert.deepEqual(request.imp[0].video.playbackmethod, [1]);
  assert.equal(request.imp[0].video.startdelay, 0);
  assert.deepEqual(request.imp[0].video.mimes, ['video/mp4']);
  assert.deepEqual(request.imp[0].video.protocols, [2, 3, 5, 6]);
  assert.equal(Object.hasOwn(request.imp[0], 'bidfloor'), false);
});

test('VIDEO_PLACEMENT env can restore placement 5 without code changes', () => {
  const request = buildOpenRtbRequest({
    query: { lmt: '0', ifa: 'rida', w: '1280', h: '720' },
    clientIp: '203.0.113.10',
    httpUserAgent: 'Roku/DVP-15.0',
    env: { ...baseEnv, VIDEO_PLACEMENT: '5' }
  });
  assert.equal(request.imp[0].video.placement, 5);
});

for (const status of [301, 302, 307, 308]) {
  test(`HTTP ${status} is logged as a redirect diagnostic and not followed`, async () => {
    const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake&w=1280&h=720');
    const res = makeRes();
    let fetchCalls = 0;
    const fetchImpl = async (_url, options) => {
      fetchCalls += 1;
      assert.equal(options.redirect, 'manual');
      return {
        status,
        ok: false,
        redirected: false,
        url: EZMOB_HTTP_URL,
        headers: {
          location: 'https://ads-n8it6d.rtbexchanges.com/openrtb/780760269?token=secret'
        }
      };
    };

    const logs = await withCapturedLogs(async () => {
      await handleRokuVast(req, res, { env: baseEnv, fetchImpl });
    });

    assert.equal(fetchCalls, 1);
    assert.equal(res.body, EMPTY_VAST);

    const redirectLog = logs.find((entry) => entry.event === 'upstream_redirect');
    assert.ok(redirectLog);
    assert.equal(redirectLog.status, status);
    assert.equal(redirectLog.location_present, true);
    assert.equal(Object.hasOwn(redirectLog, 'location'), false);
    assert.equal(
      JSON.stringify(logs).includes('https://ads-n8it6d.rtbexchanges.com/openrtb/780760269?token=secret'),
      false
    );

    const responseLog = logs.find((entry) => entry.event === 'openrtb_response');
    assert.equal(responseLog.status, status);
    assert.equal(responseLog.configured_protocol, 'http');
    assert.equal(responseLog.final_protocol, 'http');
    assert.equal(responseLog.final_host, 'ads-n8it6d.rtbexchanges.com');
    assert.equal(responseLog.redirected, false);
  });
}
