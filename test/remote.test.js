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

test('настройки на сервере: поля манифеста → переменные окружения', () => {
  const dir = tempDir();
  const s = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  s.load();
  assert.deepEqual(s.fields.map((f) => f.key), Object.keys(manifest.user_config));
  const empty = s.parseForm(new URLSearchParams({}));
  assert.deepEqual(empty.errors, [], 'можно сохранить ClientID до входа через Яндекс');
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

test('вход через Яндекс: код + PKCE → токен в настройках, state одноразовый, продление', async (t) => {
  const { createHash } = await import('node:crypto');
  const challenges = [];
  const oauth = await startFakeTracker({
    'POST /token': ({ raw }) => {
      const f = new URLSearchParams(raw.toString('utf8'));
      if (f.get('client_id') !== 'cid' || f.get('client_secret') !== 'csecret') return { status: 400, json: { error: 'invalid_client' } };
      if (f.get('grant_type') === 'refresh_token') {
        return f.get('refresh_token') === 'r1' ? { json: { access_token: 'y0_refreshed', refresh_token: 'r2', expires_in: 31536000 } } : { status: 400, json: { error: 'invalid_grant' } };
      }
      const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
      if (f.get('code') !== 'code-1' || !challenges.includes(challenge)) return { status: 400, json: { error: 'invalid_grant', error_description: 'bad code' } };
      return { json: { access_token: 'y0_fromlogin', refresh_token: 'r1', expires_in: 100 } };
    },
    'GET /info': ({ headers }) => (headers.authorization === 'OAuth y0_fromlogin' ? { json: { login: 'ivan' } } : { status: 401, json: {} }),
  });
  t.after(() => oauth.close());
  const tracker = await startFakeTracker({ 'GET /v3/myself': ({ headers }) => ({ json: { login: headers.authorization } }) });
  t.after(() => tracker.close());
  const dir = tempDir();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server', 'serve.js')], {
    env: { ...process.env, PUBLIC_URL: PUBLIC, GATEWAY_SECRET: SECRET, DATA_DIR: dir, PORT: String(port), TRACKER_API_URL: tracker.url, YANDEX_OAUTH_URL: oauth.url, YANDEX_LOGIN_URL: oauth.url },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => {
    log += d;
  });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !log.includes('← http://'); i += 1) await sleep(50);

  // Без ClientID — объяснение, как создать приложение.
  let r = await request({ port, method: 'GET', path: '/tracker/login', headers: gw('owner') });
  assert.equal(r.status, 400);
  assert.match(r.text, /tracker\/login\/callback/);
  // Страница входа — только владельцу.
  r = await request({ port, method: 'GET', path: '/tracker/login', headers: gw('token') });
  assert.equal(r.status, 401);

  const form = { ...gw('owner'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://agent.example.com' };
  r = await request({ port, path: '/tracker/settings', headers: form, body: 'client_id=cid&client_secret=csecret&org_id=555&allow_write=on' });
  assert.equal(r.status, 303, r.text);
  const page = await request({ port, method: 'GET', path: '/tracker/settings', headers: gw('owner') });
  assert.match(page.text, /Войти через Яндекс/);
  assert.ok(!page.text.includes('csecret'));

  r = await request({ port, method: 'GET', path: '/tracker/login', headers: gw('owner') });
  assert.equal(r.status, 302);
  const auth = new URL(r.headers.location);
  assert.equal(auth.origin + auth.pathname, `${oauth.url}/authorize`);
  assert.equal(auth.searchParams.get('client_id'), 'cid');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://agent.example.com/tracker/login/callback');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  challenges.push(auth.searchParams.get('code_challenge'));
  const state = auth.searchParams.get('state');

  // Чужой state не принимается.
  r = await request({ port, method: 'GET', path: '/tracker/login/callback?code=code-1&state=forged', headers: gw('owner') });
  assert.equal(r.status, 400);
  r = await request({ port, method: 'GET', path: `/tracker/login/callback?code=code-1&state=${state}`, headers: gw('owner') });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /ivan/);
  // Повтор того же state — отказ.
  r = await request({ port, method: 'GET', path: `/tracker/login/callback?code=code-1&state=${state}`, headers: gw('owner') });
  assert.equal(r.status, 400);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.values.token, 'y0_fromlogin');
  assert.equal(settings.values.client_id, 'cid');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8'));
  assert.equal(saved.refresh_token, 'r1');
  assert.equal(fs.statSync(path.join(dir, 'oauth.json')).mode & 0o777, 0o600);

  // Коннектор перезапущен с новым токеном.
  r = await request({ port, body: rpc(1, 'tools/call', { name: 'connector_status', arguments: {} }), headers: gw() });
  assert.equal(JSON.parse(JSON.parse(r.text).result.content[0].text).user.login, 'OAuth y0_fromlogin');

  const after = await request({ port, method: 'GET', path: '/tracker/settings', headers: gw('owner') });
  assert.match(after.text, /Вход через Яндекс \(ivan\)/);
});

test('продление токена: за 30 дней до истечения по refresh_token', async (t) => {
  const { YandexLogin } = await import('../server/login.js');
  const { SettingsStore: Store } = await import('../server/remote/settings.js');
  const oauth = await startFakeTracker({
    'POST /token': ({ raw }) => {
      const f = new URLSearchParams(raw.toString('utf8'));
      return f.get('refresh_token') === 'r1' ? { json: { access_token: 'y0_new', refresh_token: 'r2', expires_in: 31536000 } } : { status: 400, json: { error: 'invalid_grant' } };
    },
  });
  t.after(() => oauth.close());
  const dir = tempDir();
  const settings = new Store({ file: path.join(dir, 'settings.json'), manifest });
  settings.save({ token: 'y0_old', client_id: 'cid', client_secret: 'cs' });
  let reloaded = 0;
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const login = new YandexLogin({ publicUrl: PUBLIC, settings, file: path.join(dir, 'oauth.json'), logger: silent, onToken: async () => reloaded++, oauthUrl: oauth.url });
  login.writeState({ refresh_token: 'r1', expires_at: new Date(Date.now() + 90 * 86400_000).toISOString() });
  assert.equal(await login.refreshIfNeeded(), false, 'рано продлевать');
  login.writeState({ refresh_token: 'r1', expires_at: new Date(Date.now() + 5 * 86400_000).toISOString() });
  assert.equal(await login.refreshIfNeeded(), true);
  assert.equal(settings.values.token, 'y0_new');
  assert.equal(login.readState().refresh_token, 'r2');
  assert.equal(reloaded, 1);
  assert.equal(oauth.requests.length, 1);
});
