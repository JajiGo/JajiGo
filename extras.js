// JajiGo Morning Rush + admin-controlled home slider banners
// IMPORTANT: this file must be loaded in server.js BEFORE shopping.js (its guards run first).
const crypto = require('crypto');
const { z } = require('zod');

module.exports = function extras({ app, db, requireAuth, requireRole, wrap, validate, SUPABASE_URL }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const uuid = (v) => { if (!z.string().uuid().safeParse(v).success) throw fail(400, 'Invalid id'); return v; };
  const notify = (user_id, title, body, kind) => db.from('notifications').insert({ user_id, title, body, kind });
  const log = (actor_id, action, entity, entity_id, details) => db.from('financial_audit_log').insert({ actor_id, action, entity, entity_id: String(entity_id), details });
  const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmt = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  // Nigeria time is UTC+1 all year
  const lagosNow = () => { const d = new Date(Date.now() + 3600000); return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), dayStart: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3600000) }; };

  async function globalWindow() {
    const { data } = await db.from('platform_settings').select('value').eq('key', 'morning_rush_window').maybeSingle();
    const v = (data && data.value) || {};
    return { start: HHMM.test(v.start) ? v.start : '06:00', end: HHMM.test(v.end) ? v.end : '10:00' };
  }

  // Is each shop able to take breakfast orders right now?
  async function shopStatus(ids) {
    const g = await globalWindow(), now = lagosNow(), out = {};
    const { data: shops } = await db.from('businesses')
      .select('id, name, owner_id, verification, morning_rush_approved, morning_enabled, morning_paused, morning_open, morning_close, morning_prep_minutes, morning_packaging_fee_kobo, morning_max_orders').in('id', ids);
    for (const s of shops || []) {
      const lo = Math.max(toMin(g.start), toMin(s.morning_open)), hi = Math.min(toMin(g.end), toMin(s.morning_close));
      let reason = null;
      if (s.verification !== 'approved' || !s.morning_rush_approved || !s.morning_enabled) reason = 'not taking breakfast orders';
      else if (s.morning_paused) reason = 'paused for now';
      else if (now.min < lo || now.min >= hi) reason = `closed (breakfast is ${fmt(lo)} to ${fmt(hi)})`;
      else if (s.morning_max_orders) {
        const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', s.id).eq('is_morning_rush', true)
          .gte('created_at', now.dayStart.toISOString()).not('status', 'in', '(rejected,cancelled)');
        if ((count || 0) >= s.morning_max_orders) reason = 'at its breakfast order limit for today';
      }
      out[s.id] = { ok: !reason, reason, shop: s, until: fmt(hi) };
    }
    return out;
  }
  const closedMsg = (st, id) => `Morning Rush: ${st[id] ? st[id].shop.name : 'this shop'} is ${st[id] ? st[id].reason : 'not available'}.`;

  // ---------- GUARDS (run before the normal shopping routes) ----------
  // 1) Breakfast items cannot be added to the cart unless approved and the shop is open for breakfast
  app.put('/api/shopping/cart', wrap(async (req, res, next) => {
    const pid = req.body && req.body.product_id;
    if (!z.string().uuid().safeParse(pid).success || !(Number(req.body.quantity) > 0)) return next();
    const { data: p } = await db.from('products').select('id, business_id, is_morning_rush, morning_rush_status').eq('id', pid).maybeSingle();
    if (p && p.is_morning_rush) {
      if (p.morning_rush_status !== 'approved') throw fail(400, 'This breakfast item is not approved yet');
      const st = await shopStatus([p.business_id]);
      if (!st[p.business_id] || !st[p.business_id].ok) throw fail(400, closedMsg(st, p.business_id));
    }
    next();
  }));
  // 2) Same checks again at checkout (the cart may be old)
  app.post('/api/shopping/orders', requireAuth, wrap(async (req, res, next) => {
    const { data: cart } = await db.from('shopping_cart_items').select('products(id, business_id, is_morning_rush, morning_rush_status)').eq('customer_id', req.user.id);
    const morning = (cart || []).map((c) => c.products).filter((p) => p && p.is_morning_rush);
    if (morning.length) {
      if (morning.some((p) => p.morning_rush_status !== 'approved')) throw fail(400, 'A breakfast item in your cart is not approved. Please remove it.');
      const ids = [...new Set(morning.map((p) => p.business_id))], st = await shopStatus(ids);
      for (const id of ids) if (!st[id] || !st[id].ok) throw fail(400, closedMsg(st, id) + ' Remove those items to continue.');
    }
    next();
  }));
  // 3) Breakfast items only appear in the Morning Rush page, not in normal shop and product lists
  app.use(['/api/shopping/products', '/api/shopping/shops'], (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (b) => { if (b && Array.isArray(b.products)) b.products = b.products.filter((p) => !p.is_morning_rush); return send(b); };
    next();
  });

  // ---------- PUBLIC: Morning Rush page ----------
  app.get('/api/morning', wrap(async (req, res) => {
    const g = await globalWindow();
    const { data: shops } = await db.from('businesses').select('id').eq('marketplace', 'shopping').eq('verification', 'approved').eq('morning_rush_approved', true).eq('morning_enabled', true);
    const ids = (shops || []).map((s) => s.id), st = ids.length ? await shopStatus(ids) : {};
    const open = ids.filter((i) => st[i] && st[i].ok);
    let products = [];
    if (open.length) {
      const { data } = await db.from('products').select('id, business_id, name, description, price_kobo, discount_percent, stock, product_images(image_url, sort_order)')
        .in('business_id', open).eq('is_morning_rush', true).eq('morning_rush_status', 'approved').eq('is_available', true).eq('is_approved', true).gt('stock', 0);
      products = (data || []).map((p) => ({ ...p, final_price_kobo: Math.round(p.price_kobo * (100 - (p.discount_percent || 0)) / 100) }));
    }
    res.json({ window: g, shops: open.map((i) => ({ id: i, name: st[i].shop.name, prep_minutes: st[i].shop.morning_prep_minutes, packaging_fee_kobo: st[i].shop.morning_packaging_fee_kobo, open_until: st[i].until })), products });
  }));

  // ---------- SELLER ----------
  async function myShop(uid) {
    const { data } = await db.from('businesses').select('*').eq('owner_id', uid).eq('marketplace', 'shopping').maybeSingle();
    if (!data) throw fail(403, 'Register a Shopping seller business first');
    return data;
  }
  app.get('/api/seller/morning', requireAuth, wrap(async (req, res) => {
    const s = await myShop(req.user.id);
    const { data: apps } = await db.from('morning_rush_applications').select('status, admin_note, created_at').eq('business_id', s.id).order('created_at', { ascending: false }).limit(1);
    const { data: products } = await db.from('products').select('id, name, is_morning_rush, morning_rush_status').eq('business_id', s.id).order('created_at', { ascending: false });
    res.json({ shop_approved: s.verification === 'approved', approved: s.morning_rush_approved, application: (apps || [])[0] || null, window: await globalWindow(),
      settings: { enabled: s.morning_enabled, paused: s.morning_paused, open: s.morning_open, close: s.morning_close, prep_minutes: s.morning_prep_minutes, packaging_fee_kobo: s.morning_packaging_fee_kobo, max_orders: s.morning_max_orders },
      products: products || [] });
  }));
  app.post('/api/seller/morning/apply', requireAuth, wrap(async (req, res) => {
    const s = await myShop(req.user.id);
    if (s.verification !== 'approved') throw fail(403, 'Your shop must be approved first');
    if (s.morning_rush_approved) throw fail(400, 'You are already approved for Morning Rush');
    const { data: open } = await db.from('morning_rush_applications').select('id').eq('business_id', s.id).eq('status', 'pending').maybeSingle();
    if (open) throw fail(409, 'Your application is already waiting for review');
    await db.from('morning_rush_applications').insert({ business_id: s.id });
    res.status(201).json({ ok: true });
  }));
  app.put('/api/seller/morning/settings', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ enabled: z.boolean(), paused: z.boolean(), open: z.string().regex(HHMM), close: z.string().regex(HHMM),
      prep_minutes: z.number().int().min(1).max(240), packaging_fee_kobo: z.number().int().min(0).max(1000000), max_orders: z.number().int().min(1).max(1000).nullable() }), req.body);
    const s = await myShop(req.user.id);
    if (!s.morning_rush_approved) throw fail(403, 'You are not approved for Morning Rush yet');
    if (toMin(b.open) >= toMin(b.close)) throw fail(400, 'Opening time must be before closing time');
    await db.from('businesses').update({ morning_enabled: b.enabled, morning_paused: b.paused, morning_open: b.open, morning_close: b.close,
      morning_prep_minutes: b.prep_minutes, morning_packaging_fee_kobo: b.packaging_fee_kobo, morning_max_orders: b.max_orders }).eq('id', s.id);
    res.json({ ok: true });
  }));
  app.patch('/api/seller/products/:id/morning', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ is_morning_rush: z.boolean() }), req.body);
    const s = await myShop(req.user.id);
    if (!s.morning_rush_approved) throw fail(403, 'You are not approved for Morning Rush yet');
    // marking as breakfast hides the product until an admin approves the breakfast listing
    const patch = b.is_morning_rush ? { is_morning_rush: true, morning_rush_status: 'pending', is_approved: false } : { is_morning_rush: false, morning_rush_status: null, is_approved: true };
    const { data } = await db.from('products').update(patch).eq('id', uuid(req.params.id)).eq('business_id', s.id).select('id').maybeSingle();
    if (!data) throw fail(404, 'Product not found');
    res.json({ ok: true });
  }));

  // ---------- ADMIN: Morning Rush ----------
  app.get('/api/admin/morning', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data: applications } = await db.from('morning_rush_applications').select('id, created_at, businesses(id, name, address)').eq('status', 'pending').order('created_at');
    const { data: products } = await db.from('products').select('id, name, price_kobo, businesses(name)').eq('morning_rush_status', 'pending').order('created_at');
    res.json({ applications: applications || [], products: products || [], window: await globalWindow() });
  }));
  app.patch('/api/admin/morning/applications/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(300).optional() }), req.body);
    if (b.status === 'rejected' && !b.note) throw fail(400, 'A reason is required');
    const { data: a } = await db.from('morning_rush_applications').update({ status: b.status, admin_note: b.note || null }).eq('id', uuid(req.params.id)).eq('status', 'pending').select('business_id').maybeSingle();
    if (!a) throw fail(404, 'Application not found');
    if (b.status === 'approved') await db.from('businesses').update({ morning_rush_approved: true }).eq('id', a.business_id);
    const { data: biz } = await db.from('businesses').select('owner_id, name').eq('id', a.business_id).single();
    await notify(biz.owner_id, `Morning Rush application ${b.status}`, b.note || (b.status === 'approved' ? 'Set your breakfast hours and mark your breakfast products.' : null), 'morning_rush');
    await log(req.user.id, 'morning_application_' + b.status, 'businesses', a.business_id, b);
    res.json({ ok: true });
  }));
  app.patch('/api/admin/morning/products/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(300).optional() }), req.body);
    if (b.status === 'rejected' && !b.note) throw fail(400, 'A reason is required');
    const { data: p } = await db.from('products').update({ morning_rush_status: b.status, is_approved: b.status === 'approved' })
      .eq('id', uuid(req.params.id)).eq('morning_rush_status', 'pending').select('id, name, business_id').maybeSingle();
    if (!p) throw fail(404, 'Product not found');
    const { data: biz } = await db.from('businesses').select('owner_id').eq('id', p.business_id).single();
    await notify(biz.owner_id, `Breakfast item "${p.name}" ${b.status}`, b.note || null, 'morning_rush');
    await log(req.user.id, 'morning_product_' + b.status, 'products', p.id, b);
    res.json({ ok: true });
  }));
  app.put('/api/admin/morning/window', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }), req.body);
    if (toMin(b.start) >= toMin(b.end)) throw fail(400, 'Start must be before end');
    await db.from('platform_settings').upsert({ key: 'morning_rush_window', value: b, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    await log(req.user.id, 'morning_window_changed', 'platform_settings', 'morning_rush_window', b);
    res.json({ ok: true });
  }));

  // ---------- NOTIFICATIONS (bell) ----------
  app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('notifications').select('id, title, body, kind, is_read, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(40);
    res.json({ notifications: data || [], unread: (data || []).filter((n) => !n.is_read).length });
  }));
  app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
    await db.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
    res.json({ ok: true });
  }));

  // ---------- HOME SLIDER BANNERS ----------
  const BUCKET = 'banners', PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
  async function verifyBanner(url) {
    if (!url.startsWith(PREFIX)) throw fail(400, 'Image must be uploaded through JajiGo');
    const path = decodeURIComponent(url.slice(PREFIX.length));
    if (path.includes('..') || path.includes('/')) throw fail(400, 'Invalid image');
    const { data, error } = await db.storage.from(BUCKET).download(path);
    if (error || !data) throw fail(400, 'Image upload not found. Please upload it again.');
    const buf = Buffer.from(await data.arrayBuffer());
    const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
    if (buf.length > 3 * 1024 * 1024 || !(jpg || png || webp)) { await db.storage.from(BUCKET).remove([path]); throw fail(400, 'Use a real JPEG, PNG or WebP image under 3 MB'); }
    return path;
  }

  app.get('/api/banners', wrap(async (req, res) => {
    const { data } = await db.from('banners').select('id, image_url, title, product_id, products(is_available, is_approved, businesses(verification))')
      .eq('is_active', true).order('sort_order').order('created_at', { ascending: false }).limit(12);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ banners: (data || []).map((b) => { const p = b.products; const live = p && p.is_available && p.is_approved && p.businesses && p.businesses.verification === 'approved';
      return { id: b.id, image_url: b.image_url, title: b.title, product_id: live ? b.product_id : null }; }) });
  }));
  const admin = [requireAuth, requireRole('admin')];
  app.post('/api/admin/banners/upload-url', ...admin, wrap(async (req, res) => {
    const b = validate(z.object({ ext: z.enum(['jpg', 'png', 'webp']) }), req.body);
    const path = `${crypto.randomUUID()}.${b.ext}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    res.json({ signed_url: data.signedUrl, public_url: PREFIX + path });
  }));
  app.get('/api/admin/banners', ...admin, wrap(async (req, res) => {
    const { data } = await db.from('banners').select('id, image_url, title, product_id, sort_order, is_active, products(name)').order('sort_order').order('created_at', { ascending: false });
    res.json({ banners: data || [] });
  }));
  app.get('/api/admin/banner-products', ...admin, wrap(async (req, res) => {
    const { data } = await db.from('products').select('id, name, businesses!inner(name, verification)').eq('is_available', true).eq('is_approved', true).eq('businesses.verification', 'approved').order('name').limit(300);
    res.json({ products: (data || []).map((p) => ({ id: p.id, name: p.name, shop: p.businesses.name })) });
  }));
  app.post('/api/admin/banners', ...admin, wrap(async (req, res) => {
    const b = validate(z.object({ image_url: z.string().url(), title: z.string().trim().max(120).optional(), product_id: z.string().uuid().nullable().optional() }), req.body);
    await verifyBanner(b.image_url);
    const { data: last } = await db.from('banners').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    const { data, error } = await db.from('banners').insert({ image_url: b.image_url, title: b.title || null, product_id: b.product_id || null, sort_order: ((last && last[0] && last[0].sort_order) || 0) + 1 }).select('id').single();
    if (error) throw fail(400, 'Could not save banner. Check the product link.');
    await log(req.user.id, 'banner_created', 'banners', data.id, { product_id: b.product_id || null });
    res.status(201).json({ id: data.id });
  }));
  app.patch('/api/admin/banners/:id', ...admin, wrap(async (req, res) => {
    const b = validate(z.object({ is_active: z.boolean().optional(), sort_order: z.number().int().min(0).max(10000).optional(),
      title: z.string().trim().max(120).nullable().optional(), product_id: z.string().uuid().nullable().optional() }), req.body);
    const { data, error } = await db.from('banners').update(b).eq('id', uuid(req.params.id)).select('id').maybeSingle();
    if (error || !data) throw fail(404, 'Banner not found');
    res.json({ ok: true });
  }));
  app.delete('/api/admin/banners/:id', ...admin, wrap(async (req, res) => {
    const { data } = await db.from('banners').delete().eq('id', uuid(req.params.id)).select('image_url').maybeSingle();
    if (!data) throw fail(404, 'Banner not found');
    if (data.image_url.startsWith(PREFIX)) await db.storage.from(BUCKET).remove([decodeURIComponent(data.image_url.slice(PREFIX.length))]);
    await log(req.user.id, 'banner_deleted', 'banners', req.params.id, null);
    res.json({ ok: true });
  }));
};
