function openaiChunk({ id, model, delta, finish, role }) {
  const c = {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  if (delta) c.choices[0].delta = delta;
  if (role) c.choices[0].delta.role = role;
  if (finish !== undefined) c.choices[0].finish_reason = finish;
  return c;
}

function openaiDone() {
  return { id: 'done', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
}

function buildNonStreamed(responseId, model, content) {
  return {
    id: responseId || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function extractJSONPayload(line, { dataPrefix = 'data:', skip = ['[DONE]'] } = {}) {
  if (!line) return null;
  let s = line.trim();
  if (s.startsWith(dataPrefix)) s = s.slice(dataPrefix.length).trim();
  if (skip.includes(s)) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

module.exports = { openaiChunk, openaiDone, buildNonStreamed, extractJSONPayload };
