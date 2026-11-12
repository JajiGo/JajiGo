// JajiGo product reviews, provider replies, votes, reports and moderation (Trust System, batch 1)
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

module.exports = function reviews({ app, db, requireAuth, requireRole, wrap, validate, SUPABASE_URL }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const TAGS = ['excellent_quality', 'worth_the_price', 'accurate_description', 'good_packaging', 'fast_delivery', 'poor_quality', 'not_as_described'];
  const EDIT_DAYS = 14, MAX_PHOTOS = 4, MAX_BYTES = 2 * 1024 * 1024, BUCKET = 'review-photos';
  const PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40, standardHeaders: true });
  const uuid = (v) => { if (!z.string().uuid().safeParse(v).success) throw fail(400, 'Invalid id'); return v; };
  const notify = (user_id, title, body, kind) => db.from('notifications').insert({ user_id, title, body, kind });
  const shortName = (n) => { const p = String(n || 'Customer').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };
  const modlog = (admin_id, action, review_id, reason) => db.from('moderation_log').insert({ admin_id, action, review_id, reason });

  // login is optional on public pages; it only lets us show "your vote" / "your review"
  const optionalAuth = wrap(async (req, res, next) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (t) { const { data } = await db.auth.getUser(t); if (data && data.user) req.uid = data.user.id; }
    next();
  });

  // Real image check: size and file signature, not just the file name or the browser's claim
  async function verifyImages(urls, uid, ownReviewId) {
    const paths = [];
    for (const u of urls) {
      if (!u.startsWith(PREFIX)) throw fail(400, 'Photos must be uploaded through JajiGo');
      const path = decodeURIComponent(u.slice(PREFIX.length));
      if (!path.startsWith(uid + '/') || path.includes('..')) throw fail(400, 'Invalid photo');
      const { data: used } = await db.from('review_photos').select('review_id').eq('image_url', u).maybeSingle();
      if (used && used.review_id !== ownReviewId) throw fail(400, 'That photo is already used');
      const { data, error } = await db.storage.from(BUCKET).download(path);
      if (error || !data) throw fail(400, 'Photo upload not found. Please upload it again.');
      const buf = Buffer.from(await data.arrayBuffer());
      if (buf.length > MAX_BYTES) throw fail(400, 'Each photo must be under 2 MB');
      const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const webp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
      if (!(jpg || png || webp)) { await db.storage.from(BUCKET).remove([path]); throw fail(400, 'Only real JPEG, PNG or WebP photos are allowed'); }
      paths.push(path);
    }
    return paths;
  }
  const pathOf = (u) => decodeURIComponent(u.slice(PREFIX.length));

  app.post('/api/reviews/upload-url', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ ext: z.enum(['jpg', 'png', 'webp']) }), req.body);
    const path = `${req.user.id}/${crypto.randomUUID()}.${b.ext}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    res.json({ signed_url: data.signedUrl, public_url: PREFIX + path });
  }));

  // ---------- PUBLIC: product page + reviews (visitors do not need an account) ----------
  app.get('/api/products/:id', wrap(async (req, res) => {
    const { data: p } = await db.from('products')
      .select('id, business_id, name, description, price_kobo, discount_percent, stock, is_available, is_approved, product_images(image_url, sort_order), businesses(id, name, verification)')
      .eq('id', uuid(req.params.id)).maybeSingle();
    if (!p || !p.is_available || !p.is_approved || !p.businesses || p.businesses.verification !== 'approved') throw fail(404, 'Product not found');
    const { businesses, is_available, is_approved, ...rest } = p;
    res.json({ product: { ...rest, final_price_kobo: Math.round(p.price_kobo * (100 - (p.discount_percent || 0)) / 100), shop: { id: businesses.id, name: businesses.name } } });
  }));

  app.get('/api/products/:id/reviews', optionalAuth, wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const { data: rows } = await db.from('product_reviews')
      .select('id, rating, comment, tags, created_at, updated_at, customer_id, profiles(full_name), review_photos(image_url), review_replies(body, updated_at, businesses(name))')
      .eq('product_id', id).eq('status', 'visible').limit(200);
    const list = rows || [];
    // rating figures are always calculated here from the database, never from the browser
    const count = list.length, dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    list.forEach((r) => dist[r.rating]++);
    const average = count ? list.reduce((s, r) => s + r.rating, 0) / count : 0;
    const percent = {}; for (const k of [1, 2, 3, 4, 5]) percent[k] = count ? Math.round((dist[k] * 100) / count) : 0;

    const { data: votes } = list.length ? await db.from('review_votes').select('review_id, voter_id, helpful').in('review_id', list.map((r) => r.id)) : { data: [] };
    const tally = {}; (votes || []).forEach((v) => { const t = (tally[v.review_id] ||= { up: 0, down: 0, mine: null }); v.helpful ? t.up++ : t.down++; if (v.voter_id === req.uid) t.mine = v.helpful; });

    let out = list.map((r) => {
      const rep = Array.isArray(r.review_replies) ? r.review_replies[0] : r.review_replies;
      const t = tally[r.id] || { up: 0, down: 0, mine: null };
      return { id: r.id, name: shortName(r.profiles && r.profiles.full_name), rating: r.rating, comment: r.comment, tags: r.tags,
        created_at: r.created_at, edited: r.updated_at > r.created_at && new Date(r.updated_at) - new Date(r.created_at) > 60000,
        photos: r.review_photos || [], helpful: t.up, not_helpful: t.down, my_vote: t.mine, mine: r.customer_id === req.uid,
        reply: rep ? { body: rep.body, shop: rep.businesses && rep.businesses.name } : null };
    });
    if (req.query.photos === 'true') out = out.filter((r) => r.photos.length);
    const sorts = { oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at), highest: (a, b) => b.rating - a.rating || new Date(b.created_at) - new Date(a.created_at),
      lowest: (a, b) => a.rating - b.rating || new Date(b.created_at) - new Date(a.created_at), helpful: (a, b) => (b.helpful - b.not_helpful) - (a.helpful - a.not_helpful) || new Date(b.created_at) - new Date(a.created_at) };
    out.sort(sorts[req.query.sort] || ((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    res.json({ summary: { count, average: Math.round(average * 10) / 10, distribution: dist, percent }, reviews: out.slice(0, 50) });
  }));

  // ---------- CUSTOMER ----------
  app.get('/api/reviews/mine', requireAuth, wrap(async (req, res) => {
    const { data: mine } = await db.from('product_reviews')
      .select('id, rating, comment, tags, status, created_at, order_item_id, products(name), review_photos(image_url), review_replies(body, businesses(name))')
      .eq('customer_id', req.user.id).order('created_at', { ascending: false });
    const reviewed = new Set((mine || []).map((r) => r.order_item_id));
    const { data: items } = await db.from('order_items')
      .select('id, name, product_id, orders!inner(customer_id, status, businesses(name))')
      .eq('orders.customer_id', req.user.id).in('orders.status', ['delivered', 'completed']);
    res.json({
      eligible: (items || []).filter((i) => i.product_id && !reviewed.has(i.id)).map((i) => ({ order_item_id: i.id, name: i.name, shop: i.orders.businesses && i.orders.businesses.name })),
      reviews: (mine || []).map((r) => { const rep = Array.isArray(r.review_replies) ? r.review_replies[0] : r.review_replies;
        return { id: r.id, product_name: r.products && r.products.name, rating: r.rating, comment: r.comment, tags: r.tags, status: r.status, created_at: r.created_at,
          photos: r.review_photos || [], can_edit: r.status === 'visible' && Date.now() - new Date(r.created_at) < EDIT_DAYS * 86400000,
          reply: rep ? { body: rep.body, shop: rep.businesses && rep.businesses.name } : null }; }),
    });
  }));

  const body = {
    rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional(),
    tags: z.array(z.enum(TAGS)).max(7).optional(), image_urls: z.array(z.string().url()).max(MAX_PHOTOS).optional(),
  };

  app.post('/api/reviews', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ order_item_id: z.string().uuid(), ...body }), req.body);
    const { data: it } = await db.from('order_items').select('id, product_id, order_id, orders!inner(customer_id, status, business_id)').eq('id', b.order_item_id).maybeSingle();
    if (!it || it.orders.customer_id !== req.user.id) throw fail(404, 'Purchase not found');         // only your own purchases
    if (!['delivered', 'completed'].includes(it.orders.status)) throw fail(400, 'You can review after your order is delivered');
    if (!it.product_id) throw fail(400, 'This item can no longer be reviewed');
    const { data: biz } = await db.from('businesses').select('owner_id').eq('id', it.orders.business_id).single();
    if (biz.owner_id === req.user.id) throw fail(403, 'You cannot review your own shop');
    const urls = [...new Set(b.image_urls || [])];
    await verifyImages(urls, req.user.id, null);
    const { data: r, error } = await db.from('product_reviews').insert({
      product_id: it.product_id, order_item_id: it.id, order_id: it.order_id, customer_id: req.user.id, business_id: it.orders.business_id,
      rating: b.rating, comment: b.comment || null, tags: b.tags || [],
    }).select('id').single();
    if (error) throw fail(error.code === '23505' ? 409 : 500, error.code === '23505' ? 'You already reviewed this item' : 'Could not save review');
    if (urls.length) await db.from('review_photos').insert(urls.map((image_url) => ({ review_id: r.id, image_url })));
    await notify(biz.owner_id, 'New customer review', `A customer left a ${b.rating}-star review.`, 'review');
    res.status(201).json({ id: r.id });
  }));

  app.patch('/api/reviews/:id', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object(body).partial(), req.body);
    const { data: r } = await db.from('product_reviews').select('id, status, created_at').eq('id', uuid(req.params.id)).eq('customer_id', req.user.id).maybeSingle();
    if (!r) throw fail(404, 'Review not found');
    if (r.status !== 'visible') throw fail(403, 'This review was moderated and cannot be edited');
    if (Date.now() - new Date(r.created_at) > EDIT_DAYS * 86400000) throw fail(400, `Reviews can be edited for ${EDIT_DAYS} days`);
    const { image_urls, ...fields } = b;
    if (image_urls) {
      const urls = [...new Set(image_urls)];
      await verifyImages(urls, req.user.id, r.id);
      const { data: old } = await db.from('review_photos').select('image_url').eq('review_id', r.id);
      const removed = (old || []).map((x) => x.image_url).filter((u) => !urls.includes(u));
      await db.from('review_photos').delete().eq('review_id', r.id);
      if (urls.length) await db.from('review_photos').insert(urls.map((image_url) => ({ review_id: r.id, image_url })));
      if (removed.length) await db.storage.from(BUCKET).remove(removed.map(pathOf));
    }
    await db.from('product_reviews').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', r.id);
    res.json({ ok: true });
  }));

  app.delete('/api/reviews/:id', requireAuth, wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const { data: r } = await db.from('product_reviews').select('id, review_photos(image_url)').eq('id', id).eq('customer_id', req.user.id).maybeSingle();
    if (!r) throw fail(404, 'Review not found');
    await db.from('product_reviews').delete().eq('id', id);
    if ((r.review_photos || []).length) await db.storage.from(BUCKET).remove(r.review_photos.map((p) => pathOf(p.image_url)));
    res.json({ ok: true });
  }));

  app.post('/api/reviews/:id/vote', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ helpful: z.boolean() }), req.body);
    const id = uuid(req.params.id);
    const { data: r } = await db.from('product_reviews').select('id, customer_id').eq('id', id).eq('status', 'visible').maybeSingle();
    if (!r) throw fail(404, 'Review not found');
    if (r.customer_id === req.user.id) throw fail(400, 'You cannot vote on your own review');
    const { data: v } = await db.from('review_votes').select('helpful').eq('review_id', id).eq('voter_id', req.user.id).maybeSingle();
    if (v && v.helpful === b.helpful) await db.from('review_votes').delete().eq('review_id', id).eq('voter_id', req.user.id); // tap again to undo
    else await db.from('review_votes').upsert({ review_id: id, voter_id: req.user.id, helpful: b.helpful }, { onConflict: 'review_id,voter_id' });
    res.json({ ok: true });
  }));

  app.post('/api/reviews/:id/report', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    const id = uuid(req.params.id);
    const { data: r } = await db.from('product_reviews').select('id, customer_id').eq('id', id).maybeSingle();
    if (!r) throw fail(404, 'Review not found');
    if (r.customer_id === req.user.id) throw fail(400, 'You cannot report your own review');
    const { error } = await db.from('review_reports').insert({ review_id: id, reporter_id: req.user.id, reason: b.reason });
    if (error) throw fail(409, 'You already reported this review');
    res.status(201).json({ ok: true });
  }));

  // ---------- SELLER: see reviews of own products and reply once (editable) ----------
  async function myShopId(uid) {
    const { data } = await db.from('businesses').select('id').eq('owner_id', uid).eq('marketplace', 'shopping').maybeSingle();
    if (!data) throw fail(403, 'Register a Shopping seller business first');
    return data.id;
  }
  app.get('/api/seller/reviews', requireAuth, wrap(async (req, res) => {
    const shop = await myShopId(req.user.id);
    const { data } = await db.from('product_reviews')
      .select('id, rating, comment, tags, created_at, products(name), profiles(full_name), review_photos(image_url), review_replies(body)')
      .eq('business_id', shop).eq('status', 'visible').order('created_at', { ascending: false }).limit(100);
    res.json({ reviews: (data || []).map((r) => { const rep = Array.isArray(r.review_replies) ? r.review_replies[0] : r.review_replies;
      return { id: r.id, product_name: r.products && r.products.name, name: shortName(r.profiles && r.profiles.full_name), rating: r.rating, comment: r.comment,
        tags: r.tags, created_at: r.created_at, photos: r.review_photos || [], reply: rep ? rep.body : null }; }) });
  }));
  app.put('/api/seller/reviews/:id/reply', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ body: z.string().trim().min(2).max(1000) }), req.body);
    const shop = await myShopId(req.user.id);
    const { data: r } = await db.from('product_reviews').select('id, customer_id').eq('id', uuid(req.params.id)).eq('business_id', shop).eq('status', 'visible').maybeSingle();
    if (!r) throw fail(404, 'Review not found for your shop');
    const { data: old } = await db.from('review_replies').select('review_id').eq('review_id', r.id).maybeSingle();
    await db.from('review_replies').upsert({ review_id: r.id, business_id: shop, body: b.body, updated_at: new Date().toISOString() }, { onConflict: 'review_id' });
    if (!old) await notify(r.customer_id, 'The shop replied to your review', b.body.slice(0, 120), 'review_reply'); // first reply only: no duplicate alerts
    res.json({ ok: true });
  }));

  // ---------- PUBLIC: star averages for product cards and shop cards ----------
  app.get('/api/ratings', wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 60);
    const col = req.query.kind === 'shop' ? 'business_id' : 'product_id';
    if (!ids.every((i) => z.string().uuid().safeParse(i).success)) throw fail(400, 'Invalid id');
    if (!ids.length) return res.json({ ratings: {} });
    const { data } = await db.from('product_reviews').select(`${col}, rating`).in(col, ids).eq('status', 'visible');
    const acc = {};
    (data || []).forEach((x) => { const o = (acc[x[col]] ||= { sum: 0, count: 0 }); o.sum += x.rating; o.count++; });
    const ratings = {};
    for (const k in acc) ratings[k] = { average: Math.round((acc[k].sum / acc[k].count) * 10) / 10, count: acc[k].count };
    res.json({ ratings });
  }));

  // ---------- ADMIN MODERATION (every action is written to a permanent log) ----------
  app.get('/api/admin/reviews', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    let q = db.from('product_reviews').select('id, rating, comment, status, created_at, products(name), profiles(full_name), businesses(name)').order('created_at', { ascending: false }).limit(100);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    const { data } = await q;
    res.json({ reviews: data });
  }));
  app.get('/api/admin/reports', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data } = await db.from('review_reports').select('id, reason, created_at, product_reviews(id, rating, comment, status, products(name))').eq('status', 'open').order('created_at', { ascending: false }).limit(100);
    res.json({ reports: data });
  }));
  app.patch('/api/admin/reviews/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ action: z.enum(['hide', 'restore']), reason: z.string().trim().min(3).max(500) }), req.body);
    const { data: r } = await db.from('product_reviews').update({ status: b.action === 'hide' ? 'hidden' : 'visible' }).eq('id', uuid(req.params.id)).select('id, customer_id').maybeSingle();
    if (!r) throw fail(404, 'Review not found');
    await modlog(req.user.id, b.action, r.id, b.reason);
    if (b.action === 'hide') {
      await db.from('review_reports').update({ status: 'actioned' }).eq('review_id', r.id).eq('status', 'open');
      await notify(r.customer_id, 'Your review was hidden', b.reason, 'moderation');
    }
    res.json({ ok: true });
  }));
  app.patch('/api/admin/reports/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data: rp } = await db.from('review_reports').update({ status: 'dismissed' }).eq('id', uuid(req.params.id)).eq('status', 'open').select('id, review_id').maybeSingle();
    if (!rp) throw fail(404, 'Report not found');
    await modlog(req.user.id, 'dismiss_report', rp.review_id, 'Report dismissed');
    res.json({ ok: true });
  }));
  app.get('/api/admin/moderation-log', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data } = await db.from('moderation_log').select('id, action, review_id, reason, created_at').order('id', { ascending: false }).limit(30);
    res.json({ log: data });
  }));
};
