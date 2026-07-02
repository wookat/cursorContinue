"use strict";

// ---------------------------------------------------------------------------
// LocalChannel — a minimal loopback HTTP channel that lets the patched Cursor
// workbench (official-retry-helper.js, which runs in the renderer with no fs
// access) tell the panel which agent session the *active* conversation belongs
// to. The DOM helper scans the visible conversation for the pasted
// "当前会话 ID：agent-X" line and POSTs it here; we route by ownership (the
// session dir exists under this window's state dir) and select it in the panel.
//
// This is the "本机通信通道" reintroduced after 1.0.1 removed the HTTP Bridge —
// scoped down to just active-session sync (not the old long-poll instruction
// transport, which MCP now covers). Loopback-only, tiny, best-effort: if the
// renderer CSP blocks the fetch the icon still shows the session number.
//
// Extracted from extension.js so the panel (ensureChannel) and the retry patch
// (patchBlock, which bakes {base, span, token} into the injected workbench code)
// share one source of truth for the port range + token. Zero dependency on the
// rest of the extension.
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHANNEL_PORT_BASE = 48090;
const CHANNEL_PORT_SPAN = 30;
const CHANNEL_TOKEN_KEY = "localContinue.channelToken";

// A stable per-install token so the injected helper can prove it speaks our
// protocol. Persisted in globalState so it survives restarts and matches the
// value baked into the workbench patch at install time.
function getChannelToken(context) {
  let token = context && context.globalState ? context.globalState.get(CHANNEL_TOKEN_KEY) : "";
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    if (context && context.globalState) context.globalState.update(CHANNEL_TOKEN_KEY, token);
  }
  return token;
}

class LocalChannel {
  constructor(getSessionsDir, token, onActive) {
    this.getSessionsDir = getSessionsDir; // () => absolute sessions dir for this window
    this.token = token || "";
    this.onActive = onActive || (() => {});
    this.server = null;
    this.port = 0;
  }

  isListening() { return Boolean(this.server && this.server.listening); }
  getPort() { return this.port; }

  // Bind the first free port in [BASE, BASE+SPAN). Each Cursor window gets its
  // own port; the injected helper probes the range and routes by ownership, so
  // the exact port never needs to be shared.
  start() {
    if (this.isListening()) return Promise.resolve(this.port);
    return new Promise((resolve) => {
      const tryPort = (offset) => {
        if (offset >= CHANNEL_PORT_SPAN) { resolve(0); return; }
        const port = CHANNEL_PORT_BASE + offset;
        const server = http.createServer((req, res) => this._handle(req, res));
        server.on("error", () => { try { server.close(); } catch {} tryPort(offset + 1); });
        server.listen(port, "127.0.0.1", () => {
          this.server = server;
          this.port = port;
          resolve(port);
        });
      };
      tryPort(0);
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch {} }
    this.server = null;
    this.port = 0;
  }

  _owns(agentId) {
    if (!agentId || !/^agent-[A-Za-z0-9_-]+$/.test(agentId)) return false;
    try {
      const dir = this.getSessionsDir();
      return Boolean(dir && fs.existsSync(path.join(dir, agentId)));
    } catch { return false; }
  }

  _send(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  }

  _handle(req, res) {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${this.port}`); }
    catch { this._send(res, 400, { error: "bad url" }); return; }
    // Discovery + ownership probe: the helper asks each port "is this our app,
    // and do you own agent-X?" so it can pick the right window's channel.
    if (req.method === "GET" && url.pathname === "/lca/ping") {
      const sess = url.searchParams.get("session") || "";
      this._send(res, 200, { ok: true, app: "local-continue", owns: sess ? this._owns(sess) : false });
      return;
    }
    if (req.method === "POST" && url.pathname === "/lca/active") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on("end", () => {
        let data = null;
        try { data = JSON.parse(body || "{}"); } catch { this._send(res, 400, { error: "bad json" }); return; }
        // Reject if no token is configured or the token doesn't match. The
        // `!this.token` guard is defensive: getChannelToken always produces a
        // 32-char hex value today, but if a future change ever yields an empty
        // token we fail closed (403) instead of silently disabling auth.
        if (!this.token || data.token !== this.token) { this._send(res, 403, { error: "forbidden" }); return; }
        const agentId = String(data.agentId || "");
        if (!this._owns(agentId)) { this._send(res, 200, { ok: true, matched: false }); return; }
        try { this.onActive(agentId); } catch { /* best effort */ }
        this._send(res, 200, { ok: true, matched: true });
      });
      return;
    }
    this._send(res, 404, { error: "not found" });
  }
}

module.exports = {
  CHANNEL_PORT_BASE,
  CHANNEL_PORT_SPAN,
  CHANNEL_TOKEN_KEY,
  getChannelToken,
  LocalChannel,
};
