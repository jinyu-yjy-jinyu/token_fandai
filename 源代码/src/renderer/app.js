const $ = (sel) => document.querySelector(sel);

let adapters = [];
let loggingInAdapterId = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function renderAdapters() {
  const list = $('#adapterList');
  list.innerHTML = '';
  for (const a of adapters) {
    const item = document.createElement('div');
    item.className = 'adapter-item';

    const left = document.createElement('div');
    left.className = 'adapter-left';
    const name = document.createElement('span');
    name.className = 'adapter-name';
    name.textContent = a.name;
    left.appendChild(name);

    if (a.experimental) {
      const b = document.createElement('span');
      b.className = 'badge exp';
      b.textContent = '实验性';
      left.appendChild(b);
    }
    const status = document.createElement('span');
    status.className = 'badge ' + (a.loggedIn ? 'on' : 'off');
    status.textContent = a.loggedIn ? '已登录' : '未登录';
    left.appendChild(status);
    item.appendChild(left);

    const right = document.createElement('div');
    right.className = 'adapter-right';

    if (a.loggedIn) {
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '清除';
      del.onclick = async () => {
        await window.api.clearToken(a.id);
        toast(`已清除 ${a.name} 的 token`);
        refresh();
      };
      right.appendChild(del);
    } else {
      const login = document.createElement('button');
      login.textContent = '登录';
      login.onclick = () => startLogin(a);
      right.appendChild(login);
    }

    const info = document.createElement('button');
    info.className = 'secondary';
    info.textContent = '模型';
    info.onclick = () => showModels(a);
    right.appendChild(info);

    item.appendChild(right);
    list.appendChild(item);
  }
}

function showModels(a) {
  $('#modelsModalTitle').textContent = `${a.name} · 模型列表 (${a.models.length} 个)`;
  $('#modelsModalBody').textContent = a.models.join('\n');
  $('#modelsModal').classList.remove('hidden');
}

function renderTestSite() {
  const sel = $('#testSite');
  sel.innerHTML = '';
  for (const a of adapters) {
    if (!a.loggedIn) continue;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    sel.appendChild(opt);
  }
}

async function startLogin(a) {
  $('#loginModal').classList.remove('hidden');
  $('#loginModalHint').textContent = '正在打开浏览器窗口登录，登录成功后会自动抓取 token 并关闭窗口。';
  $('#grabNowBtn').classList.remove('hidden');
  loggingInAdapterId = a.id;
  let r;
  try {
    const r = await window.api.startLogin(a.id);
    if (r && r.reused) {
      $('#loginModal').classList.add('hidden');
      loggingInAdapterId = null;
      refresh();
      return;
    }
    if (r.keepOpen) {
      $('#loginModalHint').textContent = r.message || '请在弹出的窗口内完成登录；若站点需要验证码对话，请在窗口内发一条消息完成验证，然后点击下方按钮确认抓取。';
      return;
    }
    toast(`登录成功，已自动抓取 ${a.name} 的 token`);
  } catch (e) {
    toast(`登录失败或已取消: ${e.message || '未知错误'}`);
  } finally {
    if (!r || !r.keepOpen) {
      $('#loginModal').classList.add('hidden');
      loggingInAdapterId = null;
      refresh();
    }
  }
}

function updateServerStatus(info) {
  const dot = $('#serverDot');
  const text = $('#serverText');
  if (info && info.running) {
    dot.className = 'dot on';
    text.textContent = `本地服务运行中 · 端口 ${info.port}`;
    $('#apiUrl').textContent = `http://127.0.0.1:${info.port}/v1`;
    $('#portInput').value = info.port;
  } else {
    dot.className = 'dot off';
    text.textContent = '本地服务未运行';
  }
}

async function refresh() {
  adapters = await window.api.listAdapters();
  renderAdapters();
  renderTestSite();
  const info = await window.api.getServerInfo();
  updateServerStatus(info);
  const src = adapters.length ? adapters[0].modelSource : 'static';
  $('#modelSource').textContent = src === 'online'
    ? '模型来源：在线拉取（OpenRouter 公开目录）· 每次启动自动更新'
    : '模型来源：内置默认列表（在线拉取失败时使用）';
}

async function refreshModels() {
  const btn = $('#refreshModelsBtn');
  btn.disabled = true;
  btn.textContent = '刷新中...';
  try {
    const r = await window.api.refreshModels();
    if (r.ok) {
      toast('模型列表已更新');
    } else {
      toast('刷新失败: ' + (r.message || '未知错误'));
    }
    await refresh();
  } catch (e) {
    toast('刷新失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新模型';
  }
}

async function runTest() {
  const site = $('#testSite').value;
  const msg = $('#testMessage').value.trim() || '你好';
  const btn = $('#testBtn');
  btn.disabled = true;
  btn.textContent = '发送中...';
  $('#testResult').textContent = '请求中...';
  try {
    const r = await window.api.testChat(site, msg);
    if (r.ok) {
      $('#testResult').textContent = r.content;
    } else {
      $('#testResult').textContent = '错误: ' + r.message;
    }
  } catch (e) {
    $('#testResult').textContent = '错误: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

$('#copyUrl').onclick = () => {
  navigator.clipboard.writeText($('#apiUrl').textContent);
  toast('已复制 API 地址');
};

$('#restartBtn').onclick = async () => {
  const port = parseInt($('#portInput').value, 10);
  if (!port || port < 1 || port > 65535) {
    toast('请输入有效端口 (1-65535)');
    return;
  }
  const r = await window.api.restartServer(port);
  if (r.ok) {
    toast(`服务已重启，端口 ${r.port}`);
    refresh();
  } else {
    toast('重启失败: ' + r.message);
  }
};

$('#testBtn').onclick = runTest;
$('#refreshModelsBtn').onclick = refreshModels;
$('#grabNowBtn').onclick = async () => {
  if (!loggingInAdapterId) {
    toast('没有正在进行的登录');
    return;
  }
  const a = adapters.find((x) => x.id === loggingInAdapterId);
  const btn = $('#grabNowBtn');
  btn.disabled = true;
  btn.textContent = '拉取中...';
  try {
    const r = await window.api.grabNow(loggingInAdapterId);
    if (r.ok) {
      toast(`已成功抓取 ${a ? a.name : ''} 的 token`);
      $('#loginModal').classList.add('hidden');
      loggingInAdapterId = null;
      refresh();
    } else {
      toast('未检测到登录: ' + (r.message || '请确认已登录'));
    }
  } catch (e) {
    toast('拉取失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '我已登录 · 立即拉取';
  }
};

$('#cancelLogin').onclick = () => {
  window.api.cancelLogin();
  $('#loginModal').classList.add('hidden');
  loggingInAdapterId = null;
};
$('#closeModelsModal').onclick = () => {
  $('#modelsModal').classList.add('hidden');
};
$('#modelsModal').addEventListener('click', (e) => {
  if (e.target === $('#modelsModal')) $('#modelsModal').classList.add('hidden');
});

window.api.onServerError((msg) => {
  $('#serverText').textContent = '服务错误: ' + msg;
  $('#serverDot').className = 'dot off';
  toast('服务错误: ' + msg);
});

refresh();
