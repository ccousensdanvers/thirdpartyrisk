
# UpGuard Report Launcher (Cloudflare Worker)

A minimal Cloudflare Worker that serves a web page with buttons to request **UpGuard VendorDetailedPDF** reports for configured domains. It queues a report, short-polls status, and shows a **Download PDF** link when ready.

## Prereqs

- Node 18+
- Cloudflare Wrangler CLI
  ```bash
  npm i -D wrangler
  npx wrangler login
  ```

## Configure

Set your UpGuard API key as a Worker secret (do **not** commit it):

```bash
npx wrangler secret put UPGUARD_API_KEY
```

> UpGuard expects the `Authorization` header to be the **raw API key** (no `Bearer` prefix).

Optional: protect the app with **Cloudflare Access** and set `REQUIRE_ACCESS="1"`.

## Develop

```bash
npx wrangler dev
```

## Deploy

```bash
# Staging
npx wrangler deploy --env staging

# Production (usually on main via CI)
npx wrangler deploy --env production
```

## Domains

Edit the `DOMAINS` array in `src/index.js` to add more domains. Default is `["topsfieldma.gov"]`.

## Endpoints

- `GET /` — HTML page
- `GET /api/queue?vendor=<domain>&type=VendorDetailedPDF[&email=<addr>]` — queue a report
- `GET /api/status?id=<queued_report_id>` — check report status

## Notes

- The `download_url` returned by UpGuard is time-limited. If you need archival, extend the Worker to fetch and store to **R2** server-side.
- For production Access verification, fetch your **Access JWKS** and verify the `Cf-Access-Jwt-Assertion` using a JOSE library.
