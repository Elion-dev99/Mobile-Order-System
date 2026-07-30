/**
 * Order channels: dine-in / takeout / delivery.
 */

export const CHANNELS = [
  { id: 'dine_in', label: '店内', short: '席' },
  { id: 'takeout', label: 'テイクアウト', short: '持帰' },
  { id: 'delivery', label: 'デリバリー', short: '配達' },
];

export function getChannel(id) {
  return CHANNELS.find((c) => c.id === id) || CHANNELS[0];
}

export function channelLabel(id) {
  return getChannel(id).label;
}

export function resolveOrderChannel({ channel, tableNumber } = {}) {
  const c = String(channel || '').trim();
  if (CHANNELS.some((x) => x.id === c)) return c;
  const t = String(tableNumber || '');
  if (/^takeout/i.test(t) || t === 'TO') return 'takeout';
  if (/^delivery/i.test(t) || t === 'DL') return 'delivery';
  return 'dine_in';
}

export function channelTableCode(channel, tableNumber) {
  if (channel === 'takeout') return tableNumber && tableNumber !== '1' ? String(tableNumber) : 'TO';
  if (channel === 'delivery') return tableNumber && tableNumber !== '1' ? String(tableNumber) : 'DL';
  return String(tableNumber || '1');
}

const KEY = 'mos_order_channel';

export function getSelectedChannel() {
  try { return resolveOrderChannel({ channel: sessionStorage.getItem(KEY) }); } catch { return 'dine_in'; }
}

export function setSelectedChannel(channel) {
  const c = resolveOrderChannel({ channel });
  try { sessionStorage.setItem(KEY, c); } catch (_) {}
  return c;
}
