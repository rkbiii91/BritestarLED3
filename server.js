'use strict';

const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BritestarLED2026!';
const MAIL_TO_LIST = (process.env.MAIL_TO || 'rb@britestar.com, care@britestar.com, rk@britestar.com')
  .split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
const MAIL_TO = MAIL_TO_LIST.join(', ');
const MAIL_FROM = process.env.MAIL_FROM || 'britestarledev@gmail.com';
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York';

/* ------------------------------------------------------------------ */
/* Tiny JSON "database" (one file, written atomically)                 */
/* ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      locations: Array.isArray(raw.locations) ? raw.locations : [],
      submissions: Array.isArray(raw.submissions) ? raw.submissions : [],
      adminPassword: typeof raw.adminPassword === 'string' ? raw.adminPassword : ''
    };
  } catch (e) {
    return { locations: [], submissions: [], adminPassword: '' };
  }
}

const db = loadDb();
let writeChain = Promise.resolve();

function persist() {
  // Serialize writes so two requests can never interleave a file write.
  writeChain = writeChain.then(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }).catch(err => console.error('DB write failed:', err));
  return writeChain;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdminPassword(pw) {
  if (typeof pw !== 'string' || !pw) return false;
  if (safeEqual(pw, ADMIN_PASSWORD)) return true;
  if (db.adminPassword && safeEqual(pw, db.adminPassword)) return true;
  return false;
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function clampStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Simple in-memory rate limiter: max N hits per minute per IP per bucket.
const hits = new Map();
function rateLimit(bucket, max) {
  return (req, res, next) => {
    const key = bucket + ':' + req.ip;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + 60000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
    entry.count++;
    hits.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 5 * 60000).unref();

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function fmtDateTime(ts) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TZ, dateStyle: 'medium', timeStyle: 'short'
    }).format(new Date(ts));
  } catch (e) {
    return new Date(ts).toISOString();
  }
}

function csvCell(v) {
  let c = String(v == null ? '' : v);
  // Neutralize spreadsheet formula injection from contractor-typed text.
  if (/^[=+\-@\t\r]/.test(c)) c = "'" + c;
  c = c.replace(/"/g, '""');
  return /[",\r\n]/.test(c) ? '"' + c + '"' : c;
}

function submissionCsv(sub) {
  const rows = [['Date', 'Submitted At', 'Contractor', 'Location', 'Area', 'Fixture Type', 'Quantity', 'Color', 'Wattage', 'Fixture Note']];
  const when = fmtDateTime(sub.ts);
  const active = sub.items.filter(i => i.qty > 0);
  if (active.length === 0) {
    rows.push([sub.reportDate, when, sub.contractorName, sub.locationName, sub.area, '', '0', '', '', '']);
  } else {
    active.forEach(i => rows.push([sub.reportDate, when, sub.contractorName, sub.locationName, sub.area, i.name, String(i.qty), i.color, i.watt, i.note]));
  }
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function submissionEmail(sub) {
  const active = sub.items.filter(i => i.qty > 0);
  const total = active.reduce((n, i) => n + i.qty, 0);
  const subject = `Install report — ${sub.locationName} — ${sub.area} — ${sub.reportDate}`;

  const textLines = [
    `Location: ${sub.locationName}`,
    `Area: ${sub.area}`,
    `Contractor: ${sub.contractorName}`,
    `Report date: ${sub.reportDate}`,
    `Submitted: ${fmtDateTime(sub.ts)} (${DISPLAY_TZ})`,
    `Total fixtures: ${total}`,
    ''
  ];
  if (active.length === 0) textLines.push('No fixtures logged.');
  active.forEach(i => {
    textLines.push(`${i.name}: ${i.qty}` +
      (i.color ? ` | Color: ${i.color}` : '') +
      (i.watt ? ` | Power: ${i.watt}` : '') +
      (i.note ? ` | Note: ${i.note}` : ''));
  });

  const rowsHtml = active.map(i => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${i.qty}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.color)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.watt)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.note)}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px;">
    <h2 style="margin:0 0 4px;">Install report</h2>
    <p style="margin:0 0 14px;color:#6b7280;">${escapeHtml(sub.locationName)} &middot; ${escapeHtml(sub.area)}</p>
    <table style="border-collapse:collapse;margin-bottom:16px;font-size:14px;">
      <tr><td style="padding:3px 14px 3px 0;color:#6b7280;">Contractor</td><td>${escapeHtml(sub.contractorName)}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#6b7280;">Report date</td><td>${escapeHtml(sub.reportDate)}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#6b7280;">Submitted</td><td>${escapeHtml(fmtDateTime(sub.ts))} (${escapeHtml(DISPLAY_TZ)})</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#6b7280;">Total fixtures</td><td><b>${total}</b></td></tr>
    </table>
    ${active.length ? `
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead><tr style="background:#f3f4f6;text-align:left;">
        <th style="padding:8px;">Fixture</th><th style="padding:8px;text-align:right;">Qty</th>
        <th style="padding:8px;">Color</th><th style="padding:8px;">Power</th><th style="padding:8px;">Note</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : '<p>No fixtures logged.</p>'}
    <p style="margin-top:18px;color:#6b7280;font-size:12px;">A CSV of this report is attached.</p>
  </div>`;

  const safeLoc = sub.locationName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'location';
  const safeArea = sub.area.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'area';
  return {
    from: `Brite Star Install Reports <${MAIL_FROM}>`,
    to: MAIL_TO,
    subject,
    text: textLines.join('\n'),
    html,
    attachments: [{
      filename: `install-report-${safeLoc}-${safeArea}-${sub.reportDate}.csv`,
      content: submissionCsv(sub),
      contentType: 'text/csv; charset=utf-8'
    }]
  };
}

// Gmail API access token (cached until shortly before expiry)
let tokenCache = { token: '', exp: 0 };
async function getGmailAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('Google token refresh failed: ' + (body.error_description || body.error || res.status));
  }
  tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function sendMail(message) {
  // 1) Dry run: write the message to disk (for testing)
  if (process.env.EMAIL_DRY_RUN) {
    const raw = await composeRaw(message);
    fs.writeFileSync(path.join(DATA_DIR, 'last-email.eml'), raw);
    console.log('EMAIL_DRY_RUN: wrote', path.join(DATA_DIR, 'last-email.eml'));
    return true;
  }

  // 2) Gmail SMTP with an app password (requires a paid Render instance)
  if (process.env.GMAIL_APP_PASSWORD) {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: MAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
      connectionTimeout: 15000,
      socketTimeout: 20000
    });
    await transport.sendMail(message);
    return true;
  }

  // 3) Gmail API over HTTPS (works on Render free instances)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    const raw = await composeRaw(message);
    const accessToken = await getGmailAccessToken();
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('Gmail API send failed (' + res.status + '): ' + t.slice(0, 300));
    }
    return true;
  }

  console.warn('Email not configured: set GMAIL_APP_PASSWORD or GOOGLE_* variables.');
  return false;
}

async function composeRaw(message) {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await t.sendMail(message);
  return info.message; // Buffer containing the RFC 822 message
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ---------- public (contractor) API ---------- */

app.get('/api/locations', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ locations: db.locations.map(l => ({ id: l.id, name: l.name })) });
});

function findLocationWithPassword(locationId, password) {
  const loc = db.locations.find(l => l.id === locationId);
  if (!loc || typeof password !== 'string' || !safeEqual(password, loc.password)) return null;
  return loc;
}

app.post('/api/verify', rateLimit('verify', 20), (req, res) => {
  const { locationId, password } = req.body || {};
  const loc = findLocationWithPassword(locationId, password);
  if (!loc) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({
    location: {
      id: loc.id,
      name: loc.name,
      areaTypes: loc.areaTypes || [],
      lightTypes: (loc.lightTypes || []).map(lt => ({ id: lt.id, name: lt.name }))
    }
  });
});

app.post('/api/submit', rateLimit('submit', 30), async (req, res) => {
  const b = req.body || {};
  const loc = findLocationWithPassword(b.locationId, b.password);
  if (!loc) return res.status(401).json({ error: 'Incorrect password.' });

  const contractorName = clampStr(b.contractorName, 100);
  if (!contractorName) return res.status(400).json({ error: 'Name is required.' });

  const area = clampStr(b.area, 100);
  if (!(loc.areaTypes || []).includes(area)) return res.status(400).json({ error: 'Unknown area.' });

  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(b.reportDate || '')
    ? b.reportDate
    : new Date().toISOString().slice(0, 10);

  const clientId = clampStr(b.clientId, 64);
  if (clientId) {
    const existing = db.submissions.find(s => s.clientId === clientId);
    if (existing) return res.json({ ok: true, emailed: existing.emailed !== false, duplicate: true });
  }

  // Build items from the server's own fixture list for this location.
  const sent = Array.isArray(b.items) ? b.items : [];
  const items = (loc.lightTypes || []).map(lt => {
    const m = sent.find(x => x && x.name === lt.name) || {};
    let qty = parseInt(m.qty, 10);
    if (!Number.isFinite(qty) || qty < 0) qty = 0;
    if (qty > 100000) qty = 100000;
    return { name: lt.name, qty, color: clampStr(m.color, 100), watt: clampStr(m.watt, 50), note: clampStr(m.note, 500) };
  });

  const sub = {
    id: newId('sub'),
    clientId,
    ts: Date.now(),
    reportDate,
    locationId: loc.id,
    locationName: loc.name,
    area,
    contractorName,
    items,
    emailed: false
  };

  db.submissions.push(sub);
  await persist(); // saved first, so a report is never lost even if email fails

  try {
    sub.emailed = await sendMail(submissionEmail(sub));
  } catch (err) {
    console.error('Email send failed for', sub.id, '-', err.message);
    sub.emailed = false;
  }
  await persist();

  res.json({ ok: true, emailed: sub.emailed });
});

/* ---------- admin API ---------- */

function requireAdmin(req, res, next) {
  if (isAdminPassword(req.get('x-admin-password'))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', rateLimit('admin-login', 10), (req, res) => {
  if (!isAdminPassword((req.body || {}).password)) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ ok: true });
});

app.get('/api/admin/data', rateLimit('admin', 120), requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ locations: db.locations, submissions: db.submissions, adminPassword: db.adminPassword });
});

app.put('/api/admin/save', rateLimit('admin', 120), requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (key === 'locations') {
    if (!Array.isArray(value) || value.length > 500) return res.status(400).json({ error: 'Invalid locations.' });
    db.locations = value.map(l => ({
      id: clampStr(l.id, 64) || newId('loc'),
      name: clampStr(l.name, 150),
      password: clampStr(l.password, 100),
      areaTypes: (Array.isArray(l.areaTypes) ? l.areaTypes : []).map(a => clampStr(a, 100)).filter(Boolean).slice(0, 100),
      lightTypes: (Array.isArray(l.lightTypes) ? l.lightTypes : [])
        .map(lt => ({ id: clampStr(lt && lt.id, 64) || newId('lt'), name: clampStr(lt && lt.name, 150) }))
        .filter(lt => lt.name).slice(0, 300)
    })).filter(l => l.name && l.password);
  } else if (key === 'adminPassword') {
    const pw = clampStr(value, 100);
    if (!pw) return res.status(400).json({ error: 'Password cannot be empty.' });
    db.adminPassword = pw;
  } else {
    return res.status(400).json({ error: 'Unknown key.' });
  }
  await persist();
  res.json({ ok: true });
});

app.delete('/api/admin/submissions/:id', rateLimit('admin', 120), requireAdmin, async (req, res) => {
  const before = db.submissions.length;
  db.submissions = db.submissions.filter(s => s.id !== req.params.id);
  if (db.submissions.length === before) return res.status(404).json({ error: 'Not found.' });
  await persist();
  res.json({ ok: true });
});

/* ---------- static front end ---------- */

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.listen(PORT, () => {
  console.log(`Brite Star install report running on port ${PORT}`);
  console.log(`Data file: ${DB_FILE}`);
  console.log(`Email: to ${MAIL_TO} from ${MAIL_FROM} via ` +
    (process.env.EMAIL_DRY_RUN ? 'DRY RUN' :
      process.env.GMAIL_APP_PASSWORD ? 'Gmail SMTP (app password)' :
      (process.env.GOOGLE_REFRESH_TOKEN ? 'Gmail API' : 'NOT CONFIGURED')));
});
