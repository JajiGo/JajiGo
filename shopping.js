// JajiGo Shopping marketplace API (Step 3)
const crypto = require('crypto');
const { z } = require('zod');

module.exports = function shopping({ app, db, requireAuth, requireRole, wrap, validate, audit, SUPABASE_URL }) {
  const SHOP_FIELDS = 'id, name, description, address, logo_url, cover_url, opening_hours, offers_delivery, morning_rush_approved';
  const PRODUCT_FIELDS = 'id, business_id, category_id, name, description, price_kobo, discount_percent, stock, is_morning_rush, product_images(image_url, sort_order)';
  const finalPrice = (p) => Math.round(p.price_kobo * (100 - (p.discount_percent || 0)) / 100);
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const escapeLike = (s) => s.replace(/[%_,()]/g, ' ').trim();

  async function approvedShopIds() {
    const { data } = await db.from('businesses').select('id').eq('marketplace', 'shopping').eq('verification', 'approved');
    return (data || []).map((b) => b.id);
  }
  // The caller's approved Shopping business (sellers only touch their own)
  async function myShop(userId) {
    const { data } = await db.from('businesses').select('*').eq('owner_id', userId).eq('marketplace', 'shopping').maybeSingle();
    if (!data) throw fail(403, 'Register a Shopping seller business first');
    if (data.verification !== 'approved') throw fail(403, 'Your shop is not approved yet');
    return data;
  }
  const notify = (user_id, title, body, kind) => db.from('notifications').insert({ user_id, title, body, kind });

  // ---------- PUBLIC BROWSING ----------
  app.get('/api/shopping/categories', wrap(async (req, res) => {
    const { data } = await db.from('shopping_categories').select('id, name').eq('is_active', true).order('name');
    res.json({ categories: data });
  }));

  app.get('/api/shopping/shops', wrap(async (req, res) => {
    let q = db.from('businesses').select(SHOP_FIELDS).eq('marketplace', 'shopping').eq('verification', 'approved').limit(50);
    if (req.query.q) q = q.ilike('name', `%${escapeLike(String(req.query.q))}%`);
    if (req.query.morning_rush === 'true') q = q.eq('morning_rush_approved', true);
    const { data } = await q;
    res.json({ shops: data });
  }));

  app.get('/api/shopping/shops/:id', wrap(async (req, res) => {
    const { data: shop } = await db.from('businesses').select(SHOP_FIELDS)
      .eq('id', req.params.id).eq('marketplace', 'shopping').eq('verification', 'approved').maybeSingle();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const { data: products } = await db.from('products').select(PRODUCT_FIELDS)
      .eq('business_id', shop.id).eq('is_available', true).eq('is_approved', true);
    res.json({ shop, products: (products || []).map((p) => ({ ...p, final_price_kobo: finalPrice(p) })) });
  }));

  app.get('/api/shopping/products', wrap(async (req, res) => {
    const ids = await approvedShopIds();
    if (!ids.length) return res.json({ products: [] });
    let q = db.from('products').select(PRODUCT_FIELDS).in('business_id', ids)
      .eq('is_available', true).eq('is_approved', true).gt('stock', 0).limit(60);
    if (req.query.q) q = q.ilike('name', `%${escapeLike(String(req.query.q))}%`);
    if (req.query.category_id) q = q.eq('category_id', Number(req.query.category_id));
    if (req.query.shop_id) q = q.eq('business_id', String(req.query.shop_id));
    if (req.query.min_price) q = q.gte('price_kobo', Number(req.query.min_price));
    if (req.query.max_price) q = q.lte('price_kobo', Number(req.query.max_price));
    if (req.query.morning_rush === 'true') q = q.eq('is_morning_rush', true).eq('morning_rush_status', 'approved');
    const { data } = await q;
    res.json({ products: (data || []).map((p) => ({ ...p, final_price_kobo: finalPrice(p) })) });
  }));

  // ---------- CART ----------
  app.get('/api/shopping/cart', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('shopping_cart_items')
      .select('quantity, products(id, business_id, name, price_kobo, discount_percent, stock, is_available)').eq('customer_id', req.user.id);
    const items = (data || []).map((i) => ({ product_id: i.products.id, business_id: i.products.business_id, name: i.products.name,
      quantity: i.quantity, unit_price_kobo: finalPrice(i.products), in_stock: i.products.is_available && i.products.stock >= i.quantity }));
    res.json({ items, subtotal_kobo: items.reduce((s, i) => s + i.unit_price_kobo * i.quantity, 0) });
  }));

  app.put('/api/shopping/cart', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ product_id: z.string().uuid(), quantity: z.number().int().min(0).max(50) }), req.body);
    if (b.quantity === 0) {
      await db.from('shopping_cart_items').delete().eq('customer_id', req.user.id).eq('product_id', b.product_id);
      return res.json({ ok: true });
    }
    const ids = await approvedShopIds();
    const { data: p } = await db.from('products').select('id, business_id, stock, is_available, is_approved').eq('id', b.product_id).maybeSingle();
    if (!p || !ids.includes(p.business_id) || !p.is_available || !p.is_approved) throw fail(404, 'Product not available');
    if (p.stock < b.quantity) throw fail(400, `Only ${p.stock} left in stock`);
    await db.from('shopping_cart_items').upsert({ customer_id: req.user.id, product_id: b.product_id, quantity: b.quantity }, { onConflict: 'customer_id,product_id' });
    res.json({ ok: true });
  }));

  // ---------- CHECKOUT (prices and stock are always recalculated on the server) ----------
  app.post('/api/shopping/orders', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({
      fulfilment: z.enum(['delivery', 'pickup']),
      delivery_address: z.string().min(5).max(300).optional(),
      scheduled_for: z.string().datetime().optional(),
    }), req.body);
    if (b.fulfilment === 'delivery' && !b.delivery_address) throw fail(400, 'Delivery address is required');

    const { data: cart } = await db.from('shopping_cart_items')
      .select('quantity, products(id, business_id, name, price_kobo, discount_percent, is_available, is_approved, is_morning_rush)').eq('customer_id', req.user.id);
    if (!cart || !cart.length) throw fail(400, 'Your cart is empty');
    const ids = await approvedShopIds();
    const { data: setting } = await db.from('platform_settings').select('value').eq('key', 'base_delivery_fee_kobo').single();
    const baseFee = Number(setting.value);

    const byShop = {};
    for (const i of cart) {
      const p = i.products;
      if (!p.is_available || !p.is_approved || !ids.includes(p.business_id)) throw fail(400, `"${p.name}" is no longer available`);
      (byShop[p.business_id] ||= []).push({ ...p, quantity: i.quantity });
    }

    const created = [];
    for (const [shopId, items] of Object.entries(byShop)) {
      const reserved = [];
      try {
        for (const it of items) { // reserve stock atomically
          const { data: ok } = await db.rpc('adjust_stock', { p_id: it.id, delta: -it.quantity });
          if (!ok) throw fail(400, `Not enough stock for "${it.name}"`);
          reserved.push(it);
        }
        const subtotal = items.reduce((s, it) => s + finalPrice(it) * it.quantity, 0);
        const deliveryFee = b.fulfilment === 'delivery' ? baseFee : 0;
        const { data: order, error } = await db.from('orders').insert({
          customer_id: req.user.id, business_id: shopId, fulfilment: b.fulfilment, delivery_address: b.delivery_address || null,
          scheduled_for: b.scheduled_for || null, is_morning_rush: items.every((it) => it.is_morning_rush),
          subtotal_kobo: subtotal, delivery_fee_kobo: deliveryFee, total_kobo: subtotal + deliveryFee,
          delivery_code: String(crypto.randomInt(100000, 1000000)),
        }).select('id, status, total_kobo, delivery_code, business_id').single();
        if (error) throw error;
        await db.from('order_items').insert(items.map((it) => ({ order_id: order.id, product_id: it.id, name: it.name, unit_price_kobo: finalPrice(it), quantity: it.quantity })));
        await db.from('shopping_cart_items').delete().eq('customer_id', req.user.id).in('product_id', items.map((it) => it.id));
        const { data: shop } = await db.from('businesses').select('owner_id').eq('id', shopId).single();
        await notify(shop.owner_id, 'New order', `You have a new order of ₦${(order.total_kobo / 100).toLocaleString()}`, 'order');
        created.push(order);
      } catch (e) {
        for (const it of reserved) await db.rpc('adjust_stock', { p_id: it.id, delta: it.quantity }); // give stock back
        throw e;
      }
    }
    res.status(201).json({ orders: created, message: 'Order placed. Payment comes in a later step.' });
  }));

  // ---------- CUSTOMER ORDERS ----------
  app.get('/api/shopping/orders', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('orders').select('id, status, fulfilment, total_kobo, created_at, businesses(name, logo_url)')
      .eq('customer_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    res.json({ orders: data });
  }));

  app.get('/api/shopping/orders/:id', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('orders').select('*, order_items(*), businesses(name, phone, address)')
      .eq('id', req.params.id).eq('customer_id', req.user.id).maybeSingle();
    if (!data) throw fail(404, 'Order not found');
    res.json({ order: data }); // includes delivery_code so ONLY the customer sees it
  }));

  async function restoreStock(orderId) {
    const { data: items } = await db.from('order_items').select('product_id, quantity').eq('order_id', orderId);
    for (const it of items || []) if (it.product_id) await db.rpc('adjust_stock', { p_id: it.product_id, delta: it.quantity });
  }

  app.post('/api/shopping/orders/:id/cancel', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('orders').update({ status: 'cancelled', cancel_reason: 'Cancelled by customer', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('customer_id', req.user.id).eq('status', 'pending').select('id, business_id').maybeSingle();
    if (!data) throw fail(400, 'Only pending orders can be cancelled');
    await restoreStock(data.id);
    res.json({ ok: true });
  }));

  app.post('/api/shopping/orders/:id/complete', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('orders').update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('customer_id', req.user.id).eq('status', 'delivered').select('id').maybeSingle();
    if (!data) throw fail(400, 'Order is not delivered yet');
    res.json({ ok: true });
  }));

  app.post('/api/shopping/orders/:id/review', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }), req.body);
    const { data: o } = await db.from('orders').select('id, business_id, status').eq('id', req.params.id).eq('customer_id', req.user.id).maybeSingle();
    if (!o || !['delivered', 'completed'].includes(o.status)) throw fail(400, 'You can review after delivery');
    const { error } = await db.from('reviews').insert({ customer_id: req.user.id, business_id: o.business_id, order_id: o.id, ...b });
    if (error) throw fail(409, 'You already reviewed this order');
    res.status(201).json({ ok: true });
  }));

  // ---------- SELLER: ORDERS ----------
  app.get('/api/seller/orders', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    let q = db.from('orders').select('id, status, fulfilment, total_kobo, delivery_address, created_at, is_morning_rush, order_items(name, quantity, unit_price_kobo), profiles(full_name, phone)')
      .eq('business_id', shop.id).order('created_at', { ascending: false }).limit(100);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    const { data } = await q;
    res.json({ orders: data });
  }));

  const NEXT = { pending: ['accepted', 'rejected'], accepted: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['on_the_way', 'delivered'], on_the_way: ['delivered'] };
  app.patch('/api/seller/orders/:id/status', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ status: z.string(), code: z.string().optional(), reason: z.string().max(300).optional() }), req.body);
    const shop = await myShop(req.user.id);
    const { data: o } = await db.from('orders').select('id, status, fulfilment, delivery_code, customer_id').eq('id', req.params.id).eq('business_id', shop.id).maybeSingle();
    if (!o) throw fail(404, 'Order not found');
    if (!(NEXT[o.status] || []).includes(b.status)) throw fail(400, `Cannot move an order from ${o.status} to ${b.status}`);
    if (b.status === 'on_the_way' && o.fulfilment !== 'delivery') throw fail(400, 'Pickup orders cannot go out for delivery');
    if (['rejected', 'cancelled'].includes(b.status) && !b.reason) throw fail(400, 'A reason is required');
    if (b.status === 'delivered' && b.code !== o.delivery_code) throw fail(400, 'Wrong delivery code. Ask the customer for the code in their app.');
    const { error } = await db.from('orders').update({ status: b.status, cancel_reason: b.reason || null, updated_at: new Date().toISOString() }).eq('id', o.id).eq('status', o.status);
    if (error) throw error;
    if (['rejected', 'cancelled'].includes(b.status)) await restoreStock(o.id);
    await notify(o.customer_id, 'Order update', `Your order is now: ${b.status.replace(/_/g, ' ')}`, 'order');
    res.json({ ok: true });
  }));

  // ---------- SELLER: PRODUCTS ----------
  const productSchema = z.object({
    name: z.string().min(2).max(120), description: z.string().max(1000).optional(),
    category_id: z.number().int().optional(), price_kobo: z.number().int().min(0),
    discount_percent: z.number().int().min(0).max(100).optional(), stock: z.number().int().min(0),
    low_stock_alert: z.number().int().min(0).optional(), is_available: z.boolean().optional(),
    image_urls: z.array(z.string().url()).max(6).optional(),
  });
  const validImage = (u) => u.startsWith(`${SUPABASE_URL}/storage/v1/object/public/product-images/`);

  app.get('/api/seller/products', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    const { data } = await db.from('products').select('*, product_images(image_url, sort_order)').eq('business_id', shop.id).order('created_at', { ascending: false });
    res.json({ products: data, low_stock: (data || []).filter((p) => p.stock <= p.low_stock_alert).map((p) => p.id) });
  }));

  app.post('/api/seller/products', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    const { image_urls = [], ...p } = validate(productSchema, req.body);
    if (!image_urls.every(validImage)) throw fail(400, 'Images must be uploaded through JajiGo');
    const { data, error } = await db.from('products').insert({ ...p, business_id: shop.id }).select('id').single();
    if (error) throw error;
    if (image_urls.length) await db.from('product_images').insert(image_urls.map((image_url, i) => ({ product_id: data.id, image_url, sort_order: i })));
    res.status(201).json({ id: data.id });
  }));

  app.patch('/api/seller/products/:id', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    const { image_urls, ...p } = validate(productSchema.partial(), req.body);
    if (image_urls && !image_urls.every(validImage)) throw fail(400, 'Images must be uploaded through JajiGo');
    const { data } = await db.from('products').update(p).eq('id', req.params.id).eq('business_id', shop.id).select('id').maybeSingle();
    if (!data) throw fail(404, 'Product not found');
    if (image_urls) {
      await db.from('product_images').delete().eq('product_id', data.id);
      if (image_urls.length) await db.from('product_images').insert(image_urls.map((image_url, i) => ({ product_id: data.id, image_url, sort_order: i })));
    }
    res.json({ ok: true });
  }));

  app.delete('/api/seller/products/:id', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    const { error } = await db.from('products').delete().eq('id', req.params.id).eq('business_id', shop.id);
    if (error) { // product appears in past orders: hide it instead of breaking history
      await db.from('products').update({ is_available: false }).eq('id', req.params.id).eq('business_id', shop.id);
      return res.json({ ok: true, archived: true });
    }
    res.json({ ok: true });
  }));

  app.get('/api/seller/summary', requireAuth, wrap(async (req, res) => {
    const shop = await myShop(req.user.id);
    const { data } = await db.from('orders').select('status, total_kobo, created_at').eq('business_id', shop.id);
    const counts = {}; let sales = 0;
    for (const o of data || []) { counts[o.status] = (counts[o.status] || 0) + 1; if (['delivered', 'completed'].includes(o.status)) sales += o.total_kobo; }
    res.json({ shop: { id: shop.id, name: shop.name }, order_counts: counts, total_sales_kobo: sales });
  }));

  // ---------- SIGNED IMAGE UPLOADS (user can only write inside their own folder) ----------
  app.post('/api/uploads/sign', requireAuth, wrap(async (req, res) => {
    const b = validate(z.object({ bucket: z.enum(['logos', 'covers', 'product-images', 'portfolio', 'documents']), filename: z.string().min(1).max(100) }), req.body);
    const ext = (b.filename.split('.').pop() || '').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(ext) || (ext === 'pdf' && b.bucket !== 'documents')) throw fail(400, 'Unsupported file type');
    const path = `${req.user.id}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await db.storage.from(b.bucket).createSignedUploadUrl(path);
    if (error) throw error;
    res.json({ signed_url: data.signedUrl, token: data.token, path, public_url: `${SUPABASE_URL}/storage/v1/object/public/${b.bucket}/${path}` });
  }));
};
