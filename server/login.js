// Вход через аккаунт Яндекса (только на сервере): вместо того чтобы вставлять токен,
// владелец нажимает «Войти через Яндекс» на странице настроек. Работает через
// приложение на oauth.yandex.ru (его ClientID и Client secret — в настройках):
//
//   /login           → oauth.yandex.ru/authorize (код авторизации + PKCE, state)
//   /login/callback  ← код → POST oauth.yandex.ru/token → токен в настройки, перезапуск
//
// Обе страницы — только для владельца (их пропускает шлюз после входа). Токен Яндекса
// живёт около года; refresh_token хранится в oauth.json рядом с settings.json, и за
// 30 дней до истечения токен продлевается сам.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

import { writeFileAtomic } from './remote/settings.js';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BEFORE_MS = 30 * 24 * 3600_000;
const CHECK_EVERY_MS = 12 * 3600_000;

const b64url = (buf) => buf.toString('base64url');

export class YandexLogin {
  // onToken() — после записи нового токена в настройки (перезапуск коннектора).
  constructor({ publicUrl, settings, file, logger, onToken, fetchImpl = globalThis.fetch, oauthUrl = 'https://oauth.yandex.ru', loginUrl = 'https://login.yandex.ru' }) {
    this.base = publicUrl.replace(/\/+$/, '');
    this.basePath = new URL(this.base).pathname;
    this.settings = settings;
    this.file = file;
    this.logger = logger;
    this.onToken = onToken;
    this.fetch = fetchImpl;
    this.oauthUrl = oauthUrl;
    this.loginUrl = loginUrl;
    this.pending = new Map(); // state → { verifier, at }
    this.timer = null;
  }

  get redirectUri() {
    return `${this.base}/login/callback`;
  }

  get credentials() {
    return {
      clientId: String(this.settings.effective('client_id') ?? '').trim(),
      clientSecret: String(this.settings.effective('client_secret') ?? '').trim(),
    };
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  writeState(state) {
    writeFileAtomic(this.file, `${JSON.stringify(state, null, 1)}\n`);
  }

  // Для страницы настроек: вошли ли через Яндекс и до какого числа действует токен.
  describe() {
    const s = this.readState();
    if (!s.expires_at) return '';
    const date = new Date(s.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    return `Вход через Яндекс${s.login ? ` (${s.login})` : ''}: токен действует до ${date}${s.refresh_token ? ' и продлевается сам' : ''}.`;
  }

  async tokenRequest(params) {
    const { clientId, clientSecret } = this.credentials;
    const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret });
    const res = await this.fetch(`${this.oauthUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const why = data.error_description || data.error || `HTTP ${res.status}`;
      throw new Error(`oauth.yandex.ru не выдал токен: ${why}`);
    }
    return data;
  }

  // Логин владельца токена — для подписи на странице; без права login:info не узнать.
  async whoAmI(token) {
    try {
      const res = await this.fetch(`${this.loginUrl}/info?format=json`, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return '';
      const d = await res.json();
      return String(d.login ?? d.display_name ?? '');
    } catch {
      return '';
    }
  }

  async store(data, login) {
    const prev = this.readState();
    const state = {
      refresh_token: data.refresh_token ?? prev.refresh_token ?? null,
      expires_at: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
      login: login || prev.login || null,
      updated: new Date().toISOString(),
    };
    this.writeState(state);
    this.settings.save({ ...this.settings.values, token: data.access_token });
    await this.onToken?.();
    return state;
  }

  // Продление: за 30 дней до истечения, по refresh_token.
  async refreshIfNeeded({ force = false } = {}) {
    const s = this.readState();
    if (!s.refresh_token || !s.expires_at) return false;
    if (!force && Date.parse(s.expires_at) - Date.now() > REFRESH_BEFORE_MS) return false;
    if (!this.credentials.clientId || !this.credentials.clientSecret) {
      this.logger.warn('токен Яндекса скоро истечёт, а ClientID/Client secret не заданы — продлить нечем');
      return false;
    }
    const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
    await this.store(data, s.login);
    this.logger.info('токен Яндекса продлён');
    return true;
  }

  start() {
    const tick = () => this.refreshIfNeeded().catch((err) => this.logger.error(`продление токена Яндекса: ${err.message}`));
    tick();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Маршрут /login для RemoteHost (страницы владельца).
  async handle(req, res, { rest, host }) {
    if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
    const settingsLink = [{ href: `${this.basePath}/settings`, text: 'Настройки коннектора' }];
    const { clientId, clientSecret } = this.credentials;

    if (rest === '' || rest === '/') {
      if (!clientId || !clientSecret) {
        return host.message(
          res,
          400,
          'Вход через Яндекс',
          `Сначала заполните в настройках «ClientID приложения» и «Client secret приложения». Приложение создаётся один раз на oauth.yandex.ru: платформа «Веб-сервисы», Redirect URI — ${this.redirectUri}, доступы — «Чтение из трекера» и «Запись в трекер».`,
          [...settingsLink, { href: 'https://oauth.yandex.ru/client/new', text: 'Создать приложение на oauth.yandex.ru' }],
        );
      }
      const now = Date.now();
      for (const [k, v] of this.pending) if (now - v.at > STATE_TTL_MS) this.pending.delete(k);
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(48));
      this.pending.set(state, { verifier, at: now });
      const url = new URL(`${this.oauthUrl}/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: this.redirectUri,
        state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        force_confirm: 'yes',
      }).toString();
      res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }

    if (rest === '/callback') {
      const q = new URL(req.url, this.base).searchParams;
      const entry = this.pending.get(q.get('state') ?? '');
      this.pending.delete(q.get('state') ?? '');
      if (!entry || Date.now() - entry.at > STATE_TTL_MS) {
        return host.message(res, 400, 'Вход через Яндекс', 'Ссылка входа устарела или открыта не отсюда. Начните вход заново.', [{ href: `${this.basePath}/login`, text: 'Войти через Яндекс' }, ...settingsLink]);
      }
      if (q.get('error')) {
        return host.message(res, 400, 'Вход через Яндекс', `Яндекс не дал доступ: ${q.get('error_description') || q.get('error')}.`, settingsLink);
      }
      const code = q.get('code');
      if (!code) return host.message(res, 400, 'Вход через Яндекс', 'Яндекс не вернул код авторизации.', settingsLink);
      try {
        const data = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: entry.verifier });
        const login = await this.whoAmI(data.access_token);
        await this.store(data, login);
        this.logger.info(`вход через Яндекс${login ? `: ${login}` : ''}`);
        const orgMissing = !String(this.settings.effective('org_id') ?? '').trim();
        return host.message(
          res,
          200,
          'Вход через Яндекс',
          `Готово: коннектор работает от имени ${login || 'вашего аккаунта'}. ${this.describe()}${orgMissing ? ' Осталось указать ID организации в настройках.' : ''}`,
          settingsLink,
        );
      } catch (err) {
        this.logger.error(`вход через Яндекс: ${err.message}`);
        return host.message(res, 502, 'Вход через Яндекс', `${err.message}. Проверьте ClientID и Client secret в настройках и Redirect URI приложения: ${this.redirectUri}.`, settingsLink);
      }
    }
    return res.writeHead(404).end();
  }
}
