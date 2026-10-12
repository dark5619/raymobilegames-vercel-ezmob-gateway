import crypto from 'node:crypto';

function intValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value, max = 1024) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

export function buildOpenRtbRequest({ query, clientIp, httpUserAgent, env = process.env }) {
  const lmt = cleanString(query.lmt, 8) === '1' ? 1 : 0;
  const rida = cleanString(query.ifa, 256);
  let rokuUa = cleanString(query.ua, 2048);

  // A literal macro means RAF did not expand it. Fall back to the real request UA.
  if (!rokuUa || rokuUa.includes('ROKU_ADS_')) {
    rokuUa = cleanString(httpUserAgent, 2048);
  }

  const width = Math.max(1, intValue(query.w, 1280));
  const height = Math.max(1, intValue(query.h, 720));

  const appName = cleanString(env.APP_NAME, 256) || 'Grab A Toy';
  const appBundle = cleanString(env.APP_BUNDLE, 128) || '872115';
  const appDomain = cleanString(env.APP_DOMAIN, 256) || 'raymobile.games';
  const appStoreUrl = cleanString(env.APP_STORE_URL, 2048) ||
    'https://channelstore.roku.com/en-gb/details/e66e9e79ff8851a52bec86da46d73a39:8018d72e923a998f016da0daa8851f86/grab-a-toy';

  const video = {
    mimes: ['video/mp4'],
    minduration: Math.max(1, intValue(env.VIDEO_MIN_DURATION, 5)),
    maxduration: Math.max(1, intValue(env.VIDEO_MAX_DURATION, 60)),
    // OpenRTB 2.5 protocol values: VAST 2/3 inline + wrappers.
    protocols: [2, 3, 5, 6],
    w: width,
    h: height,
    startdelay: 0,
    linearity: 1,
    skip: 0,
    minbitrate: Math.max(1, intValue(env.VIDEO_MIN_BITRATE, 300)),
    maxbitrate: Math.max(1, intValue(env.VIDEO_MAX_BITRATE, 12000)),
    placement: Math.max(1, intValue(env.VIDEO_PLACEMENT, 5)),
    pos: Math.max(0, intValue(env.VIDEO_POS, 7)),
    playbackmethod: [Math.max(1, intValue(env.VIDEO_PLAYBACK_METHOD, 1))]
  };

  const imp = {
    id: '1',
    secure: 1,
    video
  };

  const bidFloor = floatValue(env.EZMOB_BID_FLOOR_USD);
  if (bidFloor !== null && bidFloor >= 0) {
    imp.bidfloor = bidFloor;
    imp.bidfloorcur = 'USD';
  }

  const device = {
    devicetype: 3,
    make: 'Roku',
    model: cleanString(query.model, 256),
    os: 'Roku',
    osv: cleanString(query.osv, 128),
    ua: rokuUa,
    lmt
  };

  if (clientIp) device.ip = cleanString(clientIp, 128);

  // EZmob explicitly said not to pass RIDA as the standard advertising ID when LAT is enabled.
  if (lmt === 0 && rida) device.ifa = rida;

  // Avoid sending empty optional strings that can reduce request quality.
  for (const key of ['model', 'osv', 'ua']) {
    if (!device[key]) delete device[key];
  }

  const request = {
    id: crypto.randomUUID(),
    at: 1,
    tmax: Math.max(100, intValue(env.EZMOB_TMAX_MS, 500)),
    cur: ['USD'],
    imp: [imp],
    app: {
      name: appName,
      bundle: appBundle,
      domain: appDomain,
      storeurl: appStoreUrl
    },
    device,
    regs: {
      coppa: 0
    }
  };

  // Only forward privacy values when the Roku app actually supplies real values.
  const gdpr = cleanString(query.gdpr, 8);
  const consent = cleanString(query.consent, 4096);
  const usPrivacy = cleanString(query.us_privacy, 256);

  if (gdpr === '0' || gdpr === '1' || usPrivacy) {
    request.regs.ext = {};
    if (gdpr === '0' || gdpr === '1') request.regs.ext.gdpr = Number(gdpr);
    if (usPrivacy) request.regs.ext.us_privacy = usPrivacy;
  }

  if (consent) {
    request.user = { ext: { consent } };
  }

  return request;
}

export function sanitizeContext(query) {
  const value = cleanString(query.context, 32);
  return value === 'startup' || value === 'mission5' ? value : 'unknown';
}
