export function handleHealth(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  return res.status(200).json({
    ok: true,
    service: 'grab-a-toy-ezmob-openrtb-gateway',
    upstreamConfigured: Boolean(process.env.EZMOB_OPENRTB_URL)
  });
}
