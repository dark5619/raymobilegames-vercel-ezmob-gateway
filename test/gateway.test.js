import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenRtbRequest } from '../src/openrtb.js';
import { handleRokuVast, validateUpstreamUrl } from '../src/gateway.js';
import { EMPTY_VAST } from '../src/vast.js';

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
  EZMOB_OPENRTB_URL: EZMOB_HTTPS_URL,
  EZMOB_TMAX_MS: '500',
  EZMOB_HTTP_TIMEOUT_MS: '1200',
  APP_BUNDLE: '872115'
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
  const fetchImpl = async (url) => {
    postedUrl = url;
    return { status: 204, ok: true, json: async () => ({}) };
  };
  await handleRokuVast(req, res, {
    env: { ...baseEnv, EZMOB_OPENRTB_URL: EZMOB_HTTP_URL },
    fetchImpl
  });
  assert.equal(postedUrl, EZMOB_HTTP_URL);
  assert.equal(res.body, EMPTY_VAST);
});

test('unapproved HTTP hostname does not call upstream', async () => {
  const req = makeReq('/roku/vast?context=startup&lmt=0&ifa=fake');
  const res = makeRes();
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { status: 204, ok: true, json: async () => ({}) };
  };
  await handleRokuVast(req, res, {
    env: { ...baseEnv, EZMOB_OPENRTB_URL: 'http://evil.example/openrtb/780760269' },
    fetchImpl
  });
  assert.equal(fetchCalled, false);
  assert.equal(res.body, EMPTY_VAST);
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
