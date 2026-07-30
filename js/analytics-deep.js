/**
 * Deeper analytics: hour × item, category mix, channel mix, AOV.
 */

export function buildDeepAnalytics(orders = [], { from = 0, to = Date.now() } = {}) {
  const list = (orders || []).filter((o) => {
    const t = Number(o.timestamp) || 0;
    return t >= from && t <= to && (o.status || 'received') !== 'cancelled';
  });

  const revenue = list.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const aov = list.length ? Math.round(revenue / list.length) : 0;

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
  const byItem = new Map();
  const byCategory = new Map();
  const byChannel = new Map();
  const byStatus = new Map();

  for (const o of list) {
    const d = new Date(o.timestamp || 0);
    const h = d.getHours();
    byHour[h].orders += 1;
    byHour[h].revenue += Number(o.total) || 0;

    const ch = o.channel || 'dine_in';
    byChannel.set(ch, (byChannel.get(ch) || 0) + 1);

    const st = o.status || 'received';
    byStatus.set(st, (byStatus.get(st) || 0) + 1);

    for (const item of o.items || []) {
      const key = item.itemId || item.name || '?';
      const prev = byItem.get(key) || { id: key, name: item.name || key, qty: 0, revenue: 0 };
      prev.qty += Number(item.qty) || 0;
      prev.revenue += (Number(item.price) || 0) * (Number(item.qty) || 0);
      byItem.set(key, prev);

      const cat = item.category || 'other';
      byCategory.set(cat, (byCategory.get(cat) || 0) + (Number(item.qty) || 0));
    }
  }

  const topItems = [...byItem.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);
  const peakHour = byHour.slice().sort((a, b) => b.orders - a.orders)[0];

  return {
    orderCount: list.length,
    revenue,
    aov,
    byHour,
    topItems,
    byCategory: [...byCategory.entries()].map(([id, qty]) => ({ id, qty })).sort((a, b) => b.qty - a.qty),
    byChannel: [...byChannel.entries()].map(([id, count]) => ({ id, count })),
    byStatus: [...byStatus.entries()].map(([id, count]) => ({ id, count })),
    peakHour: peakHour?.hour ?? null,
    peakHourOrders: peakHour?.orders || 0,
  };
}

export function hourBarsHtml(byHour = []) {
  const max = Math.max(1, ...byHour.map((h) => h.orders));
  return byHour.map((h) => {
    const pct = Math.round((h.orders / max) * 100);
    return `<div class="deep-hour" title="${h.hour}時: ${h.orders}件"><i style="height:${pct}%"></i><span>${h.hour}</span></div>`;
  }).join('');
}
