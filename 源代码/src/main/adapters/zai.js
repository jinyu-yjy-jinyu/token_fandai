const crypto = require('crypto');
const { openaiChunk, extractJSONPayload } = require('../utils/openai');
const { request } = require('../utils/httpClient');

const FE_VERSION = 'prod-fe-1.1.82';
const HMAC_KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

function isGuestToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return true;
    const b64 = String(parts[1]).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const email = payload.email || '';
    if (email.startsWith('guest')) return true;
    return false;
  } catch (e) {
    return true;
  }
}

function zaiSignature(sortedPayload, payloadForBase64, timestamp) {
  const m = Math.floor(timestamp / (5 * 60 * 1000));
  const inner = crypto.createHmac('sha256', HMAC_KEY).update(String(m)).digest();
  const bytes = new TextEncoder().encode(payloadForBase64);
  const parts = [];
  for (let y = 0; y < bytes.length; y += 32768) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.slice(y, y + 32768))));
  }
  const p = Buffer.from(parts.join(''), 'latin1').toString('base64');
  const h = sortedPayload + '|' + p + '|' + timestamp;
  const signature = crypto.createHmac('sha256', inner).update(h).digest('hex');
  return { signature, timestamp };
}

module.exports = {
  id: 'zai',
  name: 'Z.ai (GLM 国际版)',
  loginUrl: 'https://chat.z.ai/',
  cookieUrl: 'https://chat.z.ai/',
  localStorageKeys: ['token'],
  cookieKeys: [],
  models: ['glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'],
  defaultModel: 'glm-4.7',
  catalogFilter: ['z-ai/glm-', 'zhipu/glm-'],
  experimental: true,
  customChat: true,
  keepWindowOpen: true,
  isTokenValid(t) {
    const v = t['token'];
    if (!v || typeof v !== 'string' || v.length < 20) return false;
    if (isGuestToken(v)) return false;
    return true;
  },

  async checkToken(t) {
    if (!t || !t.token) return false;
    try {
      const res = await request({
        url: 'https://chat.z.ai/api/models',
        method: 'GET',
        headers: this.buildHeaders(t),
      });
      return res.statusCode === 200;
    } catch (e) {
      return false;
    }
  },
  buildHeaders(t) {
    return {
      Authorization: `Bearer ${t['token']}`,
      'Content-Type': 'application/json',
      Origin: 'https://chat.z.ai',
      Referer: 'https://chat.z.ai/',
      'Accept-Language': 'en-US',
      'X-FE-Version': FE_VERSION,
    };
  },
  apiUrl: 'https://chat.z.ai/api/v2/chat/completions',

  async fetchModels(tokens) {
    if (!tokens || !tokens.token) return null;
    try {
      const res = await request({
        url: 'https://chat.z.ai/api/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.token}`,
          'Accept-Language': 'en-US',
          'X-FE-Version': FE_VERSION,
          Origin: 'https://chat.z.ai',
        },
      });
      if (res.statusCode !== 200) return null;
      const j = JSON.parse(res.body.toString('utf8'));
      if (!Array.isArray(j.data)) return null;
      const models = j.data.map((m) => String(m.id || '')).filter((id) => id && id.length > 2);
      return models.length ? models : null;
    } catch (e) {
      return null;
    }
  },

  buildBody(model, messages, opts) {
    const body = {
      model: model || this.defaultModel,
      messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    return body;
  },

  async buildChatRequest(tokens, model, messages, opts) {
    const body = this.buildBody(model, messages, opts);
    const timestamp = Date.now();
    const sorted = `timestamp=${timestamp}`;
    const { signature } = zaiSignature(sorted, JSON.stringify(body), timestamp);
    const url = `${this.apiUrl}?signature_timestamp=${timestamp}`;
    return {
      url,
      method: 'POST',
      headers: Object.assign(this.buildHeaders(tokens), { 'X-Signature': signature }),
      body,
    };
  },

  async chat(tokens, model, messages, opts, emit) {
    let req;
    try {
      req = await this.buildChatRequest(tokens, model, messages, opts);
    } catch (e) {
      emit(openaiChunk({ model, delta: { content: `[错误] ${e.message}` }, finish: 'stop' }));
      emit({ done: true });
      return;
    }

    const state = {
      buffer: '',
      curEvent: undefined,
      curData: '',
      emitted: '',
      first: true,
    };

    const handleEvent = (data) => {
      const chunk = this.parseChunk(`data: ${data}`, model);
      if (!chunk) return;
      if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
        const c = chunk.choices[0].delta.content;
        if (!c) return;
        if (state.first) {
          state.first = false;
          chunk.choices[0].delta.role = 'assistant';
        }
        emit(chunk);
      }
    };

    const rawRes = await request(
      { url: req.url, method: req.method, headers: req.headers },
      JSON.stringify(req.body),
      (chunk) => {
        state.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = state.buffer.search(/\r?\n/)) >= 0) {
          const line = state.buffer.slice(0, idx).replace(/\r$/, '');
          state.buffer = state.buffer.slice(idx + 1);
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try {
              const j = JSON.parse(data);
              const inner = (j.data && j.data.data) || j.data || j;
              if (inner.error && inner.done) {
                handleEvent(data);
                return;
              }
              if (typeof inner.content === 'string' || j.choices) {
                handleEvent(data);
              }
            } catch (e) {}
          }
        }
      }
    );

    if (rawRes.statusCode >= 400) {
      let msg = `[上游错误 ${rawRes.statusCode}]`;
      if (rawRes.statusCode === 401) {
        msg = 'Z.ai 登录已过期或 token 无效，请先在软件中【清除】后重新【登录】一次。';
      }
      emit(openaiChunk({ model, delta: { content: msg }, finish: 'stop' }));
    }
    if (state.buffer) {
      const line = state.buffer.trim();
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data !== '[DONE]') {
          try { handleEvent(data); } catch (e) {}
        }
      }
    }
    emit({ done: true });
  },

  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    const t = j.type;
    const data = j.data;
    let inner = data && data.data ? data.data : data;

    if (t === 'chat:message:delta' || t === 'message') {
      if (inner && typeof inner.content === 'string') {
        return openaiChunk({ model, delta: { content: inner.content } });
      }
    }
    if (t === 'chat:message' || t === 'replace') {
      if (inner && typeof inner.content === 'string') {
        return openaiChunk({ model, delta: { content: inner.content } });
      }
    }
    if (t === 'chat:completion' && inner) {
      if (inner.error) {
        return this.errorChunk(model, inner.error);
      }
      if (typeof inner.content === 'string') {
        return openaiChunk({ model, delta: { content: inner.content }, finish: 'stop' });
      }
    }
    if (inner) {
      if (inner.error && inner.done) return this.errorChunk(model, inner.error);
      if (typeof inner.content === 'string') {
        return openaiChunk({ model, delta: { content: inner.content } });
      }
      if (inner.choices && inner.choices[0] && inner.choices[0].delta) {
        return openaiChunk({ model, delta: inner.choices[0].delta, finish: inner.choices[0].finish_reason });
      }
    }
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      return openaiChunk({ model, delta: j.choices[0].delta, finish: j.choices[0].finish_reason });
    }
    if (j.error) return this.errorChunk(model, j.error);
    return null;
  },

  errorChunk(model, err) {
    const code = err.code || '';
    const detail = err.detail || err.message || '未知错误';
    let friendly = '';
    if (code === 'FRONTEND_CAPTCHA_REQUIRED') {
      friendly = 'Z.ai 需要网页验证码：请在浏览器登录窗口的 z.ai 网页中完成一次对话后重试。此错误是 z.ai 的反爬机制，无法纯接口绕过。';
    } else if (code === 403 || /not available|permission/i.test(detail)) {
      friendly = '当前账号无权使用该模型（403）：请在 z.ai 网页版确认该模型可正常对话，或更换其它模型。';
    } else {
      friendly = `[z.ai 错误] ${detail}`;
    }
    return openaiChunk({ model, delta: { content: friendly }, finish: 'stop' });
  },
};
