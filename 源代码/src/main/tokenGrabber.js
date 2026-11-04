const { BrowserWindow, session } = require('electron');
const store = require('./utils/store');

const BLOCKED_HOSTS = /(facebook|doubleclick|googletagmanager|google-analytics|fullstory|sentry|hotjar|cdnjs|fontawesome|mixpanel|segment|amplitude|branch\.io|scorecardresearch|taboola|outbrain|bing\.com|adservice)/i;

class TokenGrabber {
  constructor(adapters) {
    this.adapters = adapters;
    this.window = null;
    this.sessionName = 'fandai-session';
    this.ses = session.fromPartition(`persist:${this.sessionName}`);
    this.installRequestBlocker();
  }

  installRequestBlocker() {
    try {
      this.ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        try {
          const url = new URL(details.url);
          if (BLOCKED_HOSTS.test(url.host)) return cb({ cancel: true });
        } catch (e) {}
        cb({});
      });
    } catch (e) {}
  }

  async grab(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`未知站点: ${adapterId}`);

    if (this.window) {
      this.window.destroy();
      this.window = null;
    }

    const keepOpen = !!adapter.keepWindowOpen;

    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: `登录 ${adapter.name}`,
        webPreferences: {
          partition: `persist:${this.sessionName}`,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      this.window = win;
      this.currentAdapterId = adapterId;
      this.pendingTokens = null;
      win.setMenuBarVisibility(false);

      let captured = false;
      let notified = false;
      const done = (err, tokens, keep) => {
        if (captured) return;
        captured = true;
        clearInterval(pollTimer);
        if (!keep || !win.isDestroyed()) win.destroy();
        this.window = null;
        this.currentAdapterId = null;
        if (err) reject(err);
        else resolve(tokens);
      };

      const pollTimer = setInterval(async () => {
        try {
          const tokens = await this.extractFromPage(win, adapter);
          if (tokens && adapter.isTokenValid(tokens)) {
            this.pendingTokens = tokens;
            if (keepOpen) {
              if (!notified) {
                notified = true;
                win.webContents.send('login:tokenReady', adapterId);
              }
            } else {
              done(null, tokens);
            }
          }
        } catch (e) {
          // ignore polling errors
        }
      }, 1500);

      win.on('closed', () => {
        clearInterval(pollTimer);
        this.window = null;
        this.currentAdapterId = null;
        if (!captured) done(new Error('登录窗口已关闭，未获取到 token'));
      });

      win.loadURL(adapter.loginUrl).catch((e) => {
        // page might redirect; just keep polling
      });
    });
  }

  async grabNow(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter || !this.window || this.window.isDestroyed()) {
      throw new Error('没有正在打开的登录窗口');
    }
    try {
      const tokens = await this.extractFromPage(this.window, adapter);
      if (adapter.isTokenValid(tokens)) {
        // 确认成功后关闭窗口并返回
        const keep = false;
        if (!this.window.isDestroyed()) this.window.destroy();
        this.window = null;
        this.currentAdapterId = null;
        this.pendingTokens = null;
        return { ok: true, tokens, confirmed: true };
      }
      return { ok: false, message: '尚未检测到登录状态，请确认已登录后重试' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  async extractFromPage(win, adapter) {
    const result = {};
    try {
      const ls = await win.webContents.executeJavaScript(
        `(() => { const keys = ${JSON.stringify(adapter.localStorageKeys || [])}; const o = {}; for (const k of keys) { o[k] = localStorage.getItem(k); } return o; })()`,
        true
      );
      for (const k of Object.keys(ls)) {
        result[k] = this.unwrapStorageValue(ls[k]);
      }
    } catch (e) {}

    try {
      const cookieStrs = await win.webContents.session.cookies.get({ url: adapter.cookieUrl });
      for (const c of cookieStrs) {
        if ((adapter.cookieKeys || []).includes(c.name)) {
          result[`cookie:${c.name}`] = c.value;
        }
      }
      const allCookies = {};
      for (const c of cookieStrs) allCookies[c.name] = c.value;
      result.__allCookies = allCookies;
    } catch (e) {}

    if (adapter.extraExtract) {
      try {
        const extra = await adapter.extraExtract(win.webContents);
        Object.assign(result, extra);
      } catch (e) {}
    }
    return result;
  }

  unwrapStorageValue(v) {
    if (typeof v !== 'string') return v;
    try {
      const j = JSON.parse(v);
      if (j && typeof j === 'object' && 'value' in j && ('__version' in j)) {
        return j.value;
      }
      return v;
    } catch (e) {
      return v;
    }
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  async clearSiteSession(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;
    try {
      if (this.window && !this.window.isDestroyed()) {
        try {
          await this.window.webContents.executeJavaScript(
            `(function(){ try{ var ks=${JSON.stringify(adapter.localStorageKeys || [])}; for(var k of ks){ localStorage.removeItem(k); } }catch(e){} })()`,
            true
          );
        } catch (e) {}
      }
      try {
        const cookies = await this.ses.cookies.get({ url: adapter.cookieUrl });
        for (const c of cookies) {
          await this.ses.cookies.remove(adapter.cookieUrl, c.name).catch(() => {});
        }
      } catch (e) {}
      try {
        await this.ses.clearStorageData({ origin: adapter.cookieUrl, storages: ['localstorage', 'sessionstorage'] });
      } catch (e) {}
    } catch (e) {}
  }
}

module.exports = TokenGrabber;
