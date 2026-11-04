const { openaiChunk, extractJSONPayload } = require('../utils/openai');

module.exports = {
  id: 'doubao',
  name: '豆包 (抖音)',
  loginUrl: 'https://www.doubao.com/chat/',
  cookieUrl: 'https://www.doubao.com/',
  localStorageKeys: ['AREA_REGION', 'ttwid'],
  cookieKeys: [],
  models: ['doubao-seed-1.6', 'doubao-1.5-pro', 'doubao-1.5-lite', 'doubao-reasoner'],
  defaultModel: 'doubao-seed-1.6',
  catalogFilter: ['doubao', 'byteplus', 'seed', 'volcengine'],
  experimental: true,
  isTokenValid(t) {
    const ck = t['__allCookies'] || {};
    return !!(t['ttwid'] || ck['sessionid'] || ck['passport_csrf_token'] || ck['sid_tt']);
  },
  buildHeaders(t) {
    const headers = { 'Content-Type': 'application/json', Origin: 'https://www.doubao.com' };
    const ck = t['__allCookies'];
    if (ck) {
      const parts = Object.keys(ck)
        .filter((k) => k === 'sessionid' || k === 'sid_tt' || k === 'ttwid' || k === 'passport_csrf_token' || k === 'sessionid_ss')
        .map((k) => `${k}=${ck[k]}`)
        .join('; ');
      if (parts) headers.Cookie = parts;
    }
    return headers;
  },
  apiUrl: 'https://www.doubao.com/api/web/message/v2',
  buildBody(model, messages, opts) {
    return {
      messages,
      model: model || this.defaultModel,
      stream: true,
    };
  },
  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    if (j.type === 'status') return null;
    if (j.type === 'message' && j.content && j.content.delta) {
      return openaiChunk({ model, delta: { content: j.content.delta } });
    }
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      return openaiChunk({ model, delta: j.choices[0].delta, finish: j.choices[0].finish_reason });
    }
    return null;
  },
};
