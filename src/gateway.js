import { buildOpenRtbRequest, sanitizeContext } from './openrtb.js';
import { EMPTY_VAST, collectCompatibleBids, extractVastVersion } from './vast.js';

function intValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getClientIp(headers = {}) {
  // Vercel documents these as the public client IP. Prefer the Vercel-specific header.
  const raw = headers['x-vercel-forwarded-for'] || headers['x-forwarded-for'] || headers['x-real-ip'] || '';
  return String(Array.isArray(raw) ? raw[0] : raw).split(',')[0].trim();
}

export function parseQuery(req) {
  const host = req.headers?.host || 'localhost';
  const protocol = req.headers?.['x-forwarded-proto'] || 'https';
  const url = new URL(req.url || '/roku/vast', `${protocol}://${host}`);
  return Object.fromEntries(url.searchParams.entries());
}

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

export function sendVast(res, xml = EMPTY_VAST, status = 200) {
  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  return res.status(status).send(xml);
}

function safeLog(kind, payload = {}) {
  // Never log RIDA, client IP, full URL, consent strings, VAST markup or secrets.
  const safe = { event: kind, ...payload };
  console.log(JSON.stringify(safe));
}

export function validateUpstreamUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);

    const allowedHost = 'ads-n8it6d.rtbexchanges.com';
    const allowedPath = '/openrtb/780760269';

    if (url.hostname !== allowedHost) return null;
    if (url.pathname !== allowedPath) return null;

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      return null;
    }

    if (url.username || url.password || url.search || url.hash) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export async function handleRokuVast(req, res, { env = process.env, fetchImpl = fetch } = {}) {
  if (req.method !== 'GET') {
    setNoCacheHeaders(res);
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  const query = parseQuery(req);
  const context = sanitizeContext(query);
  const upstreamUrl = validateUpstreamUrl(env.EZMOB_OPENRTB_URL);

  if (!upstreamUrl) {
    safeLog('gateway_not_configured', { context, reason: 'missing_or_invalid_upstream' });
    return sendVast(res);
  }

  const clientIp = getClientIp(req.headers || {});
  const httpUserAgent = String(req.headers?.['user-agent'] || '');
  const bidRequest = buildOpenRtbRequest({ query, clientIp, httpUserAgent, env });

  safeLog('openrtb_request', {
    context,
    request_id: bidRequest.id,
    bundle: bidRequest.app.bundle,
    lmt: bidRequest.device.lmt,
    ifa_present: Boolean(bidRequest.device.ifa),
    ip_present: Boolean(bidRequest.device.ip),
    ua_present: Boolean(bidRequest.device.ua),
    width: bidRequest.imp[0].video.w,
    height: bidRequest.imp[0].video.h,
    bidfloor_present: Number.isFinite(bidRequest.imp[0].bidfloor),
    upstream_protocol: new URL(upstreamUrl).protocol.replace(':', '')
  });

  const timeoutMs = Math.max(250, intValue(env.EZMOB_HTTP_TIMEOUT_MS, 1200));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-openrtb-version': '2.5',
        'User-Agent': 'RayMobileGames-GrabAToy-OpenRTB-Gateway/1.0'
      },
      body: JSON.stringify(bidRequest),
      signal: controller.signal
    });
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    safeLog(timeout ? 'upstream_timeout' : 'upstream_exception', { context });
    return sendVast(res);
  } finally {
    clearTimeout(timer);
  }

  safeLog('openrtb_response', { context, status: upstream.status });

  if (upstream.status === 204) {
    safeLog('no_bid', { context, reason: 'http_204' });
    return sendVast(res);
  }

  if (!upstream.ok) {
    safeLog('upstream_http_error', { context, status: upstream.status });
    return sendVast(res);
  }

  let body;
  try {
    body = await upstream.json();
  } catch {
    safeLog('invalid_openrtb_json', { context });
    return sendVast(res);
  }

  const compatibleBids = collectCompatibleBids(body);
  if (compatibleBids.length === 0) {
    const totalSeatbids = Array.isArray(body?.seatbid) ? body.seatbid.length : 0;
    safeLog('no_compatible_bid', { context, seatbid_count: totalSeatbids });
    return sendVast(res);
  }

  const winner = compatibleBids[0];
  const version = extractVastVersion(winner.adm);

  safeLog('bid_selected', {
    context,
    vast_version: version,
    price_present: Number.isFinite(Number(winner.price)),
    notice_url_present: Boolean(winner.nurl || winner.burl || winner.lurl)
  });

  // IMPORTANT: nurl/burl/lurl behavior is not guessed here. EZmob has not confirmed
  // the required notice semantics for this supply connection. VAST tracking inside
  // adm is left intact for Roku RAF to process client-side.
  return sendVast(res, winner.adm);
}
