// Настройки коннектора — переменные окружения. Локально их подставляет Claude Desktop
// из полей user_config (manifest.json), на сервере — страница настроек коннектора
// (remote/settings.js, файл settings.json).
//
//   TRACKER_TOKEN          OAuth-токен Яндекса (или IAM-токен Yandex Cloud: t1.…)
//   TRACKER_ORG_ID         ID организации
//   TRACKER_ORG_TYPE       360 | cloud; пусто — по виду ID (число — Яндекс 360)
//   TRACKER_DEFAULT_QUEUE  очередь по умолчанию для новых задач
//   TRACKER_ALLOW_WRITE    true — создание и изменение задач, комментарии, время
//   TRACKER_ALLOW_DELETE   true — удаление (комментарии, связи, вложения…) прямыми запросами
//   TRACKER_OAUTH_CLIENT_ID, TRACKER_OAUTH_CLIENT_SECRET — приложение для входа через Яндекс
//                          (только на сервере: login.js берёт их из настроек сам)
// Только переменными окружения:
//   TRACKER_API_URL        адрес API (https://api.tracker.yandex.net)
//   TRACKER_TIMEOUT_MS     таймаут запроса к API (30000)
//   TRACKER_LOG_LEVEL      error | warn | info | debug

export const SETTING_TITLES = {
  token: 'OAuth-токен',
  client_id: 'ClientID приложения',
  client_secret: 'Client secret приложения',
  org_id: 'ID организации',
  org_type: 'Тип организации',
  default_queue: 'Очередь по умолчанию',
  allow_write: 'Разрешить изменения',
  allow_delete: 'Разрешить удаление',
};

// Где пользователь меняет настройки: локально — в Claude Desktop, на сервере —
// на странице коннектора (serve.js задаёт адрес).
export let SETTINGS_PLACE = 'the connector settings in Claude Desktop (Settings → Extensions → Yandex Tracker)';
export function setSettingsPlace(place) {
  SETTINGS_PLACE = place;
}

export const DEFAULT_API_URL = 'https://api.tracker.yandex.net';

// Незаполненное поле user_config Claude Desktop передаёт буквально: ${user_config.x}.
function raw(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return /^\$\{user_config\.[^}]*\}$/.test(s) ? '' : s;
}

function flag(env, name, fallback) {
  const s = raw(env, name);
  if (!s) return fallback;
  return /^(true|1|yes|on)$/i.test(s);
}

export function loadConfig({ env = process.env } = {}) {
  const problems = [];

  // Токен вставляют вместе с приставкой «OAuth » или «Bearer » — её убираем.
  let token = raw(env, 'TRACKER_TOKEN').replace(/^(OAuth|Bearer)\s+/i, '');
  if (/\s/.test(token)) {
    problems.push(`«${SETTING_TITLES.token}»: в токене есть пробелы — проверьте, что он вставлен целиком и без лишнего`);
    token = token.replace(/\s+/g, '');
  }
  // IAM-токены Yandex Cloud начинаются с t1. и передаются как Bearer.
  const authScheme = token.startsWith('t1.') ? 'Bearer' : 'OAuth';

  const orgId = raw(env, 'TRACKER_ORG_ID');
  let orgType = raw(env, 'TRACKER_ORG_TYPE').toLowerCase();
  if (orgType === 'yandex360' || orgType === '360') orgType = '360';
  else if (orgType === 'yandex cloud' || orgType === 'cloud') orgType = 'cloud';
  else {
    if (orgType) problems.push(`«${SETTING_TITLES.org_type}»: «${orgType}» не понято — нужно 360 или cloud; тип определён по ID`);
    orgType = /^\d+$/.test(orgId) ? '360' : 'cloud';
  }

  if (!token) problems.push(`«${SETTING_TITLES.token}» не задан — Трекер недоступен`);
  if (!orgId) problems.push(`«${SETTING_TITLES.org_id}» не задан — Трекер недоступен`);

  const defaultQueue = raw(env, 'TRACKER_DEFAULT_QUEUE').toUpperCase();
  if (defaultQueue && !/^[A-Z][A-Z0-9]*$/.test(defaultQueue)) {
    problems.push(`«${SETTING_TITLES.default_queue}»: «${defaultQueue}» не похоже на ключ очереди (латиница, например TEST)`);
  }

  let apiUrl = raw(env, 'TRACKER_API_URL') || DEFAULT_API_URL;
  try {
    const u = new URL(apiUrl);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('https only');
    apiUrl = u.origin;
  } catch {
    problems.push(`TRACKER_API_URL: «${apiUrl}» — нужен адрес https; взят ${DEFAULT_API_URL}`);
    apiUrl = DEFAULT_API_URL;
  }

  const timeout = Number(raw(env, 'TRACKER_TIMEOUT_MS') || 30_000);

  return {
    token,
    authScheme,
    orgId,
    orgType,
    orgHeader: orgType === '360' ? 'X-Org-ID' : 'X-Cloud-Org-ID',
    ready: Boolean(token && orgId),
    defaultQueue: /^[A-Z][A-Z0-9]*$/.test(defaultQueue) ? defaultQueue : '',
    allowWrite: flag(env, 'TRACKER_ALLOW_WRITE', true),
    allowDelete: flag(env, 'TRACKER_ALLOW_DELETE', false),
    apiUrl,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 120_000) : 30_000,
    logLevel: (raw(env, 'TRACKER_LOG_LEVEL') || 'info').toLowerCase(),
    problems,
  };
}
