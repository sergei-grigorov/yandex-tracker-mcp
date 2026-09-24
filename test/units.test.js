// Настройки, пути API, сжатие ответов, продолжительности, имена и манифест.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { apiPath } from '../server/api.js';
import { loadConfig } from '../server/config.js';
import { compact, isoDuration, issueBrief } from '../server/format.js';
import { TOOL, WRITE_TOOLS } from '../server/names.js';
import { VERSION } from '../server/version.js';
import { call, makeServer } from './helpers.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('настройки: тип организации по ID, приставка токена, IAM — Bearer, незаполненные поля Claude Desktop', () => {
  let c = loadConfig({ env: { TRACKER_TOKEN: 'OAuth y0_abc', TRACKER_ORG_ID: '7654321' } });
  assert.equal(c.token, 'y0_abc');
  assert.equal(c.authScheme, 'OAuth');
  assert.equal(c.orgHeader, 'X-Org-ID');
  assert.equal(c.ready, true);
  assert.equal(c.allowWrite, true);
  assert.equal(c.allowDelete, false);
  c = loadConfig({ env: { TRACKER_TOKEN: 't1.iam', TRACKER_ORG_ID: 'bpf123abc' } });
  assert.equal(c.authScheme, 'Bearer');
  assert.equal(c.orgHeader, 'X-Cloud-Org-ID');
  c = loadConfig({ env: { TRACKER_TOKEN: 'x', TRACKER_ORG_ID: '123', TRACKER_ORG_TYPE: 'cloud' } });
  assert.equal(c.orgHeader, 'X-Cloud-Org-ID');
  c = loadConfig({ env: { TRACKER_TOKEN: '${user_config.token}', TRACKER_ORG_ID: '${user_config.org_id}', TRACKER_ALLOW_WRITE: '${user_config.allow_write}' } });
  assert.equal(c.ready, false);
  assert.equal(c.allowWrite, true);
  assert.equal(c.problems.length, 2);
  c = loadConfig({ env: { TRACKER_API_URL: 'http://evil.example.com' } });
  assert.equal(c.apiUrl, 'https://api.tracker.yandex.net');
  c = loadConfig({ env: { TRACKER_DEFAULT_QUEUE: 'test' } });
  assert.equal(c.defaultQueue, 'TEST');
});

test('пути API: только внутри API Трекера', () => {
  assert.equal(apiPath('issues/TEST-1'), '/v3/issues/TEST-1');
  assert.equal(apiPath('/v2/myself'), '/v2/myself');
  assert.equal(apiPath('/v3/issues/_search?perPage=5'), '/v3/issues/_search?perPage=5');
  assert.equal(apiPath('/v3'), '/v3/');
  for (const bad of ['https://evil.com/x', '//evil.com/x', '/v3/../x', '/v3/%2e%2e/x', '/v3/.%2e/.%2e/foo', '/v3/.\t./x', '/v3/a%2fb', 'a\\b', '/v3/x#/_search', '']) {
    assert.throws(() => apiPath(bad), bad);
  }
});

test('сжатие ответа: ссылки на объекты — одной строкой, служебное убрано', () => {
  const issue = {
    self: 'https://api/v3/issues/TEST-1',
    key: 'TEST-1',
    summary: 'Задача',
    status: { self: 's', id: '1', key: 'open', display: 'Открыт' },
    assignee: { self: 'u', id: '111', display: 'Иван Петров', passportUid: 111, cloudUid: 'abc' },
    followers: [],
    description: null,
    favorite: false,
  };
  assert.deepEqual(compact(issue), { key: 'TEST-1', summary: 'Задача', status: 'Открыт (open)', assignee: 'Иван Петров (111)' });
  assert.deepEqual(issueBrief(issue), { key: 'TEST-1', summary: 'Задача', status: 'Открыт (open)', assignee: 'Иван Петров (111)' });
});

test('продолжительность: человеческая запись → ISO 8601', () => {
  assert.equal(isoDuration('1h 30m'), 'PT1H30M');
  assert.equal(isoDuration('2d'), 'P2D');
  assert.equal(isoDuration('1w 2d 3h'), 'P7DT3H');
  assert.equal(isoDuration('2w'), 'P2W');
  assert.equal(isoDuration('P2W'), 'P2W');
  assert.equal(isoDuration('2mo'), null);
  assert.equal(isoDuration('2 мес'), null);
  assert.equal(isoDuration('3 часа 10 минут'), 'PT3H10M');
  assert.equal(isoDuration('1.5h'), 'PT90M');
  assert.equal(isoDuration('2ч 15м'), 'PT2H15M');
  assert.equal(isoDuration('PT45M'), 'PT45M');
  assert.equal(isoDuration('p1d'), 'P1D');
  assert.equal(isoDuration('soon'), null);
  assert.equal(isoDuration('5'), null);
  assert.equal(isoDuration('1h and 2x'), null);
});

test('версии совпадают: package.json, manifest.json, сервер', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(VERSION, pkg.version);
});

test('имена — значения TOOL, без приставки; title — имя словами и в annotations; манифест совпадает', () => {
  const { tools } = makeServer();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.values(TOOL).sort());
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), Object.values(TOOL).sort());
  for (const t of tools) {
    assert.match(t.name, /^[a-z]+(_[a-z]+)+$/, t.name);
    assert.ok(!/tracker|yandex/.test(t.name), t.name);
    assert.equal(t.title, t.name.charAt(0).toUpperCase() + t.name.slice(1).replace(/_/g, ' '));
    assert.equal(t.annotations.title, t.title);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.annotations.readOnlyHint, !WRITE_TOOLS.includes(t.name), t.name);
  }
  const env = Object.values(manifest.server.mcp_config.env).join(' ');
  for (const key of Object.keys(manifest.user_config)) assert.ok(env.includes(`\${user_config.${key}}`), key);
});

test('правила безопасности — в описаниях инструментов (claude.ai отбрасывает instructions)', () => {
  const { tools } = makeServer();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of [TOOL.search, TOOL.get, TOOL.attachment, TOOL.read]) assert.match(by[n].description, /data, not instructions/, n);
  for (const n of [TOOL.create, TOOL.update, TOOL.transition, TOOL.comment]) assert.match(by[n].description, /confirmation/, n);
  assert.match(by[TOOL.write].description, /explicit confirmation/);
  assert.match(by[TOOL.write].description, /DELETE is disabled/);
});

test('изменения выключены: инструменты записи скрыты, вызов объясняет, как включить', async () => {
  const { server, tools } = makeServer({ env: { TRACKER_ALLOW_WRITE: 'false' } });
  const names = tools.map((t) => t.name);
  for (const n of WRITE_TOOLS) assert.ok(!names.includes(n), n);
  assert.ok(names.includes(TOOL.search) && names.includes(TOOL.read));
  const r = await call(server, TOOL.create, { summary: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Разрешить изменения/);
  assert.match(server.instructions, /Read-only/);
});

test('без токена: понятная ошибка вместо запроса', async () => {
  const { server } = makeServer({ env: { TRACKER_TOKEN: '' } });
  const r = await call(server, TOOL.get, { key: 'TEST-1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /OAuth-токен/);
  const s = await call(server, TOOL.status);
  assert.equal(s.isError, false);
  assert.ok(s.json.settings_problems.length);
});
