export const EMPTY_VAST = '<?xml version="1.0" encoding="UTF-8"?><VAST version="3.0"></VAST>';

export function extractVastVersion(xml) {
  if (typeof xml !== 'string') return null;
  const match = xml.match(/<VAST\b[^>]*\bversion\s*=\s*["']([^"']+)["']/i);
  return match ? match[1].trim() : null;
}

export function isVastMarkup(xml) {
  if (typeof xml !== 'string') return false;
  return /<VAST\b/i.test(xml);
}

export function isRokuRafCompatibleVast(xml) {
  if (!isVastMarkup(xml)) return false;
  const version = extractVastVersion(xml);
  if (!version) return false;
  return version === '2.0' || version.startsWith('2.') || version === '3.0' || version.startsWith('3.');
}

export function collectCompatibleBids(openRtbResponse) {
  const bids = [];
  if (!openRtbResponse || !Array.isArray(openRtbResponse.seatbid)) return bids;

  for (const seat of openRtbResponse.seatbid) {
    if (!seat || !Array.isArray(seat.bid)) continue;
    for (const bid of seat.bid) {
      if (!bid || typeof bid.adm !== 'string') continue;
      const adm = bid.adm.trim();
      if (!adm || !isRokuRafCompatibleVast(adm)) continue;
      bids.push({ ...bid, adm });
    }
  }

  return bids.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
}
