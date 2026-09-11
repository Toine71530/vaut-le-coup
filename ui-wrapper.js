import http from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const BACKEND_PORT = 10002;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const child = spawn(process.execPath, ["market-wrapper.js"], {
  env: { ...process.env, PORT: String(BACKEND_PORT) },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) process.exit(code);
  if (signal) process.exit(1);
});

const UI_CSS = `
<style id="vaut-le-coup-ui-fix">
.previews {
  display: grid !important;
  grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  gap: 10px !important;
  width: 100% !important;
  flex-wrap: nowrap !important;
}
.thumb {
  width: 100% !important;
  min-width: 0 !important;
  height: auto !important;
  aspect-ratio: 1 / 1 !important;
}
.thumb img {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
}
.progress-wrap {
  margin-top: 16px;
}
.progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 16px;
  font-weight: 700;
}
.progress-track {
  width: 100%;
  height: 14px;
  border-radius: 999px;
  background: #e4e8ec;
  overflow: hidden;
  box-shadow: inset 0 1px 2px #00000012;
}
.progress-fill {
  width: 0%;
  height: 100%;
  border-radius: inherit;
  background: #2f80ed;
  transition: width .55s ease, background-color .45s ease;
}
.progress-percent {
  min-width: 42px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 380px) {
  .previews { gap: 7px !important; }
}
</style>`;

const UI_JS = `<script id="vaut-le-coup-ui-fix-js">
(() => {
  const market = document.getElementById("market");
  if (!market) return;

  let lastState = "";
  let progressTimer = null;
  let progress = 0;

  function ensureProgress() {
    let wrap = market.querySelector(".progress-wrap");
    if (wrap) return wrap;

    wrap = document.createElement("div");
    wrap.className = "progress-wrap";
    wrap.innerHTML = `
      <div class="progress-head">
        <span class="progress-label">Préparation de l’analyse…</span>
        <span class="progress-percent">0 %</span>
      </div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="progress-fill"></div>
      </div>`;

    const status = market.querySelector(".status");
    if (status) status.appendChild(wrap);
    else market.prepend(wrap);
    return wrap;
  }

  function setProgress(value, label, color) {
    progress = Math.max(progress, value);
    const wrap = ensureProgress();
    const fill = wrap.querySelector(".progress-fill");
    const pct = wrap.querySelector(".progress-percent");
    const text = wrap.querySelector(".progress-label");
    const track = wrap.querySelector(".progress-track");
    fill.style.width = progress + "%";
    fill.style.backgroundColor = color;
    pct.textContent = progress + " %";
    text.textContent = label;
    track.setAttribute("aria-valuenow", String(progress));
  }

  function startSoftAdvance(target) {
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (progress >= target) {
        clearInterval(progressTimer);
        return;
      }
      setProgress(Math.min(target, progress + 1),
        progress < 55 ? "Analyse et extraction des informations…" : "Recherche et comparaison du marché…",
        progress < 60 ? "#2f80ed" : "#f59e0b");
    }, 350);
  }

  function inspect() {
    const text = market.textContent || "";
    let state = "";
    if (text.includes("Analyse des photos")) state = "ai";
    else if (text.includes("Recherche des comparables")) state = "market";
    else if (market.querySelector(".status") && market.querySelector(".price")) state = "done";
    else return;

    if (state === lastState) return;
    lastState = state;

    if (state === "ai") {
      progress = 0;
      setProgress(8, "Analyse des photos…", "#2f80ed");
      startSoftAdvance(55);
    } else if (state === "market") {
      clearInterval(progressTimer);
      setProgress(60, "Recherche des comparables…", "#f59e0b");
      startSoftAdvance(92);
    } else if (state === "done") {
      clearInterval(progressTimer);
      progress = 100;
      setProgress(100, "Analyse terminée", "#22a06b");
    }
  }

  const observer = new MutationObserver(inspect);
  observer.observe(market, { childList: true, subtree: true, characterData: true });
  inspect();
})();
</script>`;

function enhanceHtml(html) {
  let out = String(html);
  out = out.replace("</head>", UI_CSS + "</head>");
  out = out.replace("</body>", UI_JS + "</body>");
  return out;
}

function waitForBackend() {
  return new Promise((resolve) => {
    const tryIt = () => {
      const req = http.get(`${BACKEND_URL}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(tryIt, 150));
      req.setTimeout(1500, () => {
        req.destroy();
      });
    };
    tryIt();
  });
}

function proxy(req, res) {
  const options = {
    hostname: "127.0.0.1",
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` }
  };

  const upstream = http.request(options, (upstreamRes) => {
    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const body = Buffer.concat(chunks);
      const contentType = String(upstreamRes.headers["content-type"] || "");
      if (req.method === "GET" && req.url === "/" && contentType.includes("text/html")) {
        const html = enhanceHtml(body.toString("utf8"));
        const headers = { ...upstreamRes.headers, "content-length": Buffer.byteLength(html) };
        delete headers["content-encoding"];
        res.writeHead(upstreamRes.statusCode || 200, headers);
        res.end(html);
      } else {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        res.end(body);
      }
    });
  });

  upstream.on("error", (err) => {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Backend indisponible: ${err.message}`);
  });

  req.pipe(upstream);
}

await waitForBackend();

const server = http.createServer((req, res) => proxy(req, res));
server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`UI wrapper listening on ${PUBLIC_PORT}`);
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  child.kill("SIGINT");
  server.close(() => process.exit(0));
});
