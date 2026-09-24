#!/usr/bin/env node
// Коннектор Яндекс Трекера на сервере: MCP по HTTP за шлюзом (gateway), настройки —
// на странице коннектора, а не в Claude Desktop. Подробности — README, раздел «На сервере».
//
// Переменные окружения:
//   PUBLIC_URL          — адрес коннектора для Claude, например https://agent.example.com/tracker
//   GATEWAY_SECRET      — общий секрет со шлюзом (или GATEWAY_SECRET_FILE — файл с ним)
//   DATA_DIR            — папка данных (settings.json), по умолчанию ~/.yandex-tracker-mcp
//   HOST, PORT          — где слушать; по умолчанию 127.0.0.1:8080 (в контейнере — 0.0.0.0)
// Остальные переменные (TRACKER_TIMEOUT_MS и т. п.) действуют как обычно; поля настроек
// из manifest.json → user_config задаются только на странице настроек.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setSettingsPlace } from './config.js';
import { createServer } from './index.js';
import { createLogger } from './log.js';
import { YandexLogin } from './login.js';
import { RemoteHost } from './remote/host.js';
import { escapeHtml } from './remote/page.js';
import { SettingsStore } from './remote/settings.js';
import { TITLE, VERSION } from './version.js';

const logger = createLogger({ level: (process.env.TRACKER_LOG_LEVEL || 'info').toLowerCase() });

function fail(message) {
  logger.error(message);
  process.exit(1);
}

function readSecret() {
  if (process.env.GATEWAY_SECRET) return process.env.GATEWAY_SECRET.trim();
  const file = process.env.GATEWAY_SECRET_FILE;
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    return fail(`GATEWAY_SECRET_FILE: ${err.message}`);
  }
}

const publicUrl = process.env.PUBLIC_URL?.trim();
if (!publicUrl || !/^https?:\/\/[^/]+\/.+/.test(publicUrl)) fail('PUBLIC_URL: нужен адрес коннектора с путём, например https://agent.example.com/tracker');
const gatewaySecret = readSecret();
if (gatewaySecret.length < 32) fail('GATEWAY_SECRET: нужен общий секрет со шлюзом не короче 32 символов');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), '.yandex-tracker-mcp'));
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const base = publicUrl.replace(/\/+$/, '');

setSettingsPlace(`the connector settings page ${base}/settings`);

const settings = new SettingsStore({ file: path.join(dataDir, 'settings.json'), manifest, logger });

// Вход через аккаунт Яндекса: страницы /login и /login/callback, продление токена.
// host появится ниже — к моменту вызова onToken он уже создан.
let host;
const login = new YandexLogin({
  publicUrl: base,
  settings,
  file: path.join(dataDir, 'oauth.json'),
  logger,
  onToken: () => host.reload(),
  oauthUrl: process.env.YANDEX_OAUTH_URL || undefined,
  loginUrl: process.env.YANDEX_LOGIN_URL || undefined,
});

async function createApp(env) {
  const { server, config, tools } = createServer({ env, logger });
  logger.info(
    `организация ${config.orgId || '—'} (${config.orgType}), токен ${config.token ? 'есть' : 'нет'}, изменения ${config.allowWrite ? 'вкл' : 'выкл'}, удаление ${config.allowDelete ? 'вкл' : 'выкл'}; инструментов: ${tools.length}`,
  );
  for (const problem of config.problems) logger.warn(problem);
  return {
    mcp: server,
    problems: config.problems,
    routes: { '/login': (req, res, ctx) => login.handle(req, res, ctx) },
    async close() {
      server.closeSubscriptions();
    },
  };
}

const basePath = new URL(base).pathname;
host = new RemoteHost({
  title: TITLE,
  publicUrl: base,
  gatewaySecret,
  settings,
  createApp,
  logger,
  intro: () => {
    const status = login.describe();
    return (
      `Адрес коннектора для Claude: <b>${escapeHtml(base)}</b>. Токен хранится на этом сервере и уходит только в API Трекера. ` +
      'Пустое секретное поле оставляет сохранённое значение.' +
      `<br><br><a href="${escapeHtml(basePath)}/login"><b>Войти через Яндекс</b></a> — токен запишется сам (нужны ClientID и Client secret приложения, Redirect URI — <code>${escapeHtml(login.redirectUri)}</code>).` +
      (status ? `<br>${escapeHtml(status)}` : '')
    );
  },
  links: [
    { href: `${basePath}/login`, text: 'Войти через Яндекс', note: 'получить токен своим аккаунтом' },
    { href: '/', text: 'Все коннекторы, подключённые приложения и пароль владельца' },
  ],
});

process.on('unhandledRejection', (err) => logger.error('необработанная ошибка (promise):', err));
process.on('uncaughtException', (err) => logger.error('необработанная ошибка:', err));

const address = await host.start({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8080) });
logger.info(`v${VERSION} на Node ${process.version}: ${base} ← http://${address.address}:${address.port}; данные: ${dataDir}`);
login.start();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 5000).unref();
  login.stop();
  await host.stop().catch((err) => logger.error(`остановка: ${err?.message ?? err}`));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
