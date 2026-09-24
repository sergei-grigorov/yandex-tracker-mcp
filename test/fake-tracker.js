// Поддельный API Трекера для тестов: записывает запросы, отвечает по таблице маршрутов.

import http from 'node:http';

export async function startFakeTracker(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      let body = null;
      if ((req.headers['content-type'] ?? '').startsWith('application/json')) body = JSON.parse(raw.toString('utf8') || 'null');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw };
      requests.push(entry);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errorMessages: ['Не найдено'], statusCode: 404 }));
        return;
      }
      const out = await handler(entry);
      const status = out?.status ?? 200;
      const headers = { 'Content-Type': 'application/json', ...(out?.headers ?? {}) };
      if (Buffer.isBuffer(out?.buffer)) {
        res.writeHead(status, { ...headers, 'Content-Type': out.type ?? 'application/octet-stream' });
        res.end(out.buffer);
        return;
      }
      res.writeHead(status, headers);
      res.end(out?.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () => new Promise((r) => server.close(r)),
  };
}
