// JajiGo Services marketplace (version 1): providers, booking, quotes, commission owed. The customer pays the provider after the work.
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

module.exports = function services({ app, db, requireAuth, requireRole, wrap, validate, SUPABASE_URL }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const uuid = (v) => { if (!z.string().uuid().safeParse(v).success) throw fail(400, 'Invalid id'); return v; };
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true });
  const notify = (user_id, title, body, kind, link) => db.from('notifications').insert({ user_id, title, body, kind, link: link || null });
  const shortName = (n) => { const p = String(n || 'Customer').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };
  const OPEN = ['requested', 'quoted', 'accepted', 'provider_on_the_way', 'in_progress'];
  const SHOWN = ['accepted', 'provider_on_the_way', 'in_progress', 'completed'];          // contact details are shared only from here
  const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const lagos = (iso) => { const d = new Date(new Date(iso).getTime() + 3600000); return { weekday: d.getUTCDay(), time: d.toISOString().slice(11, 16), day: d.toISOString().slice(0, 10) }; };
  const log = (actor_id, action, entity, entity_id, details) => db.from('financial_audit_log').insert({ actor_id, action, entity, entity_id: String(entity_id), details });

  // ---------- PUBLIC ----------
  app.get('/api/business-types', wrap(async (req, res) => {
    const mk = req.query.marketplace === 'shopping' ? 'shopping' : 'services';
    const { data } = await db.from('provider_business_types').select('id, name').eq('marketplace', mk).eq('is_active', true).order('name');
    res.json({ types: data || [] });
  }));

  app.get('/api/services/providers', wrap(async (req, res) => {
    let q = db.from('businesses').select('id, name, description, address, logo_url, on_site_service, custom_type, business_type_id, provider_business_types(name), service_listings(price_kobo, quote_required, is_active)')
      .eq('marketplace', 'services').eq('verification', 'approved').limit(60);
    if (req.query.type) q = q.eq('business_type_id', Number(req.query.type));
    if (req.query.q) q = q.ilike('name', `%${String(req.query.q).replace(/[%_,()]/g, ' ').trim()}%`);
    const { data } = await q;
    res.json({ providers: (data || []).map((b) => {
      const act = (b.service_listings || []).filter((s) => s.is_active), prices = act.filter((s) => s.price_kobo != null).map((s) => s.price_kobo);
      return { id: b.id, name: b.name, description: b.description, address: b.address, logo_url: b.logo_url, on_site_service: b.on_site_service,
        type: (b.provider_business_types && b.provider_business_types.name) || b.custom_type || 'Service', type_id: b.business_type_id,
        from_price_kobo: prices.length ? Math.min(...prices) : null, offers_quotes: act.some((s) => s.quote_required), service_count: act.length };
    }) });
  }));

  app.get('/api/services/providers/:id', wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const { data: b } = await db.from('businesses').select('id, name, description, address, service_area, logo_url, cover_url, on_site_service, custom_type, provider_business_types(name)')
      .eq('id', id).eq('marketplace', 'services').eq('verification', 'approved').maybeSingle();
    if (!b) throw fail(404, 'Provider not found');
    const today = lagos(new Date().toISOString()).day;
    const [sv, hrs, off, pf] = await Promise.all([
      db.from('service_listings').select('id, title, description, price_kobo, quote_required, duration_minutes').eq('business_id', id).eq('is_active', true).order('created_at'),
      db.from('provider_availability').select('weekday, start_time, end_time').eq('business_id', id).order('weekday'),
      db.from('provider_days_off').select('day').eq('business_id', id).gte('day', today).order('day').limit(60),
      db.from('portfolio_images').select('id, image_url, caption').eq('business_id', id).limit(12)]);
    const { provider_business_types, ...rest } = b;
    res.json({ provider: { ...rest, type: (provider_business_types && provider_business_types.name) || b.custom_type || 'Service' },
      services: sv.data || [], hours: hrs.data || [], days_off: (off.data || []).map((x) => x.day), portfolio: pf.data || [] });
  }));

  app.get('/api/services/listings/:id', wrap(async (req, res) => {
    const { data: sv } = await db.from('service_listings').select('id, title, description, price_kobo, quote_required, duration_minutes, is_active, businesses(id, name, address, on_site_service, verification, marketplace)').eq('id', uuid(req.params.id)).maybeSingle();
    if (!sv || !sv.is_active || !sv.businesses || sv.businesses.marketplace !== 'services' || sv.businesses.verification !== 'approved') throw fail(404, 'Service not available');
    const bid = sv.businesses.id;
    const { data: hrs } = await db.from('provider_availability').select('weekday, start_time, end_time').eq('business_id', bid).order('weekday');
    const { businesses: b, ...service } = sv;
    res.json({ service, provider: { id: b.id, name: b.name, address: b.address, on_site_service: b.on_site_service }, hours: hrs || [] });
  }));

  // ---------- CUSTOMER BOOKINGS ----------
  async function checkSlot(businessId, iso) {
    const t = new Date(iso).getTime();
    if (!(t >= Date.now() + 30 * 60000)) throw fail(400, 'Please choose a time at least 30 minutes from now.');
    if (t > Date.now() + 60 * 86400000) throw fail(400, 'Bookings can be made up to 60 days ahead.');
    const l = lagos(iso);
    const { data: off } = await db.from('provider_days_off').select('id').eq('business_id', businessId).eq('day', l.day).maybeSingle();
    if (off) throw fail(400, 'The provider is off on that day. Please choose another day.');
    const { data: hrs } = await db.from('provider_availability').select('weekday, start_time, end_time').eq('business_id', businessId);
    if (hrs && hrs.length) {
      const h = hrs.find((x) => x.weekday === l.weekday);
      if (!h || l.time < h.start_time.slice(0, 5) || l.time >= h.end_time.slice(0, 5)) throw fail(400, 'That time is outside the provider\'s working hours.');
    }
  }

  app.post('/api/services/bookings', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ service_id: z.string().uuid(), scheduled_at: z.string().datetime().optional(), at_customer_location: z.boolean(),
      location_text: z.string().trim().max(300).optional(), problem_description: z.string().trim().max(1000).optional() }), req.body);
    const { data: s } = await db.from('service_listings').select('id, title, quote_required, is_active, business_id, businesses(id, owner_id, verification, marketplace, on_site_service)').eq('id', b.service_id).maybeSingle();
    if (!s || !s.is_active || !s.businesses || s.businesses.marketplace !== 'services' || s.businesses.verification !== 'approved') throw fail(404, 'Service not available');
    if (s.businesses.owner_id === req.user.id) throw fail(403, 'You cannot book your own service');
    if (b.at_customer_location && !s.businesses.on_site_service) throw fail(400, 'This provider does not come to the customer. Choose "at the provider".');
    if (b.at_customer_location && !b.location_text) throw fail(400, 'Please tell the provider where to come (area and street).');
    if (!s.quote_required && !b.scheduled_at) throw fail(400, 'Please choose a date and time.');
    if (b.scheduled_at) await checkSlot(s.business_id, b.scheduled_at);
    const { data: open } = await db.from('service_bookings').select('id, business_id').eq('customer_id', req.user.id).in('status', OPEN);
    if ((open || []).length >= 10) throw fail(400, 'You have too many open bookings. Please finish or cancel some first.');
    if ((open || []).filter((x) => x.business_id === s.business_id).length >= 3) throw fail(400, 'You already have 3 open bookings with this provider.');
    const { data, error } = await db.from('service_bookings').insert({ customer_id: req.user.id, business_id: s.business_id, service_id: s.id, scheduled_at: b.scheduled_at || null,
      at_customer_location: b.at_customer_location, location_text: b.location_text || null, problem_description: b.problem_description || null }).select('id, status').single();
    if (error) throw error;
    await notify(s.businesses.owner_id, s.quote_required ? 'New quote request' : 'New booking request', `${shortName(req.user.full_name)} wants: ${s.title}`, 'booking', '#/provider');
    res.status(201).json({ booking: data });
  }));

  const BK = 'id, status, scheduled_at, proposed_at, at_customer_location, location_text, problem_description, quoted_price_kobo, final_price_kobo, cancel_reason, provider_note, created_at, service_listings(title, price_kobo, quote_required), businesses(id, name, phone, address, logo_url, owner_id)';
  const shape = (x) => { const shown = SHOWN.includes(x.status); const { businesses: bz, ...rest } = x;
    return { ...rest, provider: { id: bz.id, name: bz.name, logo_url: bz.logo_url, phone: shown ? bz.phone : null, address: shown || !x.at_customer_location ? bz.address : null } }; };

  app.get('/api/services/bookings', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('service_bookings').select(BK).eq('customer_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    res.json({ bookings: (data || []).map(shape) });
  }));
  app.get('/api/services/bookings/:id', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('service_bookings').select(BK).eq('id', uuid(req.params.id)).eq('customer_id', req.user.id).maybeSingle();
    if (!data) throw fail(404, 'Booking not found');
    res.json({ booking: shape(data) });
  }));

  async function myBooking(id, uid) {
    const { data } = await db.from('service_bookings').select('id, status, business_id, scheduled_at, proposed_at, quoted_price_kobo, service_listings(title, quote_required), businesses(owner_id)').eq('id', uuid(id)).eq('customer_id', uid).maybeSingle();
    if (!data) throw fail(404, 'Booking not found');
    return data;
  }
  const move = async (id, from, patch) => {
    const { data, error } = await db.from('service_bookings').update(patch).eq('id', id).eq('status', from).select('id').maybeSingle();
    if (error) throw fail(400, 'That step is not allowed right now.');
    if (!data) throw fail(409, 'This booking was just updated. Please refresh.');
  };
  app.post('/api/services/bookings/:id/cancel', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ reason: z.string().trim().max(300).optional() }), req.body || {});
    const x = await myBooking(req.params.id, req.user.id);
    if (!['requested', 'quoted', 'accepted'].includes(x.status)) throw fail(400, 'This booking can no longer be cancelled here. Please contact the provider.');
    await move(x.id, x.status, { status: 'cancelled', cancel_reason: b.reason || 'Cancelled by customer' });
    await notify(x.businesses.owner_id, 'Booking cancelled', `${x.service_listings.title}: the customer cancelled.`, 'booking', '#/provider');
    res.json({ ok: true });
  }));
  app.post('/api/services/bookings/:id/accept-quote', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ scheduled_at: z.string().datetime().optional() }), req.body || {});
    const x = await myBooking(req.params.id, req.user.id);
    if (x.status !== 'quoted') throw fail(400, 'There is no quote to accept.');
    const when = b.scheduled_at || x.scheduled_at;
    if (!when) throw fail(400, 'Please choose a date and time for the job.');
    await checkSlot(x.business_id, when);
    await move(x.id, 'quoted', { status: 'accepted', scheduled_at: when });
    await notify(x.businesses.owner_id, 'Quote accepted', `${x.service_listings.title}: the customer accepted your price.`, 'booking', '#/provider');
    res.json({ ok: true });
  }));
  app.post('/api/services/bookings/:id/accept-time', requireAuth, limiter, wrap(async (req, res) => {
    const x = await myBooking(req.params.id, req.user.id);
    if (x.status !== 'requested' || !x.proposed_at) throw fail(400, 'There is no new time to accept.');
    await checkSlot(x.business_id, x.proposed_at);
    const needsQuote = x.service_listings.quote_required && x.quoted_price_kobo == null;
    if (needsQuote) await db.from('service_bookings').update({ scheduled_at: x.proposed_at, proposed_at: null }).eq('id', x.id);
    else await move(x.id, 'requested', { status: 'accepted', scheduled_at: x.proposed_at, proposed_at: null });
    await notify(x.businesses.owner_id, 'New time accepted', `${x.service_listings.title}: the customer agreed to your time.`, 'booking', '#/provider');
    res.json({ ok: true });
  }));

  // ---------- PROVIDER DASHBOARD ----------
  async function myBiz(uid) {
    const { data } = await db.from('businesses').select('id, name, verification, on_site_service').eq('owner_id', uid).eq('marketplace', 'services').maybeSingle();
    if (!data) throw fail(403, 'Register as a service provider first');
    if (data.verification !== 'approved') throw fail(403, 'Your service account is not approved yet');
    return data;
  }
  app.get('/api/provider/summary', requireAuth, wrap(async (req, res) => {
    const b = await myBiz(req.user.id);
    const { data } = await db.from('service_bookings').select('status').eq('business_id', b.id);
    const counts = {}; (data || []).forEach((x) => { counts[x.status] = (counts[x.status] || 0) + 1; });
    res.json({ provider: { id: b.id, name: b.name }, counts });
  }));
  app.get('/api/provider/bookings', requireAuth, wrap(async (req, res) => {
    const b = await myBiz(req.user.id);
    let q = db.from('service_bookings').select('id, status, scheduled_at, proposed_at, at_customer_location, location_text, problem_description, quoted_price_kobo, final_price_kobo, cancel_reason, created_at, service_listings(title, price_kobo, quote_required), profiles(full_name, phone)')
      .eq('business_id', b.id).order('created_at', { ascending: false }).limit(100);
    if (req.query.status) q = q.in('status', String(req.query.status).split(',').slice(0, 8));
    const { data } = await q;
    res.json({ bookings: (data || []).map((x) => { const shown = SHOWN.includes(x.status); const { profiles, ...rest } = x;
      return { ...rest, location_text: shown || !x.at_customer_location ? x.location_text : null, customer: { name: shortName(profiles && profiles.full_name), phone: shown ? profiles && profiles.phone : null } }; }) });
  }));

  app.patch('/api/provider/bookings/:id', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ action: z.enum(['accept', 'reject', 'quote', 'propose_time', 'cancel', 'on_the_way', 'start', 'complete']),
      reason: z.string().trim().max(300).optional(), price_kobo: z.number().int().min(100).max(1000000000).optional(), scheduled_at: z.string().datetime().optional(),
      final_price_kobo: z.number().int().min(100).max(1000000000).optional(), note: z.string().trim().max(300).optional() }), req.body);
    const biz = await myBiz(req.user.id);
    const { data: x } = await db.from('service_bookings').select('id, status, customer_id, scheduled_at, at_customer_location, quoted_price_kobo, service_listings(title, price_kobo, quote_required)')
      .eq('id', uuid(req.params.id)).eq('business_id', biz.id).maybeSingle();
    if (!x) throw fail(404, 'Booking not found');
    const title = x.service_listings.title, tell = (t, m) => notify(x.customer_id, t, `${biz.name}: ${title}. ${m || ''}`.trim(), 'booking', `#/booking/${x.id}`);
    switch (b.action) {
      case 'accept':
        if (x.status !== 'requested') throw fail(400, 'Only new requests can be accepted.');
        if (x.service_listings.quote_required && x.quoted_price_kobo == null) throw fail(400, 'Send a price quote first.');
        if (!x.scheduled_at) throw fail(400, 'Propose a time first.');
        await move(x.id, 'requested', { status: 'accepted' }); await tell('Booking accepted', 'See you then!'); break;
      case 'reject':
        if (x.status !== 'requested') throw fail(400, 'Only new requests can be rejected.');
        if (!b.reason) throw fail(400, 'Please give a short reason.');
        await move(x.id, 'requested', { status: 'rejected', cancel_reason: b.reason }); await tell('Booking declined', b.reason); break;
      case 'quote':
        if (x.status !== 'requested' || !x.service_listings.quote_required) throw fail(400, 'A quote can only be sent for a new quote request.');
        if (!b.price_kobo) throw fail(400, 'Enter your price.');
        await move(x.id, 'requested', { status: 'quoted', quoted_price_kobo: b.price_kobo, provider_note: b.note || null }); await tell('You have a price quote', `₦${(b.price_kobo / 100).toLocaleString()}. Open the booking to accept.`); break;
      case 'propose_time':
        if (x.status !== 'requested') throw fail(400, 'You can only suggest a time on a new request.');
        if (!b.scheduled_at) throw fail(400, 'Choose the time to suggest.');
        await checkSlot(biz.id, b.scheduled_at);
        await db.from('service_bookings').update({ proposed_at: b.scheduled_at, provider_note: b.note || null }).eq('id', x.id).eq('status', 'requested');
        await tell('The provider suggested another time', 'Open the booking to accept it.'); break;
      case 'cancel':
        if (!['accepted', 'provider_on_the_way'].includes(x.status)) throw fail(400, 'Only confirmed bookings can be cancelled.');
        if (!b.reason) throw fail(400, 'Please give a short reason.');
        await move(x.id, x.status, { status: 'cancelled', cancel_reason: b.reason }); await tell('Booking cancelled by the provider', b.reason); break;
      case 'on_the_way':
        if (x.status !== 'accepted' || !x.at_customer_location) throw fail(400, 'Only confirmed at-your-place jobs can be marked on the way.');
        await move(x.id, 'accepted', { status: 'provider_on_the_way' }); await tell('The provider is on the way'); break;
      case 'start':
        if (!['accepted', 'provider_on_the_way'].includes(x.status)) throw fail(400, 'Accept the booking first.');
        await move(x.id, x.status, { status: 'in_progress', started_at: new Date().toISOString() }); await tell('Your job has started'); break;
      case 'complete': {
        if (x.status !== 'in_progress') throw fail(400, 'Start the job first.');
        const price = b.final_price_kobo || x.quoted_price_kobo || x.service_listings.price_kobo;
        if (!price) throw fail(400, 'Enter the final price you were paid.');
        await move(x.id, 'in_progress', { status: 'completed', final_price_kobo: price, completed_at: new Date().toISOString() });
        await tell('Job completed', `Price: ₦${(price / 100).toLocaleString()}. Please pay the provider directly.`); break; }
    }
    res.json({ ok: true });
  }));

  // services CRUD
  const svSchema = z.object({ title: z.string().trim().min(2).max(100), description: z.string().trim().max(800).optional(), price_kobo: z.number().int().min(100).max(1000000000).nullable().optional(),
    quote_required: z.boolean().optional(), duration_minutes: z.number().int().min(5).max(1440).nullable().optional(), is_active: z.boolean().optional() });
  app.get('/api/provider/services', requireAuth, wrap(async (req, res) => {
    const b = await myBiz(req.user.id);
    const { data } = await db.from('service_listings').select('id, title, description, price_kobo, quote_required, duration_minutes, is_active').eq('business_id', b.id).order('created_at');
    res.json({ services: data || [] });
  }));
  app.post('/api/provider/services', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(svSchema, req.body);
    if (!b.quote_required && !b.price_kobo) throw fail(400, 'Enter a price, or tick "Customer requests a quote".');
    const biz = await myBiz(req.user.id);
    const { count } = await db.from('service_listings').select('id', { count: 'exact', head: true }).eq('business_id', biz.id);
    if ((count || 0) >= 30) throw fail(400, 'You can list up to 30 services.');
    const { data, error } = await db.from('service_listings').insert({ ...b, business_id: biz.id }).select('id').single();
    if (error) throw error;
    res.status(201).json({ id: data.id });
  }));
  app.patch('/api/provider/services/:id', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(svSchema.partial(), req.body);
    const biz = await myBiz(req.user.id);
    const { data } = await db.from('service_listings').update(b).eq('id', uuid(req.params.id)).eq('business_id', biz.id).select('id').maybeSingle();
    if (!data) throw fail(404, 'Service not found');
    res.json({ ok: true });
  }));
  app.delete('/api/provider/services/:id', requireAuth, wrap(async (req, res) => {
    const biz = await myBiz(req.user.id);
    const { error } = await db.from('service_listings').delete().eq('id', uuid(req.params.id)).eq('business_id', biz.id);
    if (error) { await db.from('service_listings').update({ is_active: false }).eq('id', req.params.id).eq('business_id', biz.id); return res.json({ ok: true, archived: true }); }
    res.json({ ok: true });
  }));

  // working hours and days off
  app.get('/api/provider/hours', requireAuth, wrap(async (req, res) => {
    const b = await myBiz(req.user.id);
    const [h, o] = await Promise.all([db.from('provider_availability').select('weekday, start_time, end_time').eq('business_id', b.id).order('weekday'),
      db.from('provider_days_off').select('day').eq('business_id', b.id).gte('day', lagos(new Date().toISOString()).day).order('day')]);
    res.json({ days: (h.data || []).map((x) => ({ weekday: x.weekday, start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5) })), days_off: (o.data || []).map((x) => x.day) });
  }));
  app.put('/api/provider/hours', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ days: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(HHMM), end: z.string().regex(HHMM) })).max(7),
      days_off: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60) }), req.body);
    if (new Set(b.days.map((d) => d.weekday)).size !== b.days.length) throw fail(400, 'Each weekday can only appear once.');
    if (b.days.some((d) => d.end <= d.start)) throw fail(400, 'Closing time must be after opening time.');
    const biz = await myBiz(req.user.id);
    if (b.days.length) await db.from('provider_availability').upsert(b.days.map((d) => ({ business_id: biz.id, weekday: d.weekday, start_time: d.start, end_time: d.end })), { onConflict: 'business_id,weekday' });
    await db.from('provider_availability').delete().eq('business_id', biz.id).not('weekday', 'in', `(${b.days.length ? b.days.map((d) => d.weekday).join(',') : '9'})`);
    if (b.days_off.length) await db.from('provider_days_off').upsert(b.days_off.map((day) => ({ business_id: biz.id, day })), { onConflict: 'business_id,day' });
    await db.from('provider_days_off').delete().eq('business_id', biz.id).not('day', 'in', `(${b.days_off.length ? b.days_off.join(',') : '1900-01-01'})`);
    res.json({ ok: true });
  }));

  // portfolio photos
  const PBUCKET = 'portfolio', PPREFIX = `${SUPABASE_URL}/storage/v1/object/public/${PBUCKET}/`;
  app.post('/api/provider/portfolio/upload-url', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ ext: z.enum(['jpg', 'png', 'webp']) }), req.body);
    const biz = await myBiz(req.user.id);
    const path = `${biz.id}/${crypto.randomUUID()}.${b.ext}`;
    const { data, error } = await db.storage.from(PBUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    res.json({ signed_url: data.signedUrl, public_url: PPREFIX + path });
  }));
  app.post('/api/provider/portfolio', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ image_url: z.string().url(), caption: z.string().trim().max(120).optional() }), req.body);
    const biz = await myBiz(req.user.id);
    if (!b.image_url.startsWith(PPREFIX + biz.id + '/')) throw fail(400, 'Photos must be uploaded through JajiGo');
    const path = decodeURIComponent(b.image_url.slice(PPREFIX.length));
    if (path.includes('..')) throw fail(400, 'Invalid photo');
    const { count } = await db.from('portfolio_images').select('id', { count: 'exact', head: true }).eq('business_id', biz.id);
    if ((count || 0) >= 12) throw fail(400, 'You can show up to 12 photos.');
    const { data: f, error: e1 } = await db.storage.from(PBUCKET).download(path);
    if (e1 || !f) throw fail(400, 'Photo upload not found. Please upload it again.');
    const buf = Buffer.from(await f.arrayBuffer());
    const ok = (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
    if (buf.length > 3 * 1024 * 1024 || !ok) { await db.storage.from(PBUCKET).remove([path]); throw fail(400, 'Use a real JPEG, PNG or WebP photo under 3 MB'); }
    const { data, error } = await db.from('portfolio_images').insert({ business_id: biz.id, image_url: b.image_url, caption: b.caption || null }).select('id').single();
    if (error) throw error;
    res.status(201).json({ id: data.id });
  }));
  app.delete('/api/provider/portfolio/:id', requireAuth, wrap(async (req, res) => {
    const biz = await myBiz(req.user.id);
    const { data } = await db.from('portfolio_images').delete().eq('id', uuid(req.params.id)).eq('business_id', biz.id).select('image_url').maybeSingle();
    if (!data) throw fail(404, 'Photo not found');
    if (data.image_url.startsWith(PPREFIX)) await db.storage.from(PBUCKET).remove([decodeURIComponent(data.image_url.slice(PPREFIX.length))]);
    res.json({ ok: true });
  }));

  app.get('/api/provider/earnings', requireAuth, wrap(async (req, res) => {
    const b = await myBiz(req.user.id);
    const { data: cr } = await db.from('commission_records').select('gross_kobo, commission_kobo, settled, voided').eq('business_id', b.id).not('booking_id', 'is', null);
    const live = (cr || []).filter((x) => !x.voided), sum = (l, f) => l.reduce((s, x) => s + f(x), 0);
    const { data: bk } = await db.from('service_bookings').select('status').eq('business_id', b.id);
    res.json({ jobs_completed: (bk || []).filter((x) => x.status === 'completed').length, jobs_open: (bk || []).filter((x) => OPEN.includes(x.status)).length,
      total_earned_kobo: sum(live, (x) => x.gross_kobo), commission_owed_kobo: sum(live.filter((x) => !x.settled), (x) => x.commission_kobo), commission_cleared_kobo: sum(live.filter((x) => x.settled), (x) => x.commission_kobo) });
  }));

  // ---------- ADMIN: commission owed by sellers and providers who collected the money themselves ----------
  app.get('/api/admin/commissions-owed', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data } = await db.from('commission_records').select('business_id, commission_kobo, businesses(name, marketplace, phone)').eq('mode', 'provider_collects').eq('settled', false).eq('voided', false);
    const by = {};
    (data || []).forEach((x) => { const o = (by[x.business_id] ||= { business_id: x.business_id, name: x.businesses && x.businesses.name, marketplace: x.businesses && x.businesses.marketplace, phone: x.businesses && x.businesses.phone, owed_kobo: 0, jobs: 0 }); o.owed_kobo += x.commission_kobo; o.jobs++; });
    res.json({ owed: Object.values(by).sort((a, b) => b.owed_kobo - a.owed_kobo) });
  }));
  app.post('/api/admin/commissions/clear', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = validate(z.object({ business_id: z.string().uuid() }), req.body);
    const { data } = await db.from('commission_records').update({ settled: true }).eq('business_id', b.business_id).eq('mode', 'provider_collects').eq('settled', false).eq('voided', false).select('commission_kobo');
    const total = (data || []).reduce((s, x) => s + x.commission_kobo, 0);
    if (!data || !data.length) throw fail(404, 'Nothing owed');
    await log(req.user.id, 'commission_cleared', 'businesses', b.business_id, { records: data.length, total_kobo: total });
    const { data: biz } = await db.from('businesses').select('owner_id').eq('id', b.business_id).single();
    await notify(biz.owner_id, 'Commission cleared', `JajiGo received ₦${(total / 100).toLocaleString()}. Thank you!`, 'commission');
    res.json({ ok: true, total_kobo: total });
  }));
};
