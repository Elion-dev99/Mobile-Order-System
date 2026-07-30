/**
 * Edge copy of weekly/one-shot schedule evaluation (keep in sync with js/maint-schedule.js).
 */

export const SCHEDULE_DEFAULT_MESSAGE = '定期メンテナンス中です。ご注文はレジにてお願いいたします。';

export function defaultSchedule() {
  return {
    enabled: false,
    timezone: 'Asia/Tokyo',
    days: [1, 2, 3, 4, 5],
    start: '03:00',
    end: '04:00',
    message: SCHEDULE_DEFAULT_MESSAGE,
    onceStart: null,
    onceEnd: null,
  };
}

export function normalizeSchedule(raw = {}) {
  const base = defaultSchedule();
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))].sort()
    : base.days;
  const start = normalizeHm(raw.start, base.start);
  const end = normalizeHm(raw.end, base.end);
  return {
    enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1,
    timezone: String(raw.timezone || base.timezone).slice(0, 64) || base.timezone,
    days,
    start,
    end,
    message: String(raw.message || base.message).trim().slice(0, 200) || base.message,
    onceStart: parseMaybeTs(raw.onceStart),
    onceEnd: parseMaybeTs(raw.onceEnd),
  };
}

function parseMaybeTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function normalizeHm(v, fallback) {
  const s = String(v || fallback || '00:00');
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback || '00:00';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function hmToMinutes(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return (h * 60) + m;
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday];
  return {
    weekday: wd == null ? date.getDay() : wd,
    hour: Number(map.hour) || 0,
    minute: Number(map.minute) || 0,
  };
}

export function evaluateSchedule(rawSchedule, nowMs = Date.now()) {
  const schedule = normalizeSchedule(rawSchedule || {});
  if (!schedule.enabled) {
    return { active: false, reason: 'disabled', message: schedule.message, schedule };
  }
  const now = Number(nowMs) || Date.now();
  if (schedule.onceStart != null && schedule.onceEnd != null) {
    if (now >= schedule.onceStart && now < schedule.onceEnd) {
      return { active: true, reason: 'once', message: schedule.message, schedule };
    }
  }
  if (!schedule.days.length) {
    return { active: false, reason: 'no_days', message: schedule.message, schedule };
  }
  const parts = zonedParts(new Date(now), schedule.timezone);
  const mins = parts.hour * 60 + parts.minute;
  const startM = hmToMinutes(schedule.start);
  const endM = hmToMinutes(schedule.end);
  let inWeekly = false;
  if (startM !== endM) {
    if (startM < endM) {
      inWeekly = schedule.days.includes(parts.weekday) && mins >= startM && mins < endM;
    } else if (mins >= startM && schedule.days.includes(parts.weekday)) {
      inWeekly = true;
    } else if (mins < endM) {
      const prev = (parts.weekday + 6) % 7;
      if (schedule.days.includes(prev)) inWeekly = true;
    }
  }
  if (inWeekly) {
    return { active: true, reason: 'weekly', message: schedule.message, schedule };
  }
  return { active: false, reason: 'outside', message: schedule.message, schedule };
}
