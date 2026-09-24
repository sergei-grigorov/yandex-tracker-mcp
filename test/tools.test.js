// Инструменты против поддельного API Трекера: заголовки, тела запросов, ответы, ошибки.

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { TOOL } from '../server/names.js';
import { startFakeTracker } from './fake-tracker.js';
import { call, makeServer } from './helpers.js';

const user = (id, display) => ({ self: `u/${id}`, id: String(id), display, passportUid: id });
const issue = (key, extra = {}) => ({
  self: `i/${key}`,
  id: 'abc',
  key,
  version: 3,
  summary: `Задача ${key}`,
  status: { self: 's', id: '1', key: 'open', display: 'Открыт' },
  type: { self: 't', id: '2', key: 'task', display: 'Задача' },
  queue: { self: 'q', id: '3', key: 'TEST', display: 'Тест' },
  assignee: user(111, 'Иван Петров'),
  description: 'Описание',
  ...extra,
});

let fake;
let server;

before(async () => {
  fake = await startFakeTracker();
  ({ server } = makeServer({ apiUrl: fake.url, env: { TRACKER_DEFAULT_QUEUE: 'TEST' } }));
});
after(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  for (const k of Object.keys(fake.routes)) delete fake.routes[k];
});

test('заголовки: OAuth-токен и организация Яндекс 360', async () => {
  fake.routes['GET /v3/myself'] = () => ({ json: { login: 'ivan', display: 'Иван', uid: 111 } });
  const r = await call(server, TOOL.status);
  assert.equal(r.json.user.login, 'ivan');
  const h = fake.requests[0].headers;
  assert.equal(h.authorization, 'OAuth y0_test-token');
  assert.equal(h['x-org-id'], '12345');
  assert.ok(!r.text.includes('y0_test-token'), 'токен целиком не показывается');
});

test('поиск: запрос, страница, итог, очередь — фильтром', async () => {
  fake.routes['POST /v3/issues/_search'] = () => ({ json: [issue('TEST-1'), issue('TEST-2')], headers: { 'X-Total-Count': '42', 'X-Total-Pages': '21' } });
  let r = await call(server, TOOL.search, { query: 'Assignee: me()', per_page: 2 });
  assert.equal(r.json.total, 42);
  assert.equal(r.json.next_page, 2);
  assert.deepEqual(r.json.issues[0], { key: 'TEST-1', summary: 'Задача TEST-1', status: 'Открыт (open)', type: 'Задача (task)', assignee: 'Иван Петров (111)', queue: 'Тест (TEST)' });
  assert.deepEqual(fake.requests[0].body, { query: 'Assignee: me()' });
  assert.deepEqual(fake.requests[0].query, { perPage: '2', page: '1' });
  await call(server, TOOL.search, { queue: 'test', order: '-updated' });
  assert.deepEqual(fake.requests[1].body, { filter: { queue: 'TEST' }, order: '-updated' });
  fake.routes['POST /v3/issues/_count'] = () => ({ json: 7 });
  r = await call(server, TOOL.search, { query: 'Queue: TEST', count_only: true });
  assert.equal(r.json.total, 7);
  r = await call(server, TOOL.search, {});
  assert.equal(r.isError, true);
  // Очередь дописывается к запросу; способы отбора не смешиваются; order — только с фильтром.
  await call(server, TOOL.search, { query: 'Assignee: me()', queue: 'TEST' });
  assert.deepEqual(fake.requests.at(-1).body, { query: 'Queue: TEST AND (Assignee: me())' });
  const n = fake.requests.length;
  r = await call(server, TOOL.search, { query: 'x', filter: { a: 1 } });
  assert.equal(r.isError, true);
  r = await call(server, TOOL.search, { query: 'x', order: '-updated' });
  assert.equal(r.isError, true);
  assert.equal(fake.requests.length, n);
});

test('задача целиком: комментарии и переходы, описание в конце; ошибка части не роняет ответ', async () => {
  fake.routes['GET /v3/issues/TEST-1'] = () => ({ json: issue('TEST-1') });
  fake.routes['GET /v3/issues/TEST-1/comments'] = () => ({ json: [{ id: 5, text: 'Привет', createdBy: user(222, 'Мария'), createdAt: 't', updatedAt: 't' }] });
  fake.routes['GET /v3/issues/TEST-1/transitions'] = () => ({ json: [{ id: 'start', display: 'В работу', to: { key: 'inProgress', display: 'В работе' } }] });
  const r = await call(server, TOOL.get, { key: 'test-1', include: ['comments', 'transitions', 'links'] });
  assert.equal(r.isError, false);
  assert.deepEqual(r.json.comments, [{ id: 5, author: 'Мария (222)', createdAt: 't', text: 'Привет' }]);
  assert.deepEqual(r.json.transitions, [{ id: 'start', name: 'В работу', to: 'В работе (inProgress)' }]);
  assert.match(r.json.links, /^failed: .*404/);
  assert.equal(Object.keys(r.json).at(-1), 'links');
  assert.ok(!('version' in r.json));
  const bad = await call(server, TOOL.get, { key: 'nope' });
  assert.equal(bad.isError, true);
});

test('создание: очередь по умолчанию, пользователи логином и uid, свои поля', async () => {
  fake.routes['POST /v3/issues/'] = ({ body }) => ({ status: 201, json: issue('TEST-9', { summary: body.summary }) });
  const r = await call(server, TOOL.create, { summary: 'Новая', assignee: 'ivan', followers: ['222'], fields: { storyPoints: 3 }, type: 'bug' });
  assert.equal(r.json.created.key, 'TEST-9');
  assert.deepEqual(fake.requests[0].body, { storyPoints: 3, queue: 'TEST', summary: 'Новая', type: 'bug', assignee: 'ivan', followers: [222] });
});

test('правка: теги добавить/убрать, снять исполнителя', async () => {
  fake.routes['PATCH /v3/issues/TEST-1'] = () => ({ json: issue('TEST-1') });
  const r = await call(server, TOOL.update, { key: 'TEST-1', assignee: '', tags_add: ['a'], tags_remove: ['b'], summary: 'Новое' });
  assert.deepEqual(fake.requests[0].body, { summary: 'Новое', assignee: null, tags: { add: ['a'], remove: ['b'] } });
  assert.deepEqual(r.json.changed.sort(), ['assignee', 'summary', 'tags']);
  const none = await call(server, TOOL.update, { key: 'TEST-1' });
  assert.equal(none.isError, true);
});

test('смена статуса: по названию статуса, с резолюцией и комментарием; неизвестный — список переходов', async () => {
  fake.routes['GET /v3/issues/TEST-1/transitions'] = () => ({
    json: [
      { id: 'start', display: 'В работу', to: { key: 'inProgress', display: 'В работе' } },
      { id: 'close', display: 'Закрыть', to: { key: 'closed', display: 'Закрыт' } },
    ],
  });
  fake.routes['POST /v3/issues/TEST-1/transitions/close/_execute'] = () => ({ json: [] });
  fake.routes['GET /v3/issues/TEST-1'] = () => ({ json: issue('TEST-1', { status: { key: 'closed', display: 'Закрыт' } }) });
  const r = await call(server, TOOL.transition, { key: 'TEST-1', status: 'закрыт', resolution: 'fixed', comment: 'Готово' });
  assert.equal(r.json.now.status, 'Закрыт (closed)');
  const exec = fake.requests.find((q) => q.path.endsWith('_execute'));
  assert.deepEqual(exec.body, { resolution: 'fixed', comment: 'Готово' });
  const bad = await call(server, TOOL.transition, { key: 'TEST-1', status: 'Отменён' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /inProgress/);
  const list = await call(server, TOOL.transition, { key: 'TEST-1' });
  assert.equal(list.json.transitions.length, 2);
});

test('комментарий в Markdown с призывом, время в ISO 8601', async () => {
  fake.routes['POST /v3/issues/TEST-1/comments'] = () => ({ status: 201, json: { id: 77, createdAt: 'now' } });
  fake.routes['POST /v3/issues/TEST-1/worklog'] = () => ({ status: 201, json: { id: 8 } });
  const c = await call(server, TOOL.comment, { key: 'TEST-1', text: '**Готово**', summonees: ['ivan'] });
  assert.equal(c.json.comment_id, 77);
  assert.deepEqual(fake.requests[0].body, { text: '**Готово**', markupType: 'md', summonees: ['ivan'] });
  const w = await call(server, TOOL.logWork, { key: 'TEST-1', duration: '1h 30m', start: '2026-09-24T10:00:00+03:00' });
  assert.deepEqual(fake.requests[1].body, { start: '2026-09-24T07:00:00.000+0000', duration: 'PT1H30M' });
  assert.equal(w.json.worklog_id, 8);
  const bad = await call(server, TOOL.logWork, { key: 'TEST-1', duration: 'долго' });
  assert.equal(bad.isError, true);
});

test('пользователи: поиск по имени и логину, список кешируется', async () => {
  // 150 пользователей: 100 на первой странице, дальше — от uid последнего.
  const people = [{ login: 'ivan', uid: 111, display: 'Иван Петров', email: 'ivan@x.ru' }];
  for (let i = 0; i < 148; i += 1) people.push({ login: `u${i}`, uid: 1000 + i, display: `User ${i}` });
  people.push({ login: 'maria', uid: 222, display: 'Мария Иванова' });
  let pages = 0;
  fake.routes['GET /v3/users'] = ({ query }) => {
    pages += 1;
    assert.equal(query.perPage, '100');
    const from = query.id ? people.findIndex((u) => String(u.uid) === query.id) : 0;
    return { json: people.slice(from, from + 100) };
  };
  let r = await call(server, TOOL.users, { query: 'иван' });
  assert.equal(r.json.count, 2);
  r = await call(server, TOOL.users, { query: 'петров ivan' });
  assert.deepEqual(r.json.users, [{ login: 'ivan', uid: 111, name: 'Иван Петров', email: 'ivan@x.ru' }]);
  assert.equal(pages, 2, 'две страницы, потом из кеша');
});

test('вложения: текст открывается, файл прикладывается multipart', async () => {
  fake.routes['GET /v3/issues/TEST-1/attachments/4'] = () => ({ json: { id: '4', name: 'log.txt', size: 5, mimetype: 'text/plain' } });
  fake.routes['GET /v3/issues/TEST-1/attachments/4/log.txt'] = () => ({ buffer: Buffer.from('hello'), type: 'text/plain' });
  const r = await call(server, TOOL.attachment, { key: 'TEST-1', attachment_id: 4 });
  assert.match(r.text, /hello$/);
  fake.routes['POST /v3/issues/TEST-1/attachments/'] = () => ({ status: 201, json: { id: '9', name: 'a.md', size: 3 } });
  const a = await call(server, TOOL.attach, { key: 'TEST-1', filename: 'a.md', content: 'abc' });
  assert.equal(a.json.attachment.id, '9');
  const up = fake.requests.at(-1);
  assert.match(up.headers['content-type'], /^multipart\/form-data/);
  assert.match(up.raw.toString('utf8'), /filename="a\.md"[\s\S]*abc/);
  const bad = await call(server, TOOL.attach, { key: 'TEST-1', filename: '../x', content: 'abc' });
  assert.equal(bad.isError, true);
});

test('прямые запросы: чтение, POST только для поиска, DELETE выключен', async () => {
  fake.routes['GET /v3/boards'] = () => ({ json: [{ self: 'b', id: 1, name: 'Доска' }] });
  let r = await call(server, TOOL.read, { path: 'boards' });
  assert.deepEqual(r.json, { status: 200, data: [{ id: 1, name: 'Доска' }] });
  r = await call(server, TOOL.read, { path: '/v3/issues/TEST-1/comments', method: 'POST', body: { text: 'x' } });
  assert.equal(r.isError, true);
  assert.equal(fake.requests.length, 1);
  r = await call(server, TOOL.write, { method: 'DELETE', path: '/v3/issues/TEST-1/comments/5' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Разрешить удаление/);
  assert.equal(fake.requests.length, 1);
  r = await call(server, TOOL.read, { path: 'https://evil.example.com/v3/x' });
  assert.equal(r.isError, true);
  // Обход «только чтения» через параметры или фрагмент пути.
  for (const path of ['/v3/bulkchange/_update?x=/_search', '/v3/issues/TEST-1/comments#/_search', '/v3/issues/TEST-1/comments?/_count']) {
    r = await call(server, TOOL.read, { path, method: 'POST', body: { text: 'x' } });
    assert.equal(r.isError, true, path);
  }
  assert.equal(fake.requests.length, 1);
  // Ссылка Link отдаётся путём, пригодным для следующего запроса.
  fake.routes['GET /v3/issues/TEST-1/changelog'] = ({ query }) => ({ json: [{ id: query.id ?? 'a' }], headers: { Link: `<${fake.url}/v3/issues/TEST-1/changelog?id=b&perPage=1>; rel="next"` } });
  r = await call(server, TOOL.read, { path: '/v3/issues/TEST-1/changelog' });
  assert.equal(r.json.next, '/v3/issues/TEST-1/changelog?id=b&perPage=1');
  r = await call(server, TOOL.read, { path: r.json.next });
  assert.deepEqual(r.json.data, [{ id: 'b' }]);
});

test('изменяющие запросы не повторяются после 5xx (иначе дубли), GET — повторяется', async () => {
  let posts = 0;
  fake.routes['POST /v3/issues/TEST-1/comments'] = () => (++posts, { status: 504, json: {} });
  const r = await call(server, TOOL.comment, { key: 'TEST-1', text: 'x' });
  assert.equal(r.isError, true);
  assert.equal(posts, 1);
  let gets = 0;
  fake.routes['GET /v3/issues/TEST-2'] = () => (++gets === 1 ? { status: 503, headers: { 'Retry-After': '0' }, json: {} } : { json: issue('TEST-2') });
  const g = await call(server, TOOL.get, { key: 'TEST-2' });
  assert.equal(g.json.key, 'TEST-2');
});

test('описание задачи — в Markdown (markupType md) при создании и правке', async () => {
  fake.routes['POST /v3/issues/'] = () => ({ status: 201, json: issue('TEST-3') });
  fake.routes['PATCH /v3/issues/TEST-3'] = () => ({ json: issue('TEST-3') });
  await call(server, TOOL.create, { summary: 's', description: '**d**' });
  assert.equal(fake.requests.at(-1).body.markupType, 'md');
  const u = await call(server, TOOL.update, { key: 'TEST-3', description: '# h' });
  assert.equal(fake.requests.at(-1).body.markupType, 'md');
  assert.deepEqual(u.json.changed, ['description']);
});

test('ошибки API: 401 объясняет про токен, 422 — тексты Трекера; 429 повторяется', async () => {
  fake.routes['GET /v3/issues/TEST-1'] = () => ({ status: 401, json: { errorMessages: ['Unauthorized'] } });
  let r = await call(server, TOOL.get, { key: 'TEST-1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 401 — Unauthorized\. The token was rejected/);
  fake.routes['PATCH /v3/issues/TEST-1'] = () => ({ status: 422, json: { errors: { priority: 'Нет такого приоритета' } } });
  r = await call(server, TOOL.update, { key: 'TEST-1', priority: 'ultra' });
  assert.match(r.text, /priority: Нет такого приоритета/);
  let n = 0;
  fake.routes['GET /v3/queues/'] = () => (++n === 1 ? { status: 429, headers: { 'Retry-After': '0' }, json: {} } : { json: [{ key: 'TEST', name: 'Тест' }] });
  r = await call(server, TOOL.queues);
  assert.deepEqual(r.json.queues, [{ key: 'TEST', name: 'Тест' }]);
  assert.equal(n, 2);
});

test('организация Yandex Cloud и IAM-токен', async () => {
  const { server: cloud } = makeServer({ apiUrl: fake.url, env: { TRACKER_TOKEN: 't1.iam', TRACKER_ORG_ID: 'bpfabc' } });
  fake.routes['GET /v3/myself'] = () => ({ json: { login: 'x' } });
  await call(cloud, TOOL.status);
  const h = fake.requests[0].headers;
  assert.equal(h.authorization, 'Bearer t1.iam');
  assert.equal(h['x-cloud-org-id'], 'bpfabc');
  assert.equal(h['x-org-id'], undefined);
});
