// Клиент API Яндекс Трекера (https://api.tracker.yandex.net/v3). Авторизация —
// «Authorization: OAuth <токен>» (или Bearer для IAM-токена) и заголовок организации:
// X-Org-ID для Яндекс 360, X-Cloud-Org-ID для организации Yandex Cloud.

import { ToolError } from './mcp.js';

// GET повторяется и на ошибки шлюза; изменяющие запросы — только на 429 (Трекер их не
// выполнил), иначе повтор после 504 мог бы создать вторую задачу или комментарий.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 5000;

// Путь запроса: «issues/TEST-1», «/v3/issues/TEST-1» или «/v2/…». Ведёт только
// в API Трекера: без схемы и хоста, без «..», без обратных слэшей.
export function apiPath(input) {
  let p = String(input ?? '').trim();
  if (!p) throw new ToolError('path is empty');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) throw new ToolError(`path must be relative to the Tracker API, e.g. /v3/issues/TEST-1 (got ${p})`);
  if (p.includes('\\')) throw new ToolError('path must not contain backslashes');
  if (p.includes('#')) throw new ToolError('path must not contain "#"');
  if (/[\x00-\x20\x7f]/.test(p)) throw new ToolError('path must not contain spaces or control characters');
  if (!p.startsWith('/')) p = `/${p}`;
  const [pathname] = p.split('?');
  const segments = pathname.split('/');
  if (segments.some((s) => /^(\.|%2e)+$/i.test(s) || /%2f|%5c/i.test(s))) throw new ToolError('path must not contain "." or ".." segments');
  if (/^\/v[23]$/.test(pathname)) p = `${pathname}/${p.slice(pathname.length)}`;
  else if (!/^\/v[23]\//.test(p)) p = `/v3${p}`;
  return p;
}

// Итоговый путь запроса (после разбора URL) — по нему проверяется, что за метод вызывается.
export function resolvedPathname(input, base = 'https://api.tracker.yandex.net') {
  return new URL(apiPath(input), base).pathname;
}

function describeErrors(data) {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data.slice(0, 500) : '';
  const parts = [];
  if (Array.isArray(data.errorMessages)) parts.push(...data.errorMessages);
  if (data.errors && typeof data.errors === 'object') {
    for (const [field, msg] of Object.entries(data.errors)) parts.push(`${field}: ${msg}`);
  }
  if (!parts.length && data.message) parts.push(data.message);
  return parts.join('; ');
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export class TrackerApi {
  constructor({ config, fetchImpl = globalThis.fetch, logger }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  headers(extra = {}) {
    const { token, authScheme, orgHeader, orgId } = this.config;
    return {
      Authorization: `${authScheme} ${token}`,
      [orgHeader]: orgId,
      Accept: 'application/json',
      'Accept-Language': 'ru',
      'User-Agent': 'yandex-tracker-mcp',
      ...extra,
    };
  }

  url(path, query) {
    const url = new URL(apiPath(path), this.config.apiUrl);
    // Защита от подмены хоста хитрым путём.
    if (url.origin !== new URL(this.config.apiUrl).origin || !/^\/v[23]\//.test(url.pathname)) throw new ToolError('path leads outside the Tracker API');
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'object' && !Array.isArray(v)) throw new ToolError(`query.${k}: expected a string, number or list, not an object`);
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return url;
  }

  // → { status, data, headers, total, pages, next }. Ошибки API — ToolError с объяснением.
  // body: объект → JSON; FormData — как есть. binary: true — data = Buffer.
  async request(method, path, { query, body, signal, binary = false } = {}) {
    if (!this.config.ready) throw new ToolError(this.notConfigured());
    const url = this.url(path, query);
    const init = { method, headers: this.headers() };
    if (body !== undefined) {
      if (body instanceof FormData) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json; charset=utf-8';
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      init.signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      const started = Date.now();
      try {
        res = await this.fetch(url, init);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timeout.aborted) throw new ToolError(`Tracker API did not answer in ${this.config.timeoutMs / 1000} s (${method} ${url.pathname})`);
        const cause = err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.cause?.message ?? err?.message ?? err;
        throw new ToolError(`Tracker API is unreachable (${url.host}): ${cause}`);
      }
      this.logger?.debug?.(`${method} ${url.pathname}${url.search} → ${res.status} (${Date.now() - started} ms)`);
      if ((method === 'GET' ? RETRY_STATUSES.has(res.status) : res.status === 429) && attempt < 2 && !(body instanceof FormData)) {
        const after = Number(res.headers.get('retry-after'));
        const wait = Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * (attempt + 1));
        await res.arrayBuffer().catch(() => {});
        await sleep(wait, signal);
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        continue;
      }
      let data;
      if (binary && res.ok) data = Buffer.from(await res.arrayBuffer());
      else {
        const text = await res.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
      }
      if (!res.ok) throw new ToolError(this.explain(res.status, data, method, url));
      const num = (h) => (res.headers.get(h) === null ? undefined : Number(res.headers.get(h)));
      const link = res.headers.get('link') ?? '';
      // Ссылку на следующую страницу отдаём путём: её можно передать в send_read_request.
      let next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (next) {
        try {
          const u = new URL(next, url);
          next = `${u.pathname}${u.search}`;
        } catch {
          next = undefined;
        }
      }
      return {
        status: res.status,
        data,
        headers: res.headers,
        total: num('x-total-count'),
        pages: num('x-total-pages'),
        next,
        scrollId: res.headers.get('x-scroll-id') ?? undefined,
      };
    }
  }

  get(path, query, opts = {}) {
    return this.request('GET', path, { ...opts, query });
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body });
  }

  patch(path, body, opts = {}) {
    return this.request('PATCH', path, { ...opts, body });
  }

  notConfigured() {
    return this.config.problems.filter((p) => /не задан/.test(p)).join('; ') + '. Ask the user to fill in the Yandex Tracker connector settings.';
  }

  explain(status, data, method, url) {
    const details = describeErrors(data);
    const what = `${method} ${url.pathname}: HTTP ${status}${details ? ` — ${details}` : ''}`;
    switch (status) {
      case 401:
        return `${what}. The token was rejected: it is wrong, expired or revoked (IAM tokens live 12 hours). Ask the user to issue a new OAuth token and save it in the connector settings.`;
      case 403:
        return `${what}. Access denied: the user has no rights for this, the token lacks the tracker:write scope, or the organization ID/type (${this.config.orgHeader}) is wrong.`;
      case 404:
        return `${what}. Not found: check the key or ID (issue keys look like QUEUE-123).`;
      case 409:
        return `${what}. Conflict: the object was changed by someone else — read it again and retry.`;
      case 412:
        return `${what}. Precondition failed: the object version changed — read it again and retry.`;
      case 422:
        return `${what}. The values are not accepted by the queue settings (field, status, type or workflow).`;
      case 429:
        return `${what}. Too many requests — wait a little and retry.`;
      default:
        return what;
    }
  }
}
