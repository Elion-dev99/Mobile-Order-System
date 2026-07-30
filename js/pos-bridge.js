/**
 * POS bridge — adapter shape for Square / Airレジ / Toast style sync.
 * No live POS credentials; methods return structured stubs.
 */

const STATE_KEY = 'mos_pos_bridge';

export function getPosConfig(shop = {}) {
  return {
    provider: shop.posProvider || 'none', // none | square_stub | airregi_stub | generic
    locationId: shop.posLocationId || '',
    syncMenu: shop.posSyncMenu !== false,
    syncOrders: shop.posSyncOrders !== false,
    syncInventory: shop.posSyncInventory !== false,
    lastSyncAt: shop.posLastSyncAt || null,
  };
}

export function getPosLocalState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; }
}

function saveLocal(partial) {
  const next = { ...getPosLocalState(), ...partial, updatedAt: Date.now() };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

export async function connectPos({ provider = 'square_stub', locationId = '' } = {}) {
  // Real OAuth goes here later
  return saveLocal({
    connected: provider !== 'none',
    provider,
    locationId,
    status: provider === 'none' ? 'disconnected' : 'stub_connected',
  });
}

export async function pushOrderToPos(order, shop) {
  const cfg = getPosConfig(shop);
  if (cfg.provider === 'none') {
    return { ok: false, skipped: true, reason: 'pos_not_configured' };
  }
  const ticket = {
    externalId: 'POS-' + (order?.id || Math.random().toString(36).slice(2, 8)),
    orderId: order?.id,
    total: order?.total,
    stub: true,
    pushedAt: Date.now(),
  };
  const state = saveLocal({ lastOrderPush: ticket });
  return { ok: true, ticket, state, stub: true };
}

export async function pullInventoryFromPos(shop) {
  const cfg = getPosConfig(shop);
  if (cfg.provider === 'none') return { ok: false, skipped: true, stock: {} };
  // Stub empty delta — wire real inventory later
  return {
    ok: true,
    stub: true,
    stock: {},
    note: 'POS inventory pull not wired; returns empty delta',
    at: Date.now(),
  };
}

export async function syncMenuToPos(menu, shop) {
  const cfg = getPosConfig(shop);
  if (cfg.provider === 'none') return { ok: false, skipped: true };
  return {
    ok: true,
    stub: true,
    itemCount: menu?.items?.length || 0,
    provider: cfg.provider,
    at: Date.now(),
  };
}

export function posStatusLabel(shop) {
  const local = getPosLocalState();
  if (local.status === 'stub_connected' || (shop?.posProvider && shop.posProvider !== 'none')) {
    return `POS: ${(shop?.posProvider || local.provider || 'stub')}（接続形のみ）`;
  }
  return 'POS: 未接続';
}
