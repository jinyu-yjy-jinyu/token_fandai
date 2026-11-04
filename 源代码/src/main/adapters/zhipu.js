const { openaiChunk, extractJSONPayload } = require('../utils/openai');

module.exports = {
  id: 'zhipu',
  name: '智谱清言 (chatglm.cn)',
  loginUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
  cookieUrl: 'https://chatglm.cn/',
  localStorageKeys: ['chatglm_access_token'],
  cookieKeys: [],
  models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
  defaultModel: 'glm-4.6',
  catalogFilter: ['z-ai/glm-', 'zhipu/glm-'],
  experimental: true,
  isTokenValid(t) {
    return !!t['chatglm_access_token'];
  },
  buildHeaders(t) {
    return {
      Authorization: `Bearer ${t['chatglm_access_token']}`,
      'Content-Type': 'application/json',
      Origin: 'https://chatglm.cn',
    };
  },
  apiUrl: 'https://chatglm.cn/chatglm/backend-api/v1/chat/completions',
  buildBody(model, messages, opts) {
    const body = {
      model: model || this.defaultModel,
      messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    return body;
  },
  parseChunk(line, model) {
    const j = extractJSONPayload(line);
    if (!j) return null;
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      return openaiChunk({ model, delta: j.choices[0].delta, finish: j.choices[0].finish_reason });
    }
    return null;
  },
};
