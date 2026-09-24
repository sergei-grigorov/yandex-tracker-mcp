// Коннектор на сервере: настройки из manifest.json, serve.js за шлюзом — секрет, MCP,
// страница настроек, пересоздание с новыми настройками.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SettingsStore } from '../server/remote/settings.js';
import { startFakeTracker } from './fake-tracker.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const SECRET = 's'.repeat(40);
const PUBLIC = 'https://agent.example.com/tracker';

const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mcp-test-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request({ port, method = 'POST', path: p = '/tracker', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const gw = (auth = 'token') => ({ 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': auth, 'X-Gateway-Grant': 'grant-1' });

test('настройки на сервере: поля манифеста → переменные окружения, токен обязателен', () => {
  const dir = tempDir();
  const s = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  s.load();
  assert.deepEqual(s.fields.map((f) => f.key), Object.keys(manifest.user_config));
  const empty = s.parseForm(new URLSearchParams({}));
  assert.equal(empty.errors.length, 2, 'токен и ID организации обязательны');
  const ok = s.parseForm(new URLSearchParams({ token: 'y0_x', org_id: '123', default_queue: 'TEST', allow_write: 'on' }));
  assert.deepEqual(ok.errors, []);
  s.save(ok.values);
  const env = s.env(s.values, { PATH: '/bin' });
  assert.equal(env.TRACKER_TOKEN, 'y0_x');
  assert.equal(env.TRACKER_ORG_ID, '123');
  assert.equal(env.TRACKER_ALLOW_WRITE, 'true');
  assert.equal(env.TRACKER_ALLOW_DELETE, 'false', 'значение по умолчанию из манифеста');
  assert.equal(env.TRACKER_ORG_TYPE, undefined, 'пустое поле удаляет переменную');
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  // Пустое секретное поле при следующем сохранении оставляет токен.
  const again = s.parseForm(new URLSearchParams({ token: '', org_id: '123' }));
  assert.equal(again.values.token, 'y0_x');
});

test('serve.js за шлюзом: секрет, MCP только с токеном, страница настроек, новые настройки применяются', async (t) => {
  const fake = await startFakeTracker({ 'GET /v3/myself': () => ({ json: { login: 'ivan', display: 'Иван' } }) });
  t.after(() => fake.close());
  const dir = tempDir();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server', 'serve.js')], {
    env: { ...process.env, PUBLIC_URL: PUBLIC, GATEWAY_SECRET: SECRET, DATA_DIR: dir, PORT: String(port), TRACKER_API_URL: fake.url },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => {
    log += d;
  });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !log.includes('← http://'); i += 1) await sleep(50);
  assert.match(log, /← http:\/\//);

  assert.equal((await request({ port, body: rpc(1, 'tools/list') })).status, 403);
  assert.equal((await request({ port, body: rpc(1, 'tools/list'), headers: gw('owner') })).status, 401);

  const init = await request({ port, body: rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), headers: gw() });
  assert.equal(init.status, 200, init.text);
  const result = JSON.parse(init.text).result;
  assert.equal(result.serverInfo.name, 'yandex-tracker');
  assert.match(result.instructions, /the connector settings page https:\/\/agent\.example\.com\/tracker\/settings|Yandex Tracker connector/);

  const noToken = await request({ port, body: rpc(2, 'tools/call', { name: 'get_issue', arguments: { key: 'TEST-1' } }), headers: gw() });
  assert.match(JSON.parse(noToken.text).result.content[0].text, /OAuth-токен/);

  const page = await request({ port, method: 'GET', path: '/tracker/settings', headers: gw('owner') });
  assert.equal(page.status, 200);
  assert.match(page.text, /Yandex Tracker: настройки/);
  assert.match(page.text, /ID организации/);

  const saved = await request({
    port,
    path: '/tracker/settings',
    headers: { ...gw('owner'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://agent.example.com' },
    body: 'token=y0_saved&org_id=555',
  });
  assert.equal(saved.status, 303, saved.text);
  assert.ok(!page.text.includes('y0_saved'));

  const listed = await request({ port, body: rpc(3, 'tools/list'), headers: gw() });
  const names = JSON.parse(listed.text).result.tools.map((x) => x.name);
  assert.ok(!names.includes('create_issue'), 'изменения выключены: флажок не отмечен в форме');
  const status = await request({ port, body: rpc(4, 'tools/call', { name: 'connector_status', arguments: {} }), headers: gw() });
  const out = JSON.parse(JSON.parse(status.text).result.content[0].text);
  assert.equal(out.user.login, 'ivan');
  assert.equal(fake.requests.at(-1).headers.authorization, 'OAuth y0_saved');
  assert.equal(fake.requests.at(-1).headers['x-org-id'], '555');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(file.values.token, 'y0_saved');
});
