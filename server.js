require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, FRONTEND_ORIGIN, PORT } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
}

// Service-role client: full access, NEVER sent to the browser.
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Anon client: only used to check passwords at login.
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const app = express();
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', SUPABASE_URL], connectSrc: ["'self'", SUPABASE_URL],
} } }));
app.use(cors({ origin: FRONTEND_ORIGIN ? FRONTEND_ORIGIN.split(',') : false }));
app.use(express.json({ limit: '100kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validate = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), { status: 400 });
  return r.data;
};

// ---------- Auth middleware ----------
const requireAuth = wrap(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  if (!profile || !profile.is_active) return res.status(403).json({ error: 'Account unavailable' });
  req.user = { id: data.user.id, email: data.user.email, ...profile };
  next();
});
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed' });

const audit = (actor, action, entity, entityId, details) =>
  db.from('financial_audit_log').insert({ actor_id: actor, action, entity, entity_id: String(entityId), details });

// ---------- Routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'JajiGo' }));

// Sign up (customers only; sellers/providers register a business afterwards)
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  full_name: z.string().min(2).max(100),
  phone: z.string().regex(/^[0-9+]{10,15}$/, 'Enter a valid phone number'),
});
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const b = validate(signupSchema, req.body);
  const { data, error } = await db.auth.admin.createUser({ email: b.email, password: b.password, email_confirm: true });
  if (error) return res.status(400).json({ error: error.message });
  const { error: pErr } = await db.from('profiles').insert({ id: data.user.id, full_name: b.full_name, phone: b.phone, role: 'customer' });
  if (pErr) {
    await db.auth.admin.deleteUser(data.user.id); // do not leave half-created accounts
    return res.status(pErr.code === '23505' ? 409 : 500).json({ error: pErr.code === '23505' ? 'Phone number already used' : 'Could not create profile' });
  }
  res.status(201).json({ message: 'Account created. You can now log in.' });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const b = validate(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { data, error } = await anon.auth.signInWithPassword(b);
  if (error) return res.status(401).json({ error: 'Wrong email or password' });
  const { data: profile } = await db.from('profiles').select('id, full_name, phone, role, is_active').eq('id', data.user.id).single();
  if (!profile || !profile.is_active) return res.status(403).json({ error: 'Account unavailable' });
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at, user: profile });
}));

app.post('/api/auth/refresh', authLimiter, wrap(async (req, res) => {
  const b = validate(z.object({ refresh_token: z.string().min(10) }), req.body);
  const { data, error } = await anon.auth.refreshSession({ refresh_token: b.refresh_token });
  if (error || !data.session) return res.status(401).json({ error: 'Please log in again' });
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const { data: businesses } = await db.from('businesses').select('id, marketplace, name, verification, rejection_reason').eq('owner_id', req.user.id);
  res.json({ user: { id: req.user.id, email: req.user.email, full_name: req.user.full_name, phone: req.user.phone, role: req.user.role }, businesses: businesses || [] });
}));

// Register a Shopping seller OR a Services provider (separate records, separate approval)
const businessSchema = z.object({
  marketplace: z.enum(['shopping', 'services']),
  name: z.string().min(2).max(120),
  business_type_id: z.number().int().optional(),
  custom_type: z.string().max(80).optional(),
  description: z.string().max(1000).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
  service_area: z.string().max(200).optional(),
  opening_hours: z.record(z.any()).optional(),
  offers_delivery: z.boolean().optional(),
  on_site_service: z.boolean().optional(),
});
app.post('/api/businesses/register', requireAuth, wrap(async (req, res) => {
  const b = validate(businessSchema, req.body);
  const { data, error } = await db.from('businesses')
    .insert({ ...b, owner_id: req.user.id, verification: 'pending' }).select('id, marketplace, name, verification').single();
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'You already registered this marketplace type' : 'Could not register business' });
  if (req.user.role === 'customer') {
    await db.from('profiles').update({ role: b.marketplace === 'shopping' ? 'seller' : 'provider' }).eq('id', req.user.id);
  }
  res.status(201).json({ business: data, message: 'Submitted for admin review.' });
}));

// ---------- Admin ----------
app.get('/api/admin/businesses', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  let q = db.from('businesses').select('*').order('created_at', { ascending: false }).limit(200);
  if (req.query.status) q = q.eq('verification', String(req.query.status));
  if (req.query.marketplace) q = q.eq('marketplace', String(req.query.marketplace));
  const { data, error } = await q;
  if (error) throw error;
  res.json({ businesses: data });
}));

app.patch('/api/admin/businesses/:id/verification', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const b = validate(z.object({
    status: z.enum(['under_review', 'approved', 'rejected', 'suspended']),
    reason: z.string().max(500).optional(),
  }), req.body);
  if ((b.status === 'rejected' || b.status === 'suspended') && !b.reason) return res.status(400).json({ error: 'A reason is required' });
  const { data, error } = await db.from('businesses')
    .update({ verification: b.status, rejection_reason: b.reason || null }).eq('id', req.params.id).select('id, owner_id, name').single();
  if (error || !data) return res.status(404).json({ error: 'Business not found' });
  await audit(req.user.id, 'business_verification', 'businesses', data.id, b);
  await db.from('notifications').insert({
    user_id: data.owner_id, kind: 'verification',
    title: `Your business "${data.name}" is now: ${b.status.replace('_', ' ')}`, body: b.reason || null,
  });
  res.json({ ok: true });
}));

// ---------- Shopping marketplace (Step 3) ----------
require('./shopping')({ app, db, requireAuth, requireRole, wrap, validate, audit, SUPABASE_URL });

// ---------- Website (the app screens) ----------
app.use(express.static(require('path').join(__dirname, 'public')));

// ---------- Errors ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT || 3000, () => console.log(`JajiGo API running on port ${PORT || 3000}`));
