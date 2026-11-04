const http = require('http');
const { URL } = require('url');
const adapters = require('./adapters');
const store = require('./utils/store');
const catalog = require('./modelCatalog');
const { request } = require('./utils/httpClient');
const { createSSEWriter, parseSSEEventData } = require('./utils/sse');
const { buildNonStreamed, openaiChunk, openaiDone } = require('./utils/openai');

const DEFAULT_PORT = 8349;

class LocalServer {
  constructor() {
    this.port = DEFAULT_PORT;
    this.server = null;
  }

  setPort(p) {
    this.port = p;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用，请更换端口`));
        } else {
          reject(e);
        }
      });
      this.server.listen(this.port, '127.0.0.1', () => resolve(this.server.address()));
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  logRequest(body) {
    try {
      const fs = require('fs');
      const path = require('path');
      const logDir = path.join(process.env.APPDATA || '.', 'fandai-token');
      const line = `[${new Date().toISOString()}] model=${body.model || '?'} stream=${body.stream} body=${JSON.stringify(body).slice(0, 2000)}\n`;
      fs.appendFileSync(path.join(logDir, 'chat-requests.log'), line, 'utf8');
    } catch (e) {}
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const s = Buffer.concat(chunks).toString('utf8');
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    this.setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
        return this.handleModels(req, res);
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
        const body = await this.readBody(req);
        return this.handleChat(body, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found', type: 'invalid_request_error' } }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'invalid_request_error' } }));
    }
  }

  async handleModels(req, res) {
    const tokens = store.getTokens();
    const data = [];
    for (const a of adapters.list()) {
      if (!tokens[a.id]) continue;
      let models = a.models;
      let dyn = null;
      if (typeof a.fetchModels === 'function') {
        try {
          dyn = await a.fetchModels(tokens[a.id]);
          if (dyn && dyn.length) models = dyn;
        } catch (e) {}
      }
      if (!dyn || !dyn.length) {
        const catModels = catalog.getModels(a.id);
        if (catModels && catModels.length) models = catModels;
      }
      for (const m of models) {
        data.push({
          id: m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: a.id,
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
  }

  async handleChat(body, res) {
    this.logRequest(body);
    const model = body.model || '';
    const adapter = adapters.findByModel(model);
    if (!adapter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `未知模型: ${model}`, type: 'invalid_request_error' } }));
      return;
    }
    const tokens = store.getTokens();
    const token = tokens[adapter.id];
    if (!token || !adapter.isTokenValid(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `站点 ${adapter.name} 未登录或 token 失效，请在软件中重新登录`, type: 'authentication_error' } }));
      return;
    }

    const messages = body.messages || [];
    if (!messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } }));
      return;
    }

    const opts = { temperature: body.temperature, max_tokens: body.max_tokens };
    const wantStream = body.stream === true || body.stream === 'true';

    if (adapter.customChat && typeof adapter.chat === 'function') {
      if (!wantStream) {
        return this.customChatNonStreamed(adapter, model, token, messages, opts, res);
      }
      return this.customChatStreamed(adapter, model, token, messages, opts, res);
    }

    const upstreamBody = adapter.buildBody(model, messages, opts);
    const headers = adapter.buildHeaders(token);

    // 非流式：请求上游流式，本地聚合后返回 JSON
    if (!wantStream) {
      return this.chatNonStreamed(adapter, model, headers, upstreamBody, res);
    }
    return this.chatStreamed(adapter, model, headers, upstreamBody, res);
  }

  async customChatNonStreamed(adapter, model, token, messages, opts, res) {
    const chunks = [];
    await adapter.chat(token, model, messages, opts, (ev) => {
      if (ev && ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content) {
        chunks.push(ev.choices[0].delta.content);
      }
    });
    const content = chunks.join('');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildNonStreamed(null, model, content)));
  }

  async customChatStreamed(adapter, model, token, messages, opts, res) {
    const writer = createSSEWriter(res);
    try {
      await adapter.chat(token, model, messages, opts, (ev) => {
        if (ev && ev.done) {
          writer.send(null, openaiDone());
          writer.close();
          return;
        }
        if (ev && ev.choices) {
          writer.send(null, ev);
        }
      });
    } catch (e) {
      writer.send(null, openaiChunk({ model, delta: { content: `[错误] ${e.message}` }, finish: 'stop' }));
      writer.close();
    }
  }

  async chatNonStreamed(adapter, model, headers, upstreamBody, res) {
    const chunks = [];
    const upstreamRes = await request(
      { url: adapter.apiUrl, method: 'POST', headers },
      JSON.stringify(upstreamBody),
      (chunk) => chunks.push(chunk)
    );
    if (upstreamRes.statusCode >= 400) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `上游返回 ${upstreamRes.statusCode}`, type: 'upstream_error' } }));
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const full = this.aggregateRaw(raw, adapter, model);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(full));
  }

  aggregateRaw(raw, adapter, model) {
    let content = '';
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const r = adapter.parseChunk(line, model);
      if (!r) continue;
      if (r.done) break;
      if (r.choices && r.choices[0] && r.choices[0].delta) {
        if (r.choices[0].delta.content) content += r.choices[0].delta.content;
      }
    }
    if (!content) {
      try {
        const j = JSON.parse(raw);
        if (j.choices && j.choices[0] && j.choices[0].message) {
          content = j.choices[0].message.content || '';
        } else if (j.output && j.output.text) {
          content = j.output.text;
        }
      } catch (e) {}
    }
    return buildNonStreamed(null, model, content || '');
  }

  async chatStreamed(adapter, model, headers, upstreamBody, res) {
    const writer = createSSEWriter(res);

    let finished = false;
    let aborted = false;
    let first = true;
    let status = 0;
    const errChunks = [];

    res.on('close', () => {
      aborted = true;
    });

    const signal = { aborted: false, listeners: [] };
    signal.addEventListener = (ev, fn) => {
      if (ev === 'abort') signal.listeners.push(fn);
    };

    try {
      await request(
        { url: adapter.apiUrl, method: 'POST', headers },
        JSON.stringify(upstreamBody),
        (chunk, meta) => {
          if (meta && meta.statusCode) status = meta.statusCode;
          errChunks.push(chunk);
          if (aborted) return;
          const text = chunk.toString('utf8');
          const events = parseSSEEventData(text);
          for (const ev of events) {
            if (ev.data === '[DONE]') {
              finished = true;
              writer.send(null, openaiDone());
              writer.close();
              return;
            }
            const r = adapter.parseChunk(`data: ${ev.data}`, model);
            if (!r) continue;
            if (r.done) {
              finished = true;
              writer.send(null, openaiDone());
              writer.close();
              return;
            }
            if (first && r.choices && r.choices[0]) {
              r.choices[0].delta.role = 'assistant';
              first = false;
            }
            writer.send(null, r);
          }
        },
        signal
      ).then((meta) => {
        if (meta && meta.statusCode) status = meta.statusCode;
        if (status >= 400 && !finished) {
          const errText = Buffer.concat(errChunks).toString('utf8').slice(0, 300);
          writer.send(null, openaiChunk({ model, delta: { content: `[上游错误 ${status}] ${errText}` }, finish: 'stop' }));
          writer.close();
          return;
        }
        if (!finished && !aborted) {
          writer.send(null, openaiDone());
          writer.close();
        }
      }).catch(() => {
        if (!finished && !aborted) writer.close();
      });
    } catch (e) {
      if (!aborted) writer.close();
    }
  }
}

module.exports = LocalServer;
