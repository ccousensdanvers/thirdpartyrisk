
// src/index.js
// Cloudflare Worker serving a minimal page with buttons that queue UpGuard reports
// Endpoints:
//   GET /                 - HTML UI
//   GET /api/queue        - queue a VendorDetailedPDF for ?vendor=... (&email=optional)
//   GET /api/status?id=.. - check report status
//
// Secrets (set via `wrangler secret put`):
//   UPGUARD_API_KEY
//
// Vars (set in wrangler.toml):
//   REQUIRE_ACCESS = "0" | "1"   // when "1", require Cf-Access-Jwt-Assertion on /api/*

const DOMAINS = ["topsfieldma.gov"]; // Add more domains here later

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Simple router
    if (url.pathname === "/") return renderPage();

    // Optional Cloudflare Access gate on API routes
    if (url.pathname.startsWith("/api/") && env.REQUIRE_ACCESS === "1") {
      const token = req.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return new Response("Unauthorized", { status: 401 });
      // TODO: For production, verify JWT against your Access JWKS.
    }

    if (url.pathname === "/api/queue" && req.method === "GET") {
      const vendor = url.searchParams.get("vendor") || "topsfieldma.gov";
      const type = url.searchParams.get("type") || "VendorDetailedPDF";
      const email = url.searchParams.get("email") || "";

      // Queue report with UpGuard
      const qp = new URLSearchParams({ report_type: type, vendor_primary_hostname: vendor });
      if (email) qp.set("email_addresses", email);

      const queueRes = await fetch(`https://cyber-risk.upguard.com/api/public/reports/queue?${qp}`, {
        method: "GET",
        headers: { Authorization: env.UPGUARD_API_KEY },
      });

      if (!queueRes.ok) {
        const body = await queueRes.text();
        return json({ error: "queue_failed", status: queueRes.status, body }, 502);
      }

      const { queued_report_id } = await queueRes.json();

      // Short-poll UpGuard for ~25s to see if it's already ready
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const statusRes = await fetch(
          `https://cyber-risk.upguard.com/api/public/reports/status?queued_report_id=${encodeURIComponent(queued_report_id)}`,
          { headers: { Authorization: env.UPGUARD_API_KEY } }
        );
        if (!statusRes.ok) break;
        const statusBody = await statusRes.json();
        if (statusBody.status === "completed" && statusBody.download_url) {
          return json({ queued_report_id, status: "completed", download_url: statusBody.download_url });
        }
        await sleep(2000);
      }

      return json({ queued_report_id, status: "pending" }, 202);
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);

      const r = await fetch(
        `https://cyber-risk.upguard.com/api/public/reports/status?queued_report_id=${encodeURIComponent(id)}`,
        { headers: { Authorization: env.UPGUARD_API_KEY } }
      );

      const bodyText = await r.text();
      return new Response(bodyText, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("Content-Type") || "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>UpGuard Report Launcher</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 2rem; display: grid; gap: 1.25rem; }
    h1 { margin: 0; font-size: 1.25rem; }
    .card { max-width: 760px; border: 1px solid #cbd5e1; border-radius: 14px; padding: 1rem 1.25rem; }
    .row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .5rem 0 1rem; }
    .chip { display: inline-block; padding: .35rem .6rem; border-radius: 999px; background: #eef2f7; color: #111827; }
    button { padding: .6rem .9rem; border-radius: 10px; border: 0; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .status { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
    label,input { font-size: .9rem; }
    input[type="email"] { padding: .45rem .6rem; border-radius: 8px; border: 1px solid #cbd5e1; min-width: 260px; }
    @media (prefers-color-scheme: dark) {
      .card { border-color: #4b5563; }
      .chip { background: #1f2937; color: #e5e7eb; }
      input[type="email"] { border-color: #4b5563; background: #0b0f16; color: #e5e7eb; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>UpGuard Report Launcher</h1>
    <p>Click a button to generate a <strong>Vendor Detailed PDF</strong> for the domain.</p>

    <div class="row">
      <label for="email">Optional email delivery:&nbsp;</label>
      <input id="email" type="email" placeholder="name@danversma.gov" />
    </div>

    <div id="buttons"></div>
    <div id="out" class="status"></div>
  </div>

  <script>
    const DOMAINS = ["topsfieldma.gov"];

    const buttonsDiv = document.getElementById('buttons');
    const out = document.getElementById('out');

    DOMAINS.forEach(domain => {
      const row = document.createElement('div'); row.className = 'row';
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = domain;
      const btn = document.createElement('button'); btn.textContent = 'Request Detailed Report';
      btn.onclick = () => launch(domain, btn);
      row.append(chip, btn); buttonsDiv.append(row);
    });

    async function launch(domain, btn) {
      const email = document.getElementById('email').value.trim();
      btn.disabled = true; out.textContent = 'Queuing report for ' + domain + '...';
      try {
        const qs = new URLSearchParams({ vendor: domain, type: 'VendorDetailedPDF' });
        if (email) qs.set('email', email);
        const res = await fetch('/api/queue?' + qs.toString());
        const data = await res.json();

        if (data.status === 'completed' && data.download_url) {
          out.innerHTML = 'Report ready for <strong>' + domain + '</strong>: ' +
                          '<a href="' + data.download_url + '" target="_blank" rel="noopener">Download PDF</a>';
          btn.disabled = false; return;
        }

        const id = data.queued_report_id;
        out.textContent = 'Queued (id=' + id + '). Waiting for completion...';
        const start = Date.now();
        const timer = setInterval(async () => {
          const r = await fetch('/api/status?id=' + encodeURIComponent(id));
          const body = await r.json();
          if (body.status === 'completed' && body.download_url) {
            clearInterval(timer);
            out.innerHTML = 'Report ready for <strong>' + domain + '</strong>: ' +
                            '<a href="' + body.download_url + '" target="_blank" rel="noopener">Download PDF</a>';
            btn.disabled = false;
          } else {
            const secs = Math.floor((Date.now() - start) / 1000);
            out.textContent = 'Still building for ' + domain + '... (' + secs + 's)';
          }
        }, 2000);
      } catch (e) {
        out.textContent = 'Error: ' + (e && e.message ? e.message : e);
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

