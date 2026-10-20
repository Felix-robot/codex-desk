const http = require('node:http');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');

function compatibleRequest(body) {
  const next = { ...body };
  // Keep user/assistant messages and tool exchanges intact. This relay cannot
  // reliably replay opaque reasoning items from earlier Responses requests.
  if (Array.isArray(body.input)) next.input = body.input.filter(item => item.type !== 'reasoning');
  return next;
}

class RelayAdapter {
  constructor({ baseUrl, key, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); this.key = key; this.fetch = fetchImpl;
    this.prefix = '/' + randomUUID() + '/v1';
  }
  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${this.server.address().port}${this.prefix}`;
  }
  async handle(req, res) {
    const route = req.url?.slice(this.prefix.length);
    if (!req.url?.startsWith(this.prefix + '/') || req.method !== 'POST' || !['/responses', '/responses/compact'].includes(route)) { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== 'Bearer ' + this.key) { res.writeHead(401); res.end(); return; }
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
      let buffer = Buffer.concat(chunks);
      const opts = { maxOutputLength: 64 * 1024 * 1024 };
      if (req.headers['content-encoding'] === 'zstd') buffer = zlib.zstdDecompressSync(buffer, opts);
      else if (req.headers['content-encoding'] === 'gzip') buffer = zlib.gunzipSync(buffer, opts);
      else if (req.headers['content-encoding'] === 'deflate') buffer = zlib.inflateSync(buffer, opts);
      const body = JSON.stringify(compatibleRequest(JSON.parse(buffer.toString())));
      const headers = { ...req.headers, authorization: 'Bearer ' + this.key, 'content-type': 'application/json' };
      for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'content-encoding']) delete headers[name];
      const response = await this.fetch(this.baseUrl + route, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      const outgoing = { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' };
      for (const name of ['x-request-id', 'request-id', 'retry-after']) if (response.headers.has(name)) outgoing[name] = response.headers.get(name);
      res.writeHead(response.status, outgoing);
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal: controller.signal }); }
      if (!res.destroyed) res.end();
    } catch {
      if (res.destroyed) return;
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '本机中转兼容连接失败，请重试或检查 API 服务状态。' } })); }
      else res.destroy();
    }
  }
  stop() { this.server?.closeAllConnections(); this.server?.close(); this.server = null; }
}

module.exports = { RelayAdapter, compatibleRequest };
