const { openaiChunk, extractJSONPayload } = require('../utils/openai');

module.exports = {
  id: 'yiyan',
  name: '文心一言',
  loginUrl: 'https://yiyan.baidu.com/',
  cookieUrl: 'https://yiyan.baidu.com/',
  localStorageKeys: ['_yiyan_user_name', 'BAIDUID'],
  cookieKeys: [],
  models: ['ernie-4.5', 'ernie-x1', 'ernie-4.0-turbo', 'ernie-lite'],
  defaultModel: 'ernie-4.5',
  catalogFilter: ['baidu/ernie', 'ernie-'],
  experimental: true,
  isTokenValid(t) {
    const ck = t['__allCookies'] || {};
    return !!(ck['BAIDUID'] && (ck['BDUSS'] || ck['BDUSS_BFESS']));
  },
  buildHeaders(t) {
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'https://yiyan.baidu.com',
      Referer: 'https://yiyan.baidu.com/',
    };
    const ck = t['__allCookies'];
    if (ck) {
      const parts = Object.keys(ck)
        .filter((k) => k === 'BAIDUID' || k === 'BDUSS' || k === 'BDUSS_BFESS' || k === 'STOKEN')
        .map((k) => `${k}=${ck[k]}`)
        .join('; ');
      if (parts) headers.Cookie = parts;
    }
    return headers;
  },
  apiUrl: 'https://yiyan.baidu.com/api/reader/async/resetPageChat',
  buildBody(model, messages, opts) {
    return {
      conversationId: '',
      messages,
      model: model || this.defaultModel,
      stream: true,
    };
  },
  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    if (j.result && j.result.content) {
      return openaiChunk({ model, delta: { content: j.result.content } });
    }
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      return openaiChunk({ model, delta: j.choices[0].delta, finish: j.choices[0].finish_reason });
    }
    return null;
  },
};
