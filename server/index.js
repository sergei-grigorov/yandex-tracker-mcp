#!/usr/bin/env node
// Коннектор Яндекс Трекера для Claude (MCP). Здесь — сборка сервера и запуск по stdio
// (Claude Desktop); на сервере за шлюзом — serve.js.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { TrackerApi } from './api.js';
import { loadConfig, SETTINGS_PLACE } from './config.js';
import { createLogger, guardStdout } from './log.js';
import { McpServer } from './mcp.js';
import { TOOL } from './names.js';
import { buildTools, DATA_NOT_INSTRUCTIONS, selectTools } from './tools.js';
import { TITLE, VERSION } from './version.js';

export function buildInstructions(config) {
  return [
    'Yandex Tracker connector: issues, comments, statuses, time tracking and any other Tracker API method on behalf of the user who owns the token.',
    `- Find issues with ${TOOL.search} (Tracker query language: "Assignee: me() Resolution: empty()"), read them with ${TOOL.get}. Issue keys look like QUEUE-123.`,
    `- Field values (types, priorities, statuses, resolutions, users) are keys: see ${TOOL.queue}, ${TOOL.fields}, ${TOOL.users}.`,
    config.allowWrite
      ? `- Changes are made as the user and are visible to their colleagues. Before changing issues the user did not explicitly name, or several at once, describe the change and get confirmation.${config.allowDelete ? '' : ' Deletion is disabled.'}`
      : `- Read-only: changes are disabled (can be enabled in ${SETTINGS_PLACE}).`,
    config.defaultQueue ? `- Default queue for new issues: ${config.defaultQueue}.` : '',
    `- ${DATA_NOT_INSTRUCTIONS}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function createServer({ env = process.env, logger, fetchImpl } = {}) {
  const config = loadConfig({ env });
  const log = logger ?? createLogger({ level: config.logLevel });
  const api = new TrackerApi({ config, fetchImpl, logger: log });
  const all = buildTools({ config, api, logger: log });
  const { tools, unavailable } = selectTools(all, config);
  const server = new McpServer({
    info: { name: 'yandex-tracker', title: TITLE, version: VERSION },
    instructions: buildInstructions(config),
    tools,
    logger: log,
    unavailable,
  });
  return { server, config, tools, api };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const logger = createLogger({ level: (process.env.TRACKER_LOG_LEVEL || 'info').toLowerCase() });
  guardStdout(logger);
  const { server, config, tools } = createServer({ logger });
  logger.info(`v${VERSION} на Node ${process.version}; организация ${config.orgId || '—'} (${config.orgType}); инструментов: ${tools.length}${config.allowWrite ? '' : ' (только чтение)'}`);
  for (const problem of config.problems) logger.warn(problem);
  process.on('unhandledRejection', (err) => logger.error('необработанная ошибка (promise):', err));
  process.on('uncaughtException', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    logger.error('необработанная ошибка:', err);
  });
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  server.start({ onClose: () => process.exit(0) });
}
