/**
 * Kitchen / receipt printer adapters.
 * Default: browser print. Network printers are stub endpoints.
 */

export function getPrinterConfig(shop = {}) {
  return {
    mode: shop.printerMode || 'browser', // browser | epson_stub | star_stub
    autoPrintOnOrder: !!shop.autoPrintOnOrder,
    autoPrintOnStatus: shop.autoPrintStatuses || ['cooking'],
    deviceIp: shop.printerIp || '',
  };
}

export function buildKitchenTicketHtml(order, shop = {}) {
  const lines = (order.items || []).map((i) => {
    const opts = [];
    if (i.customizations) Object.values(i.customizations).forEach((v) => opts.push(v));
    if (i.toggles) Object.entries(i.toggles).forEach(([k, on]) => { if (on) opts.push(k); });
    return `<div style="margin:6px 0;font-size:18px;"><strong>${i.qty}×</strong> ${escapeHtml(i.name)}${opts.length ? `<div style="font-size:13px;color:#444;">${escapeHtml(opts.join(', '))}</div>` : ''}</div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kitchen ${escapeHtml(order.id)}</title>
<style>body{font-family:monospace;padding:12px;} h1{font-size:22px;margin:0 0 8px;} .meta{color:#333;font-size:14px;}</style></head><body>
<h1>${escapeHtml(shop.name || 'QuickOrder')} / 席 ${escapeHtml(String(order.tableNumber ?? '-'))}</h1>
<div class="meta">${escapeHtml(order.id)} · ${new Date(order.timestamp || Date.now()).toLocaleString('ja-JP')} · ${escapeHtml(order.channel || 'dine_in')}</div>
<hr>${lines}<hr>
<div>合計 ¥${Number(order.total || 0).toLocaleString('ja-JP')}</div>
<script>window.onload=()=>{try{window.print();}catch(e){} setTimeout(()=>window.close(),400);};</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function printKitchenTicket(order, shop = {}) {
  const cfg = getPrinterConfig(shop);
  if (cfg.mode !== 'browser') {
    // Stub network print job
    return {
      ok: true,
      stub: true,
      mode: cfg.mode,
      deviceIp: cfg.deviceIp,
      jobId: 'PRINT-' + Math.random().toString(36).slice(2, 8),
      note: 'Network printer adapter not wired; use browser fallback',
    };
  }
  const html = buildKitchenTicketHtml(order, shop);
  const w = window.open('', '_blank', 'noopener,noreferrer,width=420,height=640');
  if (!w) return { ok: false, error: 'popup_blocked' };
  w.document.write(html);
  w.document.close();
  return { ok: true, mode: 'browser' };
}

export async function maybeAutoPrint(order, shop, event = 'order') {
  const cfg = getPrinterConfig(shop);
  if (!cfg.autoPrintOnOrder && event === 'order') return { skipped: true };
  if (event === 'status' && !cfg.autoPrintStatuses?.includes(order?.status)) {
    return { skipped: true };
  }
  return printKitchenTicket(order, shop);
}
