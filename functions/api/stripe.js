/**
 * Stripe — preparation stage (test mode, webhook queue, no auto Firestore write).
 *
 * Secrets (Cloudflare Pages):
 * - STRIPE_WEBHOOK_SECRET   — Dashboard → Webhooks → signing secret
 * - STRIPE_SECRET_KEY       — optional; fetch session details (sk_test_…)
 * - DISCORD_WEBHOOK_URL     — optional; payment notifications
 *
 * Webhook URL: https://mobile-order-system.pages.dev/api/stripe
 * Events: checkout.session.completed (recommended)
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  readStripeQueue,
  appendStripeEvent,
  updateStripeEvent,
} from './_stripe-ledger.js';

const SITE = 'https://mobile-order-system.pages.dev';

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function hex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const t = header.match(/(?:^|,)\s*t=(\d+)/)?.[1];
  const v1List = [...header.matchAll(/v1=([^,\s]+)/g)].map((m) => m[1]);
  if (!t || !v1List.length) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (age > 600) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  const expected = hex(sig);
  return v1List.some((v) => v === expected);
}

async function postDiscord(env, embed) {
  const url = env?.DISCORD_WEBHOOK_URL || '';
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'QuickOrder Stripe',
        embeds: [embed],
      }),
    });
  } catch (_) {}
}

function sessionRow(session, eventId) {
  const shopId = String(
    session.client_reference_id
    || session.metadata?.shopId
    || session.metadata?.shop_id
    || '',
  ).slice(0, 64);
  const planId = String(
    session.metadata?.planId
    || session.metadata?.plan_id
    || session.metadata?.plan
    || '',
  ).slice(0, 32);
  const billingCycle = String(
    session.metadata?.cycle
    || session.metadata?.billingCycle
    || session.metadata?.billing_cycle
    || '',
  ).slice(0, 16);
  const amount = session.amount_total != null ? Number(session.amount_total) : null;
  return {
    id: eventId || session.id,
    stripeEventId: eventId,
    sessionId: session.id,
    shopId,
    planId,
    billingCycle,
    email: String(session.customer_details?.email || session.customer_email || '').slice(0, 200),
    amount,
    currency: String(session.currency || 'jpy').toUpperCase(),
    mode: String(session.mode || ''),
    paymentStatus: String(session.payment_status || ''),
    livemode: session.livemode === true,
  };
}

async function fetchStripeSession(env, sessionId) {
  const key = String(env?.STRIPE_SECRET_KEY || '').trim();
  if (!key || !sessionId) return { ok: false, reason: 'no_api_key' };
  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, session: data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function handleWebhook(rawBody, request, env, cachesObj) {
  const secret = String(env?.STRIPE_WEBHOOK_SECRET || '').trim();
  const sig = request.headers.get('stripe-signature') || '';
  if (!secret) {
    return json({ ok: false, error: 'webhook_secret_not_configured' }, 503, request);
  }
  if (!await verifyStripeSignature(rawBody, sig, secret)) {
    return json({ ok: false, error: 'invalid_signature' }, 400, request);
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400, request);
  }
  const type = String(event.type || '');
  let row = null;
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    const session = event.data?.object || {};
    if (session.payment_status === 'paid' || session.status === 'complete') {
      row = sessionRow(session, event.id);
    }
  }
  if (!row) {
    return json({ ok: true, received: true, type, ignored: true }, 200, request);
  }
  const saved = await appendStripeEvent(cachesObj, row);
  await postDiscord(env, {
    title: row.livemode ? 'Stripe 支払い（本番）' : 'Stripe 支払い（テスト）',
    color: row.livemode ? 0x57f287 : 0x5865f2,
    fields: [
      { name: '店舗ID', value: row.shopId || '—', inline: true },
      { name: 'プラン', value: row.planId || '—', inline: true },
      { name: '金額', value: row.amount != null ? `${row.amount} ${row.currency}` : '—', inline: true },
      { name: 'メール', value: row.email || '—', inline: false },
      { name: 'Session', value: row.sessionId || '—', inline: false },
    ],
    footer: { text: 'Ops で店舗「課金中」ON または admin ?billing=success' },
  });
  return json({
    ok: true,
    received: true,
    type,
    queued: true,
    row,
    persisted: saved.persisted !== false,
  }, 200, request);
}

export async function onRequestGet(context) {
  const { env, caches, request } = context;
  const q = await readStripeQueue(caches);
  const pending = q.events.filter((e) => e.status === 'pending');
  const url = new URL(request.url);
  const shopFilter = String(url.searchParams.get('shop') || url.searchParams.get('shopId') || '').trim().slice(0, 64);

  let shopBilling = null;
  if (shopFilter) {
    const forShop = q.events.filter((e) => String(e.shopId || '') === shopFilter);
    const pendingForShop = forShop.filter((e) => e.status === 'pending');
    const paid = forShop.filter((e) => e.paymentStatus === 'paid' || e.amount != null);
    const last = paid[0];
    shopBilling = {
      shopId: shopFilter,
      pendingPayment: pendingForShop.length > 0,
      pendingCount: pendingForShop.length,
      lastPayment: last
        ? {
          amount: last.amount,
          currency: last.currency,
          at: last.at,
          planId: last.planId,
          sessionId: last.sessionId,
        }
        : null,
    };
  }

  return json({
    ok: true,
    service: 'quickorder-stripe-prep',
    stage: 'preparation',
    webhookUrl: `${SITE}/api/stripe`,
    configured: {
      webhookSecret: !!(env?.STRIPE_WEBHOOK_SECRET),
      apiKey: !!(env?.STRIPE_SECRET_KEY),
      discord: !!(env?.DISCORD_WEBHOOK_URL),
      opsSecret: !!getOpsSecret(env),
    },
    mode: String(env?.STRIPE_MODE || 'test'),
    pendingCount: pending.length,
    recentPending: pending.slice(0, 8),
    shop: shopBilling,
    docs: 'docs/stripe-setup.md',
  }, 200, context.request);
}

export async function onRequestPost(context) {
  const { request, env, caches } = context;
  const j = (data, status = 200) => json(data, status, request);
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  if (sig) {
    return handleWebhook(rawBody, request, env, caches);
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return j({ ok: false, error: 'invalid_json' }, 400);
  }

  const gate = requireOpsSecret(request, env, body, j);
  if (!gate.ok) return gate.response;

  const action = String(body.action || 'list_pending');

  if (action === 'list_pending') {
    const q = await readStripeQueue(caches);
    const pending = q.events.filter((e) => e.status === 'pending');
    return j({ ok: true, action, pending, total: q.events.length });
  }

  if (action === 'dismiss') {
    const id = String(body.id || body.eventId || '');
    if (!id) return j({ ok: false, error: 'missing_id' }, 400);
    await updateStripeEvent(caches, id, { status: 'dismissed', dismissedBy: 'ops' });
    return j({ ok: true, action, id });
  }

  if (action === 'mark_applied') {
    const id = String(body.id || body.eventId || '');
    if (!id) return j({ ok: false, error: 'missing_id' }, 400);
    await updateStripeEvent(caches, id, {
      status: 'applied',
      appliedBy: body.appliedBy || 'ops',
      appliedShopId: body.shopId || '',
    });
    return j({ ok: true, action, id });
  }

  if (action === 'verify_session') {
    const sessionId = String(body.sessionId || body.session_id || '');
    const fetched = await fetchStripeSession(env, sessionId);
    if (!fetched.ok) {
      return j({ ok: false, action, ...fetched }, fetched.status === 0 ? 502 : 400);
    }
    const row = sessionRow(fetched.session, `verify_${sessionId}`);
    return j({ ok: true, action, row, session: fetched.session });
  }

  return j({ ok: false, error: 'unknown_action', actions: ['list_pending', 'dismiss', 'mark_applied', 'verify_session'] }, 400);
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}
