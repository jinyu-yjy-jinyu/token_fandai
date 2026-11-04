const http = require('http');
const https = require('https');
const { URL } = require('url');
const { SSELineParser } = require('./sse');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function request(options, bodyBuffer, onChunk, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      options.headers || {}
    );

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'POST',
        headers,
      },
      (res) => {
        if (signal && signal.aborted) {
          res.destroy();
          return;
        }
        if (onChunk) {
          res.on('data', (chunk) => {
            if (onChunk) onChunk(chunk, { statusCode: res.statusCode });
          });
        } else {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
        res.on('end', () => {
          if (onChunk) resolve({ statusCode: res.statusCode, headers: res.headers });
        });
        res.on('error', (e) => reject(e));
      }
    );

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
      });
    }
    req.on('error', (e) => reject(e));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function parseSSEFromRes(res, onLine) {
  const parser = new SSELineParser(onLine);
  res.on('data', (chunk) => parser.push(chunk));
  res.on('end', () => parser.end());
}

module.exports = { request, parseSSEFromRes };
