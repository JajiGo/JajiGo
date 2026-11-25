// JajiGo ID numbers (NIN, driver's licence, voter's card, international passport).
// Stored ENCRYPTED (AES-256-GCM). The key comes from the ID_ENCRYPTION_KEY environment variable and is never in the database.
// A keyed fingerprint stops the same ID being used on two accounts. Admins see only the last 4 digits unless they tap "Reveal", which is logged.
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

module.exports = function identity({ app, db, requireAuth, requireRole, wrap, validate }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const SECRET = process.env.ID_ENCRYPTION_KEY || '';
  const configured = SECRET.length >= 32;
  if (!configured) console.warn('ID_ENCRYPTION_KEY is missing or shorter than 32 characters: ID numbers are NOT being collected.');
  const encKey = configured ? crypto.scryptSync(SECRET, 'jajigo-id-enc-v1', 32) : null;
  const macKey = configured ? crypto.scryptSync(SECRET, 'jajigo-id-mac-v1', 32) : null;
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true });
  const TYPES = { nin: /^\d{11}$/, drivers_licence: /^[A-Z0-9]{8,16}$/, voters_card: /^[A-Z0-9]{9,19}$/, passport: /^[A-Z]\d{8}$/ };
  const LABEL = { nin: 'National ID (NIN)', drivers_licence: 'Driver\'s licence', voters_card: 'Voter\'s card', passport: 'International passport' };
  const log = (actor_id, action, entity, entity_id, details) => db.from('financial_audit_log').insert({ actor_id, action, entity, entity_id: String(entity_id), details });

  // check format and reject obvious fakes, then encrypt and fingerprint
  function prepare(type, raw) {
    if (!configured) throw fail(503, 'ID storage is not set up yet.');
    const t = String(type || ''), re = TYPES[t];
    if (!re) throw fail(400, 'Please choose your ID type.');
    const num = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
    if (!re.test(num)) throw fail(400, t === 'nin' ? 'A National ID (NIN) has 11 digits.' : t === 'passport' ? 'A passport number looks like A12345678.' : 'That ID number does not look right. Please check it.');
    if (/^(.)\1+$/.test(num) || '01234567890123456789'.includes(num) || '98765432109876543210'.includes(num)) throw fail(400, 'Please enter your real ID number.');
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const enc = Buffer.concat([c.update(num, 'utf8'), c.final()]);
    return { type: t, last4: num.slice(-4), encrypted: Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'), hash: crypto.createHmac('sha256', macKey).update(t + ':' + num).digest('hex') };
  }
  function decrypt(b64) {
    const buf = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }
  async function ensureUnique(hash) {
    const { data } = await db.from('user_identity').select('profile_id').eq('id_hash', hash).maybeSingle();
    if (data) throw fail(409, 'This ID is already registered to another account. If this is a mistake, please contact JajiGo support.');
  }
  async function save(userId, p) {
    const { error } = await db.from('user_identity').insert({ profile_id: userId, id_type: p.type, id_hash: p.hash, id_last4: p.last4, id_encrypted: p.encrypted });
    if (error) throw fail(error.code === '23505' ? 409 : 500, error.code === '23505' ? 'This ID is already registered to another account.' : 'Could not save the ID number.');
  }
  app.locals.identity = { configured, prepare, ensureUnique, save, labels: LABEL };

  app.get('/api/identity/config', (req, res) => res.json({ required: configured, types: Object.keys(LABEL).map((k) => ({ id: k, label: LABEL[k] })) }));

  app.get('/api/identity/mine', requireAuth, wrap(async (req, res) => {
    const { data } = await db.from('user_identity').select('id_type, id_last4').eq('profile_id', req.user.id).maybeSingle();
    res.json({ configured, on_file: !!data, type: data ? data.id_type : null, label: data ? LABEL[data.id_type] : null, last4: data ? data.id_last4 : null });
  }));

  // add an ID number (once; changes go through JajiGo support)
  app.post('/api/identity', requireAuth, limiter, wrap(async (req, res) => {
    const b = validate(z.object({ id_type: z.string(), id_number: z.string().min(5).max(30) }), req.body);
    const { data: have } = await db.from('user_identity').select('profile_id').eq('profile_id', req.user.id).maybeSingle();
    if (have) throw fail(400, 'Your ID is already on file. To change it, please contact JajiGo support.');
    const p = prepare(b.id_type, b.id_number);
    await ensureUnique(p.hash);
    await save(req.user.id, p);
    res.status(201).json({ ok: true, last4: p.last4 });
  }));

  // ---------- admin ----------
  app.post('/api/admin/businesses/:id/identity/reveal', requireAuth, requireRole('admin'), limiter, wrap(async (req, res) => {
    if (!configured) throw fail(503, 'ID storage is not set up yet.');
    const { data: biz } = await db.from('businesses').select('id, name, owner_id').eq('id', req.params.id).maybeSingle();
    if (!biz) throw fail(404, 'Business not found');
    const { data: row } = await db.from('user_identity').select('id_type, id_encrypted').eq('profile_id', biz.owner_id).maybeSingle();
    if (!row) throw fail(404, 'No ID number on file for this owner.');
    let number;
    try { number = decrypt(row.id_encrypted); } catch (e) { throw fail(500, 'Could not read the stored ID. The encryption key may have changed.'); }
    await log(req.user.id, 'id_number_revealed', 'businesses', biz.id, { owner: biz.owner_id });
    res.json({ label: LABEL[row.id_type], number, name: biz.name });
  }));
  app.delete('/api/admin/users/:id/identity', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { data } = await db.from('user_identity').delete().eq('profile_id', req.params.id).select('profile_id').maybeSingle();
    if (!data) throw fail(404, 'No ID on file');
    await log(req.user.id, 'id_number_removed', 'profiles', req.params.id, {});
    res.json({ ok: true });
  }));
};
