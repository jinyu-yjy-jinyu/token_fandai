const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const LocalServer = require('./server');
const TokenGrabber = require('./tokenGrabber');
const adapters = require('./adapters');
const store = require('./utils/store');
const catalog = require('./modelCatalog');

let mainWindow = null;
let server = null;
let grabber = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    title: '反代token',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startServer(port) {
  if (server) await server.stop();
  server = new LocalServer();
  if (port) server.setPort(port);
  await server.start();
  return server.port;
}

app.whenReady().then(async () => {
  store.init(app.getPath('userData'));
  catalog.init(app.getPath('userData'));
  grabber = new TokenGrabber(adapters);
  createWindow();

  try {
    await startServer(8349);
  } catch (e) {
    mainWindow.webContents.send('server:error', e.message);
  }

  try {
    await catalog.refresh();
  } catch (e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (grabber) grabber.close();
  if (server) server.stop();
});

ipcMain.handle('adapters:list', async () => {
  const tokens = store.getTokens();
  const list = [];
  for (const a of adapters.list()) {
    let models = a.models;
    let modelSource = 'static';
    let dyn = null;
    let loggedIn = !!(tokens[a.id] && a.isTokenValid(tokens[a.id]));
    if (tokens[a.id] && typeof a.checkToken === 'function' && loggedIn) {
      try {
        loggedIn = await a.checkToken(tokens[a.id]);
      } catch (e) {}
    }
    if (loggedIn && typeof a.fetchModels === 'function') {
      try {
        dyn = await a.fetchModels(tokens[a.id]);
        if (dyn && dyn.length) {
          models = dyn;
          modelSource = 'online';
        }
      } catch (e) {}
    }
    if (!dyn || !dyn.length) {
      const catModels = catalog.getModels(a.id);
      if (catModels && catModels.length) {
        models = catModels;
        modelSource = catalog.getSource();
      }
    }
    list.push({
      id: a.id,
      name: a.name,
      models,
      defaultModel: a.defaultModel,
      experimental: !!a.experimental,
      loginUrl: a.loginUrl,
      loggedIn,
      modelSource,
    });
  }
  return list;
});

ipcMain.handle('models:refresh', async () => {
  try {
    await catalog.refresh();
    return { ok: true, source: catalog.getSource() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('login:start', async (e, adapterId) => {
  const adapter = adapters.get(adapterId);
  const tokens = store.getTokens();
  const existing = tokens && tokens[adapterId];
  if (existing && typeof adapter.isTokenValid === 'function' && adapter.isTokenValid(existing)) {
    return { ok: true, reused: true };
  }
  const keepOpen = !!(adapter && adapter.keepWindowOpen);
  if (keepOpen) {
    grabber.grab(adapterId).catch(() => {});
    return { ok: true, keepOpen: true, message: '正在打开默认浏览器，请登录后重试；若抓到 token 且需要完成网页验证码对话，完成后点击【我已登录 · 立即拉取】确认' };
  }
  tokens = await grabber.grab(adapterId);
  store.setToken(adapterId, tokens);
  return {
    ok: true,
    tokens: Object.keys(tokens)
      .filter((k) => !k.startsWith('__'))
      .reduce((o, k) => ((o[k] = tokens[k]), o), {}),
  };
});

ipcMain.handle('login:grabNow', async (e, adapterId) => {
  const r = await grabber.grabNow(adapterId);
  if (r.ok) {
    store.setToken(adapterId, r.tokens);
  }
  return r;
});

ipcMain.handle('login:cancel', () => {
  if (grabber) grabber.close();
  return { ok: true };
});

ipcMain.handle('token:set', (e, adapterId, token) => {
  store.setToken(adapterId, token);
  return { ok: true };
});

ipcMain.handle('token:clear', async (e, adapterId) => {
  store.removeToken(adapterId);
  if (grabber) {
    await grabber.clearSiteSession(adapterId);
  }
  return { ok: true };
});

ipcMain.handle('server:getInfo', async () => {
  return {
    port: server ? server.port : 0,
    running: !!(server && server.server),
  };
});

ipcMain.handle('server:restart', async (e, port) => {
  try {
    await startServer(port);
    return { ok: true, port: server.port };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('test:chat', async (e, adapterId, message) => {
  const adapter = adapters.get(adapterId);
  const tokens = store.getTokens();
  const token = tokens[adapterId];
  if (!token || !adapter.isTokenValid(token)) {
    return { ok: false, message: '未登录或 token 失效' };
  }
  try {
    const chunks = [];
    if (adapter.customChat && typeof adapter.chat === 'function') {
      await adapter.chat(token, adapter.defaultModel, [{ role: 'user', content: message }], {}, (ev) => {
        if (ev && ev.done) return;
        if (ev && ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content) {
          chunks.push(ev.choices[0].delta.content);
        }
      });
      return { ok: true, content: chunks.join('') };
    }
    const { request } = require('./utils/httpClient');
    const headers = adapter.buildHeaders(token);
    const body = adapter.buildBody(adapter.defaultModel, [{ role: 'user', content: message }], {});
    const res = await request({ url: adapter.apiUrl, method: 'POST', headers }, JSON.stringify(body), (c) => chunks.push(c));
    if (res.statusCode >= 400) {
      return { ok: false, message: `上游返回 ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}` };
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let reply = server.aggregateRaw(raw, adapter, adapter.defaultModel);
    return { ok: true, content: reply.choices[0].message.content };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('open:external', (e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, message: 'invalid url' };
  }
  shell.openExternal(url);
  return { ok: true };
});

