const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./utils/store');

const BLOCKED_HOSTS = /(facebook|doubleclick|googletagmanager|google-analytics|fullstory|sentry|hotjar|cdnjs|fontawesome|mixpanel|segment|amplitude|branch\.io|scorecardresearch|taboola|outbrain)/i;

function findBrowser() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function unwrapStorageValue(v) {
  if (typeof v !== 'string') return v;
  try {
    const j = JSON.parse(v);
    if (j && typeof j === 'object' && 'value' in j && '__version' in j) return j.value;
    return v;
  } catch (e) { return v; }
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message || 'CDP error'));
        else resolve(data.result);
      }
    };
  }
  async send(method, params = {}, sessionId = null) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

class TokenGrabber {
  constructor(adapters) {
    this.adapters = adapters;
    this.browserProc = null;
    this.cdp = null;
    this.port = null;
    this.external = false;
    this.userDataDir = path.join(os.homedir(), '.fandai-chrome-profile');
  }

  async ensureBrowser() {
    if (this.cdp) return;
    for (let p = 9222; p <= 9230; p++) {
      try {
        const info = await httpGetJson(`http://127.0.0.1:${p}/json/version`);
        if (info && info.webSocketDebuggerUrl) {
          this.port = p;
          this.external = true;?
          this.cdp = new CdpClient(info.webSocketDebuggerUrl);
          await this.cdp.ready;
          return;
        }
      } catch (e) {}
    }
    const exe = findBrowser();
    if (!exe) throw new Error('未找到 Chrome/Edge 浏览器');
    this.port = 9222;
    try { fs.mkdirSync(this.userDataDir, { recursive: true }); } catch (e) {}
    this.browserProc = spawn(exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: false, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        const info = await httpGetJson(`http://127.0.0.1:${this.port}/json/version`);
        if (info && info.webSocketDebuggerUrl) {
          this.external = false;
          this.cdp = new CdpClient(info.webSocketDebuggerUrl);
          await this.cdp.ready;
          return;
        }
      } catch (e) {}
      await sleep(200);
    }
    throw new Error('启动浏览器调试端口超时');
  }

  async createTab(url) {
    const target = await this.cdp.send('Target.createTarget', { url });
    const attach = await this.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attach.sessionId;
    await this.cdp.send('Network.enable', {}, sessionId);
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    return { targetId: target.targetId, sessionId };
  }

  async closeTab(targetId) {
    try { await this.cdp.send('Target.closeTarget', { targetId }); } catch (e) {}
  }

  async extractFromTab(sessionId, adapter) {
    const result = {};
    try {
      const lsKeys = adapter.localStorageKeys || [];
      const expr = `(() => { const keys = ${JSON.stringify(lsKeys)}; const o = {}; for (const k of keys) { o[k] = localStorage.getItem(k); } return o; })()`;
      const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      const ls = (r && r.result && r.result.value) || {};
      for (const k of Object.keys(ls)) result[k] = unwrapStorageValue(ls[k]);
    } catch (e) {}

    const host = (() => {
      try { return new URL(adapter.cookieUrl).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    })();
    try {
      const cr = await this.cdp.send('Network.getAllCookies', {}, sessionId);
      const cookies = (cr && cr.cookies) || [];
      const relevant = cookies.filter((c) => {
        const d = String(c.domain || '').replace(/^\./, '');
        return host && (d === host || d.endsWith('.' + host) || host.endsWith(d));
      });
      const allCookies = {};
      for (const c of relevant) allCookies[c.name] = c.value;
      result.__allCookies = allCookies;
      for (const name of adapter.cookieKeys || []) {
        if (allCookies[name] !== undefined) result[`cookie:${name}`] = allCookies[name];
      }
    } catch (e) {}

    if (adapter.id === 'deepseek' || (adapter.extraExtract)) {
      try {
        const didExpr = `(localStorage.getItem('__ds_remote_feature_did') || '')`;
        const dr = await this.cdp.send('Runtime.evaluate', { expression: didExpr, returnByValue: true }, sessionId);
        const did = dr && dr.result && dr.result.value;
        if (did) result.__did = did;
      } catch (e) {}
    }
    return result;
  }

  async grab(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`未知站点: ${adapterId}`);

    const tokens = store.getTokens();
    const existing = tokens && tokens[adapterId];
    if (existing && typeof adapter.isTokenValid === 'function' && adapter.isTokenValid(existing)) {
      return existing;
    }

    await this.ensureBrowser();

    const keepOpen = !!adapter.keepWindowOpen;

    return new Promise((resolve, reject) => {
      let captured = false;
      let tab = null;
      let pollTimer = null;

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (tab && !keepOpen) this.closeTab(tab.targetId).catch(() => {});
        tab = null;
      };

      const done = (err, tokens) => {
        if (captured) return;
        captured = true;
        cleanup();
        if (err) reject(err);
        else resolve(tokens);
      };

      this.createTab(adapter.loginUrl).then((t) => {
        tab = t;
        pollTimer = setInterval(async () => {
          try {
            const tokens = await this.extractFromTab(t.sessionId, adapter);
            if (tokens && adapter.isTokenValid(tokens)) {
              if (keepOpen) {
                // keep tab open; resolve only via grabNow
              } else {
                done(null, tokens);
              }
            }
          } catch (e) {}
        }, 2000);
      }).catch((e) => done(e));

      // For keepOpen, wait until grabNow or external close; here we just keep promise pending.
      if (keepOpen) {
        // Store resolver to be called by grabNow
        this._pendingResolve = (tokens) => done(null, tokens);
        this._pendingReject = (err) => done(err);
        this._pendingTab = () => tab;
      }
    });
  }

  async grabNow(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`未知站点: ${adapterId}`);

    const tokens = store.getTokens();
    const existing = tokens && tokens[adapterId];
    if (existing && typeof adapter.isTokenValid === 'function' && adapter.isTokenValid(existing)) {
      return { ok: true, tokens: existing, confirmed: true };
    }

    if (!this.cdp) throw new Error('浏览器未启动');
    // find an attached tab by creating? We need track tab. Use last created tab target.
    // We'll search targets for a page with adapter login url.
    const targets = await this.cdp.send('Target.getTargets');
    const page = (targets.targetInfos || []).find((t) => t.type === 'page' && t.url && t.url.includes(new URL(adapter.loginUrl).hostname));
    if (!page) throw new Error('没有正在打开的登录页面');
    const attach = await this.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = attach.sessionId;
    await this.cdp.send('Network.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    const tokens = await this.extractFromTab(sessionId, adapter);
    if (adapter.isTokenValid(tokens)) {
      await this.closeTab(page.targetId);
      return { ok: true, tokens, confirmed: true };
    }
    return { ok: false, message: '尚未检测到登录状态，请确认已登录后重试' };
  }

  close() {
    if (this.browserProc) {
      try { this.browserProc.kill(); } catch (e) {}
      this.browserProc = null;
    }
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
  }

  async clearSiteSession(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter || !this.cdp) return;
    try {
      const targets = await this.cdp.send('Target.getTargets');
      const host = new URL(adapter.cookieUrl).hostname;
      for (const t of targets.targetInfos || []) {
        if (t.type !== 'page') continue;
        if (!String(t.url || '').includes(host)) continue;
        const attach = await this.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const sessionId = attach.sessionId;
        await this.cdp.send('Network.enable', {}, sessionId);
        const cr = await this.cdp.send('Network.getAllCookies', {}, sessionId);
        for (const c of cr.cookies || []) {
          if (String(c.domain || '').includes(host)) {
            await this.cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }, sessionId).catch(() => {});
          }
        }
      }
    } catch (e) {}
  }
}

module.exports = TokenGrabber;

