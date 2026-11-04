const { PassThrough } = require('stream');

class SSELineParser {
  constructor(onLine) {
    this.buffer = '';
    this.onLine = onLine;
  }
  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.search(/\r?\n/)) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.onLine(line);
    }
  }
  end() {
    if (this.buffer.length > 0) this.onLine(this.buffer);
    this.buffer = '';
  }
}

class NDJSONLineParser extends SSELineParser {}

function createSSEWriter(res) {
  const stream = new PassThrough();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  stream.pipe(res);
  return {
    send(event, data) {
      if (event) stream.write(`event: ${event}\n`);
      stream.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    close() {
      stream.write('data: [DONE]\n\n');
      stream.end();
    },
    abort() {
      stream.end();
    },
  };
}

function parseSSEEventData(data) {
  const events = [];
  const lines = data.split(/\r?\n/);
  let eventName = null;
  let dataLines = [];
  const flush = () => {
    if (eventName === null && dataLines.length === 0) return;
    events.push({ event: eventName, data: dataLines.join('\n') });
    eventName = null;
    dataLines = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    else if (line === '') flush();
  }
  flush();
  return events;
}

module.exports = { SSELineParser, NDJSONLineParser, createSSEWriter, parseSSEEventData };
