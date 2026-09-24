// Общие заготовки тестов: сервер с тестовыми настройками и вызов инструмента.

import { createServer } from '../server/index.js';
import { silentLogger } from '../server/log.js';

export { silentLogger };

export function makeServer({ env = {}, apiUrl } = {}) {
  return createServer({
    env: { TRACKER_TOKEN: 'y0_test-token', TRACKER_ORG_ID: '12345', TRACKER_API_URL: apiUrl ?? 'http://127.0.0.1:9', ...env },
    logger: silentLogger,
  });
}

let seq = 0;

export async function call(server, name, args = {}) {
  seq += 1;
  const r = await server.handle({ jsonrpc: '2.0', id: seq, method: 'tools/call', params: { name, arguments: args } });
  if (r.error) throw new Error(`RPC error ${r.error.code}: ${r.error.message}`);
  const text = r.result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON
  }
  return { ...r.result, text, json };
}
