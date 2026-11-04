const { openaiChunk, openaiDone, buildNonStreamed } = require('../utils/openai');
const { buildPowHeader } = require('./deepseekPow');
const { request } = require('../utils/httpClient');
const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek',
  loginUrl: 'https://chat.deepseek.com/',
  cookieUrl: 'https://chat.deepseek.com/',
  localStorageKeys: ['userToken'],
  cookieKeys: [],
  models: ['deepseek-chat', 'deepseek-reasoner'],
  defaultModel: 'deepseek-chat',
  catalogFilter: ['deepseek/deepseek-'],
  experimental: false,
  customChat: true,
  async extraExtract(wc) {
    try {
      const did = await wc.executeJavaScript(
        `(localStorage.getItem('__ds_remote_feature_did') || '')`,
        true
      );
      return did ? { __did: did } : {};
    } catch (e) {
      return {};
    }
  },

  isTokenValid(t) {
    const v = t['userToken'];
    if (!v || typeof v !== 'string') return false;
    if (v === 'null' || v === 'undefined' || v === '') return false;
    if (v.startsWith('{')) {
      try {
        const j = JSON.parse(v);
        if (j && j.value === null) return false;
      } catch (e) {
        return false;
      }
    }
    return true;
  },

  baseHeaders(t) {
    return {
      Authorization: `Bearer ${t['userToken']}`,
      'Content-Type': 'application/json',
      Origin: 'https://chat.deepseek.com',
      Referer: 'https://chat.deepseek.com/',
      'User-Agent': UA,
      'x-app-version': '20250129.0',
      'X-Request-Id': crypto.randomUUID(),
    };
  },

  async fetchModels(tokens) {
    if (!tokens || !tokens['userToken']) return null;
    const did = tokens.__did || '';
    try {
      const url = 'https://chat.deepseek.com/api/v0/client/settings' + (did ? `?did=${encodeURIComponent(did)}&scope=model` : '');
      const res = await request({
        url,
        method: 'GET',
        headers: this.baseHeaders(tokens),
      });
      if (res.statusCode !== 200) return null;
      const j = JSON.parse(res.body.toString('utf8'));
      const settings = j.data && j.data.biz_data && j.data.biz_data.settings;
      if (!Array.isArray(settings)) return null;
      const models = [];
      for (const s of settings) {
        if (s && s.key === 'model_configs' && Array.isArray(s.value)) {
          for (const m of s.value) {
            if (m && m.model_type && m.enabled !== false) models.push(m.model_type);
          }
        }
      }
      return models.length ? models : null;
    } catch (e) {
      return null;
    }
  },

  async buildChatRequest(tokens, model, messages, opts) {
    const headers = this.baseHeaders(tokens);

    const sessionRes = await request({
      url: 'https://chat.deepseek.com/api/v0/chat_session/create',
      method: 'POST',
      headers,
    }, JSON.stringify({}));
    if (sessionRes.statusCode !== 200) {
      throw new Error(`创建会话失败: HTTP ${sessionRes.statusCode}`);
    }
    const sJ = JSON.parse(sessionRes.body.toString('utf8'));
    const sbd = sJ.data && sJ.data.biz_data;
    const chatSessionId = sbd ? (sbd.chat_session && sbd.chat_session.id) || sbd.id || null : null;
    if (!chatSessionId) {
      throw new Error('创建会话失败: 未返回会话 ID');
    }

    const challengeRes = await request({
      url: 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge',
      method: 'POST',
      headers,
    }, JSON.stringify({ target_path: '/api/v0/chat/completion' }));
    if (challengeRes.statusCode !== 200) {
      throw new Error(`获取 PoW 挑战失败: HTTP ${challengeRes.statusCode}`);
    }
    const cJ = JSON.parse(challengeRes.body.toString('utf8'));
    const challenge = cJ.data && cJ.data.biz_data && cJ.data.biz_data.challenge;
    if (!challenge) {
      throw new Error('获取 PoW 挑战失败: ' + (cJ.msg || cJ.data && cJ.data.biz_msg || '未知错误'));
    }
    challenge.expireAt = challenge.expire_at;
    challenge.expireAfter = challenge.expire_after;

    const { name, value } = await buildPowHeader(challenge, '/api/v0/chat/completion');
    headers[name] = value;

    const modelType = 'default';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const body = {
      chat_session_id: chatSessionId,
      parent_message_id: null,
      model_type: modelType,
      prompt: lastUser ? lastUser.content : '',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    };

    return {
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      method: 'POST',
      headers,
      body,
    };
  },

  parseSSELine(line, state) {
    if (!line || !line.startsWith('event:')) return null;
    const event = line.slice(6).trim();
    return { event };
  },

  parseDelta(delta) {
    const ops = [];
    const walk = (op, prefix) => {
      if (!op) return;
      if (op.o === 'BATCH' && Array.isArray(op.v)) {
        for (const sub of op.v) walk(sub, op.p ? op.p : prefix);
        return;
      }
      ops.push({ op: op.o, path: prefix ? `${prefix}${op.p || ''}` : op.p, value: op.v });
    };
    walk(delta, '');
    return ops;
  },

  applyDelta(state, delta) {
    const hasP = delta && typeof delta.p === 'string';
    const hasO = delta && typeof delta.o === 'string';
    const hasV = delta && 'v' in delta;

    if (hasP) state.curPath = delta.p;
    if (hasO) state.curOp = delta.o;
    if (!state.curOp) state.curOp = 'SET';

    if (!hasV) return;

    const path = state.curPath || '';
    const parts = path.split('/').filter(Boolean);
    const value = delta.v;

    let responseObj = value;
    if (value && typeof value === 'object' && value.response && typeof value.response === 'object') {
      responseObj = value.response;
    }

    if (responseObj && typeof responseObj === 'object' && 'message_id' in responseObj) {
      state.msg = Object.assign({}, state.msg, responseObj);
      if (typeof responseObj.content === 'string') state.msg.content = responseObj.content;
      if (typeof responseObj.thinking_content === 'string') state.msg.thinking_content = responseObj.thinking_content;
      return;
    }

    if (parts[0] === 'response' && parts[1] === 'content') {
      if (state.curOp === 'APPEND') state.msg.content = (state.msg.content || '') + String(value);
      else state.msg.content = String(value);
      return;
    }

    if (parts[0] === 'response' && parts[1] === 'thinking_content') {
      if (state.curOp === 'APPEND') state.msg.thinking_content = (state.msg.thinking_content || '') + String(value);
      else state.msg.thinking_content = String(value);
      return;
    }

    if (parts[0] === 'response' && parts[1] === 'status') {
      state.msg.status = String(value);
      return;
    }
  },

  extractText(msg) {
    return {
      content: msg.content || '',
      reasoning: msg.thinking_content || '',
    };
  },

  async chat(tokens, model, messages, opts, emit) {
    let url, method, headers, body;
    try {
      const req = await this.buildChatRequest(tokens, model, messages, opts);
      url = req.url;
      method = req.method;
      headers = req.headers;
      body = req.body;
    } catch (e) {
      emit(openaiChunk({ model, delta: { content: `[错误] ${e.message}` }, finish: 'stop' }));
      emit({ done: true });
      return;
    }

    const state = {
      msg: { id: '', status: '', content: '', thinking_content: '' },
      finished: false,
      emitted: { content: '', reasoning: '' },
      first: true,
      buffer: '',
      curEvent: undefined,
      curData: '',
      curPath: '',
      curOp: 'SET',
    };

    const errChunks = [];
    const rawRes = await request(
      { url, method, headers },
      JSON.stringify(body),
      (chunk) => {
        errChunks.push(chunk);
        const text = chunk.toString('utf8');
        this.feedSSE(state, text, model, emit);
      }
    );

    if (rawRes.statusCode >= 400) {
      let detail = '';
      if (errChunks.length) {
        detail = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
      }
      emit(openaiChunk({ model, delta: { content: `[上游错误 ${rawRes.statusCode}] ${detail}`, finish: 'stop' } }));
    }
    this.flushSSE(state, model, emit);
    emit({ done: true });
  },

  feedSSE(state, text, model, emit) {
    state.buffer += text;
    let idx;
    while ((idx = state.buffer.search(/\r?\n/)) >= 0) {
      const line = state.buffer.slice(0, idx).replace(/\r$/, '');
      state.buffer = state.buffer.slice(idx + 1);
      this.handleSSELine(state, line, model, emit);
    }
  },

  flushSSE(state, model, emit) {
    if (state.buffer) {
      this.handleSSELine(state, state.buffer, model, emit);
      state.buffer = '';
    }
  },

  handleSSELine(state, line, model, emit) {
    if (line.startsWith('event:')) {
      state.curEvent = line.slice(6).trim();
      state.curData = '';
      return;
    }
    if (line.startsWith('data:')) {
      if (state.curEvent === undefined) state.curEvent = 'delta';
      state.curData += line.slice(5).replace(/^ /, '');
      return;
    }
    if (line === '') {
      const ev = state.curEvent;
      const data = state.curData;
      state.curEvent = undefined;
      state.curData = '';
      if (!ev) return;
      this.handleSSEEvent(state, ev, data, model, emit);
    }
  },

  handleSSEEvent(state, ev, data, model, emit) {
    if (ev === 'delta') {
      try {
        const obj = JSON.parse(data);
        this.applyDelta(state, obj);
        const { content, reasoning } = this.extractText(state.msg);
        const delta = {};
        if (content !== state.emitted.content) {
          delta.content = content.slice(state.emitted.content.length);
          state.emitted.content = content;
        }
        if (reasoning !== state.emitted.reasoning) {
          delta.reasoning_content = reasoning.slice(state.emitted.reasoning.length);
          state.emitted.reasoning = reasoning;
        }
        if (Object.keys(delta).length) {
          if (state.first) {
            delta.role = 'assistant';
            state.first = false;
          }
          emit(openaiChunk({ model, delta }));
        }
      } catch (e) {}
    } else if (ev === 'toast' || ev === 'hint') {
      try {
        const d = JSON.parse(data);
        if (d && d.content && d.type === 'error') {
          emit(openaiChunk({ model, delta: { content: `[错误] ${d.content}` }, finish: 'stop' }));
        }
      } catch (e) {}
    } else if (ev === 'close') {
      state.finished = true;
    }
  },
};
