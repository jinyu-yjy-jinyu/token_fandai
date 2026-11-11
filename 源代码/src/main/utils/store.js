const fs = require('fs');
const path = require('path');

let storePath = null;
let cache = null; // 内存缓存，避免每次读磁盘

function init(userDataDir) {
  storePath = path.join(userDataDir, 'tokens.json');
  cache = null; // 重置缓存，下次 getTokens 会重新读盘
}

function read() {
  if (cache) return cache;
  try {
    if (!storePath) return {};
    cache = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return cache;
  } catch (e) {
    return {};
  }
}

function write(data) {
  cache = data; // 更新内存缓存
  try {
    if (!storePath) return;
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

function unwrapValue(v) {
  if (typeof v !== 'string') return v;
  try {
    const j = JSON.parse(v);
    if (j && typeof j === 'object' && 'value' in j && '__version' in j) {
      return j.value;
    }
    return v;
  } catch (e) {
    return v;
  }
}

function getTokens() {
  const d = read();
  const out = {};
  const raw = d.tokens || {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (v && typeof v === 'object') {
      out[k] = {};
      for (const kk of Object.keys(v)) {
        out[k][kk] = unwrapValue(v[kk]);
      }
    } else {
      out[k] = unwrapValue(v);
    }
  }
  return out;
}

function setToken(siteId, token) {
  const d = read();
  d.tokens = d.tokens || {};
  d.tokens[siteId] = token;
  d.updatedAt = Date.now();
  write(d);
}

function removeToken(siteId) {
  const d = read();
  if (d.tokens && d.tokens[siteId]) {
    delete d.tokens[siteId];
    write(d);
  }
}

module.exports = { init, getTokens, setToken, removeToken };
