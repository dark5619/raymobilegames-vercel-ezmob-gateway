# Grab A Toy — EZmob/Limelight OpenRTB Gateway for Vercel

Production-oriented lightweight Vercel gateway for the Roku game **Grab A Toy**.

## Architecture

```text
Roku RAF
  -> GET https://<gateway>/roku/vast
  -> Vercel Node.js Function
  -> POST OpenRTB 2.5 JSON
  -> EZmob/Limelight S2S CTV endpoint (publisher/supply ID 780760269)
  -> OpenRTB BidResponse
  -> seatbid[].bid[].adm (VAST)
  -> Vercel returns VAST XML
  -> Roku RAF getAds()/showAds()
```

The Roku client must **not** POST directly to the EZmob OpenRTB endpoint because EZmob confirmed that endpoint is intended for server-to-server integration.

## What is already implemented

- Vercel `/api` Node.js Functions, no framework and no runtime dependencies.
- Clean `/roku/vast` URL via `vercel.json` rewrite.
- `/health` endpoint.
- OpenRTB 2.5 POST with `Content-Type: application/json`.
- `app.bundle = "872115"`.
- `device.devicetype = 3`, `device.os = "Roku"`, `device.make = "Roku"`.
- Roku RIDA in `device.ifa` only when LAT is off.
- `device.lmt = 0/1`.
- Viewer public IP from Vercel's forwarded client-IP header.
- Roku User-Agent forwarding.
- `video/mp4`, VAST 2/3 inline+wrapper protocol values, H.264-compatible request shape.
- Fullscreen/non-skippable/autoplay-with-sound defaults for the app placement.
- Configurable `tmax` (default 500 ms).
- Configurable HTTP timeout (default 1200 ms).
- `$2` bid floor support exists but is OFF until EZmob confirms the commercial meaning.
- HTTP 204 and empty/no-compatible-bid handling.
- VAST 2/3 accepted; VAST 4.x rejected before reaching Roku RAF.
- Fail-open behavior: upstream errors return empty VAST so gameplay is not blocked.
- No application logs containing RIDA, IP, consent strings, full request URLs, VAST bodies or secrets.
- Automated tests with Node's built-in test runner.

## 1. Test locally

Node.js 24 is recommended.

```bash
npm test
npm run check
```

For local Vercel emulation, install Vercel CLI if desired and run:

```bash
vercel dev
```

Then open:

```text
http://localhost:3000/health
http://localhost:3000/roku/vast
```

Without `EZMOB_OPENRTB_URL`, `/roku/vast` deliberately returns an empty VAST 3 document.

## 2. Deploy to Vercel

1. Put this folder in a private Git repository.
2. In Vercel choose **Add New -> Project** and import the repository.
3. Framework preset can remain **Other** / auto-detected.
4. Deploy.
5. Vercel will give a URL similar to:
   `https://grabatoy-ad-gateway.vercel.app`
6. Verify:
   `https://<project>.vercel.app/health`
7. Verify:
   `https://<project>.vercel.app/roku/vast`

The repo includes a root `index.js` entrypoint (required by Vercel’s backend / Fluid compute detection) plus legacy `/api` handlers for local `vercel dev`. Public URLs are mapped with rewrites in `vercel.json`.

## 3. Vercel environment variables

Set these in **Project -> Settings -> Environment Variables**:

### Required for live EZmob traffic

```text
EZMOB_OPENRTB_URL=https://<HTTPS endpoint supplied by EZmob>/openrtb/780760269
```

Do not use the old direct VAST placement `494315103` here.
Do not use the old plain-HTTP OpenRTB URL in production. Wait for/use the HTTPS form promised by EZmob.

### Recommended

```text
EZMOB_TMAX_MS=500
EZMOB_HTTP_TIMEOUT_MS=1200
```

### Leave disabled until EZmob confirms

```text
EZMOB_BID_FLOOR_USD=
```

If EZmob later explicitly confirms that the agreed $2 CPM must be sent as the OpenRTB impression floor:

```text
EZMOB_BID_FLOOR_USD=2.00
```

Then redeploy.

## 4. Use Vercel URL first — no custom DNS required

For initial testing, the Roku app can use:

```brightscript
function AD_GatewayBaseUrl() as string
    return "https://YOUR-PROJECT.vercel.app/roku/vast"
end function
```

This requires no `raymobile.games` DNS change.

After end-to-end testing works, optionally connect the custom hostname:

```text
https://ads.raymobile.games/roku/vast
```

and change only `AD_GatewayBaseUrl()`.

## 5. Required Roku-side fixes

The current app configuration shown during debugging used escaped URL schemes such as `https\://`. That is wrong in BrightScript. Use normal URLs:

```text
https://
http://
```

Also do not send RIDA to the gateway when LAT is enabled. The gateway repeats the same privacy protection server-side, but the Roku app should avoid sending it in the first place:

```brightscript
if lmt = "0" and rida <> ""
    url = url + "&ifa=" + rida.EncodeUriComponent()
end if
url = url + "&lmt=" + lmt
```

See `roku/AdConfig_gateway_patch.brs`.

## 6. Expected Roku -> Gateway query

Example shape only (never copy a real RIDA into documentation):

```text
/roku/vast?context=startup
&ifa=<RIDA only when LAT is off>
&lmt=0
&ua=ROKU_ADS_USER_AGENT
&model=<roku model>
&osv=<roku os version>
&w=1920
&h=1080
&app_version=<version>
&bundle=872115
&cb=ROKU_ADS_CACHE_BUSTER
```

The backend does not trust the query for the client's public IP. It uses Vercel's client-IP request header and forwards that as `device.ip`.

## 7. Expected safe Vercel logs

Example:

```json
{"event":"openrtb_request","context":"startup","bundle":"872115","lmt":0,"ifa_present":true,"ip_present":true,"ua_present":true,"width":1920,"height":1080,"bidfloor_present":false}
{"event":"openrtb_response","context":"startup","status":204}
{"event":"no_bid","context":"startup","reason":"http_204"}
```

The logger intentionally records only presence booleans, never RIDA/IP values.

## 8. LAT behavior

EZmob confirmed:

- Roku RIDA normally goes in `device.ifa`.
- If LAT is enabled, RIDA should not be sent as the standard advertising ID.

Therefore:

```text
LAT off -> lmt=0 + device.ifa=<RIDA>
LAT on  -> lmt=1 + device.ifa omitted
```

## 9. VAST behavior

EZmob says VAST can be returned in `seatbid[].bid[].adm` and supports VAST 2.0, 3.0 and 4.x.

This gateway intentionally accepts only VAST 2.x / 3.x before returning markup to Roku RAF. The request advertises OpenRTB protocol values for VAST 2/3 inline and wrappers.

If EZmob returns only VAST 4.x for an auction, the gateway returns an empty VAST instead of risking Roku playback failure.

## 10. No-bid / failure behavior

All of these fail open to an empty VAST:

- OpenRTB HTTP 204
- upstream non-2xx response
- upstream timeout
- invalid JSON
- empty `seatbid`
- bid without `adm`
- VAST 4.x / unsupported markup
- gateway exception

The Roku game must continue to the menu or next gameplay state.

## 11. Important production TODOs

These are intentionally not invented in the code because EZmob has not confirmed them yet:

- Exact `$2 CPM` floor behavior.
- Exact `app-ads.txt` record.
- sellers.json seller entry.
- `schain` requirement/values.
- `nurl` / `burl` / `lurl` notice semantics.
- Whether EZmob will guarantee VAST 3-only responses.

The gateway logs only whether notice URLs are present; it does not fire unconfirmed notice URLs.

## 12. Useful reference links

Limelight / EZmob documentation:

- https://limelight.cloud.xwiki.com/xwiki/bin/view/Public/Client%20Documentation/
- https://limelight.cloud.xwiki.com/xwiki/bin/view/Public/Client%20Documentation/2.%20Frequently%20asked%20questions/
- https://limelight.cloud.xwiki.com/xwiki/bin/view/Public/Client%20Documentation/API/Combo%20Lists/

Vercel:

- https://vercel.com/docs/functions
- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/routing/rewrites
- https://vercel.com/docs/headers/request-headers
- https://vercel.com/docs/project-configuration/vercel-json

Roku:

- https://developer.roku.com/docs/developer-program/advertising/roku-advertising-framework.md
- https://developer.roku.com/docs/developer-program/advertising/ad-requirements.md

OpenRTB:

- https://iabtechlab.com/wp-content/uploads/2016/07/OpenRTB-API-Specification-Version-2-5-FINAL.pdf

## 13. First end-to-end test checklist

1. Deploy to Vercel.
2. `/health` returns HTTP 200.
3. `/roku/vast` returns an empty VAST while upstream is intentionally not configured.
4. Add the EZmob HTTPS OpenRTB endpoint to `EZMOB_OPENRTB_URL`.
5. Redeploy.
6. Put the Vercel `/roku/vast` URL in Roku `AD_GatewayBaseUrl()`.
7. Sideload on a real Roku.
8. Confirm Vercel receives one request for startup.
9. Confirm Vercel sends one OpenRTB POST to EZmob.
10. Ask EZmob to verify that endpoint/publisher 780760269 shows an Opportunity.
11. Validate a successful VAST 2/3 response through RAF.
12. Validate mission-5 separately.
13. Keep the game fail-open on no-fill/error/timeout.

