const { openaiChunk, extractJSONPayload } = require('../utils/openai');

module.exports = {
  id: 'kimi',
  name: 'Kimi (月之暗面)',
  loginUrl: 'https://kimi.moonshot.cn/',
  cookieUrl: 'https://kimi.moonshot.cn/',
  localStorageKeys: ['auth-token'],
  cookieKeys: [],
  models: ['kimi-k2.5', 'kimi-k2', 'kimi-thinking', 'moonshot-v1-128k'],
  defaultModel: 'kimi-k2.5',
  catalogFilter: ['moonshotai/', 'kimi/'],
  experimental: true,
  isTokenValid(t) {
    return !!(t['auth-token'] || t['__allCookies'] && (t['__allCookies']['kid'] || t['__allCookies']['kws_session']));
  },
  buildHeaders(t) {
    const headers = { 'Content-Type': 'application/json', Origin: 'https://kimi.moonshot.cn' };
    const at = t['auth-token'];
    if (at) headers.Authorization = `Bearer ${at}`;
    const ck = t['__allCookies'];
    if (ck) {
      const parts = Object.keys(ck)
        .filter((k) => k.startsWith('k') || k === 'kid' || k === 'kws_session' || k === '_kws_trace_id')
        .map((k) => `${k}=${ck[k]}`)
        .join('; ');
      if (parts) headers.Cookie = parts;
    }
    return headers;
  },
  apiUrl: 'https://kimi.moonshot.cn/api/chat',
  buildBody(model, messages, opts) {
    const body = {
      messages,
      model: model || this.defaultModel,
      use_research: false,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    return body;
  },
  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    if (j.event === 'cmpl' && j.text) {
      return openaiChunk({ model, delta: { content: j.text } });
    }
    if (j.event === 'done') return { done: true };
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      return openaiChunk({ model, delta: j.choices[0].delta, finish: j.choices[0].finish_reason });
    }
    return null;
  },
};
