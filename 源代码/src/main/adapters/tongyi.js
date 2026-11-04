const { openaiChunk, extractJSONPayload } = require('../utils/openai');

module.exports = {
  id: 'tongyi',
  name: '通义千问',
  loginUrl: 'https://tongyi.aliyun.com/qianwen/',
  cookieUrl: 'https://tongyi.aliyun.com/',
  localStorageKeys: ['tgfToken', 'XSRF-TOKEN'],
  cookieKeys: [],
  models: ['qwen3-max', 'qwen3-plus', 'qwen3-turbo', 'qwen-long'],
  defaultModel: 'qwen3-max',
  catalogFilter: ['qwen/', 'qwen3', 'qwen2.5', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
  experimental: true,
  isTokenValid(t) {
    return !!(t['tgfToken'] || t['__allCookies'] && (t['__allCookies']['login_aliyunid_ticket'] || t['__allCookies']['login_aliyunid_pk']));
  },
  buildHeaders(t) {
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'https://tongyi.aliyun.com',
      Referer: 'https://tongyi.aliyun.com/',
    };
    if (t['tgfToken']) headers['x-tgf-token'] = t['tgfToken'];
    const ck = t['__allCookies'];
    if (ck) {
      const parts = Object.keys(ck)
        .filter((k) => k.startsWith('login_'))
        .map((k) => `${k}=${ck[k]}`)
        .join('; ');
      if (parts) headers.Cookie = parts;
    }
    return headers;
  },
  apiUrl: 'https://tongyi.aliyun.com/qianwen/api/gpt-chat/completions',
  buildBody(model, messages, opts) {
    return {
      model: model || this.defaultModel,
      input: { messages },
      parameters: { result_format: 'message' },
      stream: true,
    };
  },
  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    if (j.output && j.output.choices && j.output.choices[0]) {
      const c = j.output.choices[0];
      return openaiChunk({ model, delta: c.message || { content: c.text || '' }, finish: c.finish_reason });
    }
    return null;
  },
};
