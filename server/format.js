// Ответы Трекера многословны: у каждой ссылки на пользователя, статус или очередь есть
// self, id, key и display. Для модели они сворачиваются в одну строку, служебное
// (self, пустые значения) убирается — ответ короче в разы, а смысл тот же.

// Ключи «ссылки на объект»: объект только из них сворачивается в строку.
const REF_KEYS = new Set(['self', 'id', 'key', 'display', 'cloudUid', 'passportUid', 'login', 'name', 'version']);
const DROP_KEYS = new Set(['self', 'favorite', 'emailCreatedBy', 'emailTo', 'emailCc', 'emailFrom']);

export function refString(v) {
  if (v.key !== undefined && v.key !== null) return v.display && v.display !== v.key ? `${v.display} (${v.key})` : String(v.key);
  const id = v.login ?? v.passportUid ?? v.id;
  return id !== undefined && id !== null && String(id) !== v.display ? `${v.display} (${id})` : String(v.display);
}

function isRef(v) {
  return typeof v.display === 'string' && Object.keys(v).every((k) => REF_KEYS.has(k));
}

export function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((x) => x !== undefined);
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'object') return value;
  if (isRef(value)) return refString(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k)) continue;
    const c = compact(v);
    if (c === undefined) continue;
    if (Array.isArray(c) && !c.length) continue;
    out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

// Задача в списке: главное, без описания.
export function issueBrief(issue) {
  const c = compact(issue) ?? {};
  const pick = ['key', 'summary', 'status', 'type', 'priority', 'assignee', 'queue', 'updatedAt', 'deadline', 'resolution', 'parent', 'sprint', 'tags', 'storyPoints'];
  const out = {};
  for (const k of pick) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

// Задача целиком: сначала главное, затем остальные поля, описание — в конце.
export function issueFull(issue) {
  const c = compact(issue) ?? {};
  const first = ['key', 'summary', 'status', 'type', 'priority', 'queue', 'assignee', 'createdBy', 'createdAt', 'updatedAt', 'resolution', 'deadline', 'parent'];
  const hidden = new Set(['id', 'version', 'statusStartTime', 'lastCommentUpdatedAt', 'commentWithoutExternalMessageCount', 'commentWithExternalMessageCount', 'votes', 'unique', 'aliases', 'previousStatusLastAssignee']);
  const out = {};
  for (const k of first) if (c[k] !== undefined) out[k] = c[k];
  for (const [k, v] of Object.entries(c)) if (!(k in out) && k !== 'description' && !hidden.has(k)) out[k] = v;
  if (c.description !== undefined) out.description = c.description;
  return out;
}

export function json(value) {
  return JSON.stringify(value, null, 1);
}

// Продолжительность: ISO 8601 (PT1H30M, P2W) как есть; «1h 30m», «2д 3ч», «90m» → ISO.
// Трекер принимает PnDTnHnMnS или отдельно PnW; неделя вместе с другими единицами
// переводится в 5 рабочих дней (как в Трекере: P6W = 30 рабочих дней).
const UNITS = [
  [/^(w|wk|wks|week|weeks|н|нед|недел[ьяи]|недель)$/u, 'W'],
  [/^(d|day|days|д|дн|дня|дней|день)$/u, 'D'],
  [/^(h|hr|hrs|hour|hours|ч|час|часа|часов)$/u, 'H'],
  [/^(m|min|mins|minute|minutes|м|мин|минут[аы]?)$/u, 'M'],
  [/^(s|sec|secs|second|seconds|с|сек|секунд[аы]?)$/u, 'S'],
];

export function isoDuration(input) {
  const s = String(input ?? '').trim();
  if (/^P\d+W$/i.test(s) || /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/i.test(s)) return s.toUpperCase();
  const parts = { W: 0, D: 0, H: 0, M: 0, S: 0 };
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zа-яё]+)/giu;
  let matched = '';
  let m;
  while ((m = re.exec(s))) {
    const word = m[2].toLowerCase();
    const unit = UNITS.find(([r]) => r.test(word))?.[1];
    if (!unit) return null;
    const n = Number(m[1].replace(',', '.'));
    // Дробные часы и минуты → минуты и секунды.
    if (!Number.isInteger(n)) {
      if (unit === 'H') parts.M += Math.round(n * 60);
      else if (unit === 'M') parts.S += Math.round(n * 60);
      else return null;
    } else parts[unit] += n;
    matched += m[0];
  }
  if (!matched || s.replace(/[\s,]+/g, '').length !== matched.replace(/[\s,]+/g, '').length) return null;
  if (parts.W && !parts.D && !parts.H && !parts.M && !parts.S) return `P${parts.W}W`;
  parts.D += parts.W * 5;
  const time = `${parts.H ? `${parts.H}H` : ''}${parts.M ? `${parts.M}M` : ''}${parts.S ? `${parts.S}S` : ''}`;
  if (!parts.D && !time) return null;
  return `P${parts.D ? `${parts.D}D` : ''}${time ? `T${time}` : ''}`;
}
