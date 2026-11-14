// JajiGo Paystack payments, settlement hooks, wallets and payment settings
// IMPORTANT: load this in server.js BEFORE shopping.js (its guards run first).
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

module.exports = function payments({ app, db, requireAuth, requireRole, wrap, validate }) {
  const KEY = process.env.PAYSTACK_SECRET_KEY;                    // secret: only ever on the server
  const APP_URL = (process.env.APP_URL || 'https://jajigo.onrender.com').replace(/\/$/, '');
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const uuid = (v) => { if (!z.string().uuid().safeParse(v).success) throw fail(400, 'Invalid id'); return v; };
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });
  const log = (actor_id, action, entity, entity_id, details) => db.from('financial_audit_log').insert({ actor_id, action, entity, entity_id: String(entity_id), details });

  async function paystack(path, opt = {}) {
    if (!KEY) throw fail(503, 'Online payment is not set up yet');
    const r = await fetch('https://api.paystack.co' + path, { ...opt, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status) throw fail(502, j.message || 'Paystack could not be reached');
    return j.data;
  }
  async function paymentMode() {
    const { data } = await db.from('platform_settings').select('value').eq('key', 'payment_mode_shopping').maybeSingle();
    return data && data.value === 'provider_collects' ? 'provider_collects' : 'jajigo_collects';
  }
  // Confirm with Paystack, then let the database settle it (safe to repeat)
  async function confirmAndSettle(reference) {
    const d = await paystack('/transaction/verify/' + encodeURIComponent(reference));
    if (d.reference !== reference) throw fail(400, 'Reference mismatch');
    if (d.status === 'success') {
      if (d.currency !== 'NGN') { await log(null, 'payment_wrong_currency', 'payment_records', reference, { currency: d.currency }); return { status: 'failed' }; }
      const { data, error } = await db.rpc('settle_payment', { p_reference: reference, p_amount: d.amount, p_channel: d.channel || null, p_raw: d });
      if (error) throw error;
      return data;
    }
    if (d.status === 'failed') await db.from('payment_records').update({ status: 'failed' }).eq('reference', reference).eq('status', 'initialized');
    return { status: d.status };
  }

  app.get('/api/payments/mode', wrap(async (req, res) => res.json({ shopping: await paymentMode() })));

  // ---------- Start a payment: the amount always comes from the order in the database ----------
  app.post('/api/payments/initialize', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ order_id: z.string().uuid() }), req.body);
    if ((await paymentMode()) !== 'jajigo_collects') throw fail(400, 'This marketplace collects payment directly. Pay the shop on delivery.');
    const { data: o } = await db.from('orders').select('id, status, payment_status, total_kobo').eq('id', b.order_id).eq('customer_id', req.user.id).maybeSingle();
    if (!o) throw fail(404, 'Order not found');
    if (o.payment_status === 'paid') throw fail(400, 'This order is already paid');
    if (['cancelled', 'rejected', 'completed'].includes(o.status)) throw fail(400, 'This order can no longer be paid');
    const reference = 'JG' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    const { error } = await db.from('payment_records').insert({ reference, marketplace: 'shopping', order_id: o.id, customer_id: req.user.id, amount_kobo: o.total_kobo, mode: 'jajigo_collects' });
    if (error) throw error;
    const d = await paystack('/transaction/initialize', { method: 'POST', body: JSON.stringify({
      email: req.user.email, amount: o.total_kobo, currency: 'NGN', reference, callback_url: APP_URL + '/', metadata: { order_id: o.id } }) });
    res.json({ authorization_url: d.authorization_url, reference });
  }));

  // ---------- The customer comes back from Paystack: never trust the return, verify it ----------
  app.get('/api/payments/verify/:reference', requireAuth, limiter, wrap(async (req, res) => {
    const ref = String(req.params.reference).slice(0, 80);
    const { data: p } = await db.from('payment_records').select('reference, status, order_id').eq('reference', ref).eq('customer_id', req.user.id).maybeSingle();
    if (!p) throw fail(404, 'Payment not found');
    if (p.status === 'success') return res.json({ status: 'success', order_id: p.order_id });
    const r = await confirmAndSettle(ref);
    console.log('payment verify', ref, r.status);
    const ok = ['settled', 'already_settled', 'success_needs_refund'].includes(r.status);
    res.json({ status: ok ? 'success' : r.status, order_id: p.order_id, note: r.status === 'success_needs_refund' ? 'Your order was cancelled. Contact support for a refund.' : undefined });
  }));

  // ---------- Self-check: if the customer paid but the return/webhook was missed, settle it when the order is opened ----------
  app.post('/api/payments/check-order/:orderId', requireAuth, limiter, wrap(async (req, res) => {
    const id = uuid(req.params.orderId);
    const { data: o } = await db.from('orders').select('id, payment_status').eq('id', id).eq('customer_id', req.user.id).maybeSingle();
    if (!o) throw fail(404, 'Order not found');
    if (o.payment_status === 'paid') return res.json({ status: 'paid' });
    const since = new Date(Date.now() - 48 * 3600000).toISOString();
    const { data: list } = await db.from('payment_records').select('reference').eq('order_id', id).eq('status', 'initialized').gte('created_at', since).order('created_at', { ascending: false }).limit(3);
    let last = 'none';
    for (const p of list || []) {
      try {
        const r = await confirmAndSettle(p.reference);
        last = r.status;
        if (['settled', 'already_settled', 'success_needs_refund'].includes(r.status)) return res.json({ status: 'paid' });
      } catch (e) { console.error('check-order failed', p.reference, e.message); last = 'error'; }
    }
    res.json({ status: last });
  }));

  // ---------- Paystack calls us (signature checked on the raw request body) ----------
  app.post('/api/payments/webhook', wrap(async (req, res) => {
    if (!KEY || !req.rawBody) return res.sendStatus(503);
    const sig = String(req.headers['x-paystack-signature'] || '');
    const expected = crypto.createHmac('sha512', KEY).update(req.rawBody).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
    const ev = req.body || {};
    if (ev.event === 'charge.success' && ev.data && ev.data.reference) {
      try { await confirmAndSettle(String(ev.data.reference)); } catch (e) { console.error('webhook settle failed', e.message); return res.sendStatus(500); } // Paystack will retry
    }
    res.sendStatus(200);
  }));

  // ---------- Sellers cannot accept an unpaid order when JajiGo collects the money ----------
  app.patch('/api/seller/orders/:id/status', requireAuth, wrap(async (req, res, next) => {
    if (!req.body || req.body.status !== 'accepted' || !z.string().uuid().safeParse(req.params.id).success) return next();
    const { data: o } = await db.from('orders').select('payment_status, businesses(owner_id)').eq('id', req.params.id).maybeSingle();
    if (o && o.businesses && o.businesses.owner_id === req.user.id && o.payment_status !== 'paid' && (await paymentMode()) === 'jajigo_collects')
      throw fail(400, 'The customer has not paid yet. Wait for payment before accepting.');
    next();
  }));
  // add paid/unpaid to the seller's order list without touching shopping.js
  app.get('/api/seller/orders', requireAuth, (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      (async () => {
        try {
          if (body && Array.isArray(body.orders) && body.orders.length) {
            const { data } = await db.from('orders').select('id, payment_status').in('id', body.orders.map((o) => o.id));
            const m = Object.fromEntries((data || []).map((x) => [x.id, x.payment_status]));
            body.orders.forEach((o) => { o.payment_status = m[o.id] || 'unpaid'; });
          }
        } catch (e) { /* show the list anyway */ }
        send(body);
      })();
      return res;
    };
    next();
  });

  // ---------- Wallets (read only; money only moves inside the database functions) ----------
  app.get('/api/wallet', requireAuth, wrap(async (req, res) => {
    const { data: shop } = await db.from('businesses').select('id').eq('owner_id', req.user.id).eq('marketplace', 'shopping').maybeSingle();
    if (!shop) throw fail(403, 'Register a Shopping seller business first');
    const { data: w } = await db.from('wallet_accounts').select('id, pending_kobo, available_kobo').eq('business_id', shop.id).maybeSingle();
    const { data: tx } = w ? await db.from('wallet_transactions').select('kind, amount_kobo, note, created_at').eq('wallet_id', w.id).order('created_at', { ascending: false }).limit(30) : { data: [] };
    const { data: cr } = await db.from('commission_records').select('gross_kobo, commission_kobo, mode, settled').eq('business_id', shop.id);
    const sum = (l, f) => (l || []).reduce((s, x) => s + f(x), 0);
    res.json({
      pending_kobo: w ? w.pending_kobo : 0, available_kobo: w ? w.available_kobo : 0, transactions: tx || [],
      total_sales_kobo: sum(cr, (x) => x.gross_kobo), commission_paid_kobo: sum(cr, (x) => x.commission_kobo),
      commission_owed_kobo: sum((cr || []).filter((x) => x.mode === 'provider_collects' && !x.settled), (x) => x.commission_kobo),
    });
  }));
  app.get('/api/wallet/customer', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('payment_records').select('amount_kobo, channel, verified_at, order_id, status').eq('customer_id', req.user.id).eq('status', 'success').order('verified_at', { ascending: false }).limit(100);
    const d = new Date(Date.now() + 3600000);                       // Nigeria time
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3600000;
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3600000, year = Date.UTC(d.getUTCFullYear(), 0, 1) - 3600000;
    const tot = (from) => (data || []).filter((p) => new Date(p.verified_at).getTime() >= from).reduce((s, p) => s + p.amount_kobo, 0);
    res.json({ today_kobo: tot(day), month_kobo: tot(month), year_kobo: tot(year), payments: (data || []).slice(0, 20) });
  }));

  // ---------- Admin: payment settings ----------
  app.get('/api/admin/payment-settings', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data } = await db.from('platform_settings').select('key, value').in('key', ['payment_mode_shopping', 'commission_percent_shopping']);
    const m = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
    res.json({ mode: m.payment_mode_shopping || 'jajigo_collects', commission_percent: Number(m.commission_percent_shopping ?? 10), paystack_configured: !!KEY });
  }));
  app.put('/api/admin/payment-settings', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ mode: z.enum(['jajigo_collects', 'provider_collects']), commission_percent: z.number().min(0).max(50) }), req.body);
    const now = new Date().toISOString();
    await db.from('platform_settings').upsert([{ key: 'payment_mode_shopping', value: b.mode, updated_at: now }, { key: 'commission_percent_shopping', value: b.commission_percent, updated_at: now }], { onConflict: 'key' });
    await log(req.user.id, 'payment_settings_changed', 'platform_settings', 'shopping', b);
    res.json({ ok: true });
  }));
};
