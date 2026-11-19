import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { state, bus, save, reset, emit, addInbox, log } from './store.js';
import { DEPARTMENTS } from './roster.js';
import { addFile, removeFile, fileBlob, addMemory, removeMemory, seedBuiltins, setSummary, MAX_UPLOAD, CATEGORIES } from './knowledge.js';
import { LIVE, MODEL, keyInfo, runRequest, holdMeeting, directMessage, openPositions, summarizeFile, enqueueHire, retryHire, pumpHiring, friendlyError } from './agents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Password protection. Required whenever the office is reachable from outside
// this machine, because every request spends the owner's API credit.
const PASSWORD = process.env.OFFICE_PASSWORD || '';
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) {
  console.error('\n  ❌ OFFICE_PASSWORD is required when the office is public. Set it and restart.\n');
  process.exit(1);
}
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
// Health check stays open so the host can tell the app is up.
app.get('/healthz', (_req, res) => res.send('ok'));

// ------------------------------------------------ report portal (public)
// The monthly report portal is used by the marketing team, who don't get the
// office password. It is served here so its submissions reach the office.
// Set PORTAL_CODE to require a shared code for submissions.
const PORTAL_CODE = process.env.PORTAL_CODE || '';
const ROLE_NAMES = { media: 'Media & Budget', design: 'Design, BMS & Social', pr: 'PR, Events & Influencers', asd: 'ASD' };
app.use('/portal', express.static(path.join(here, '..', 'portal')));
app.post('/api/portal/submit', express.json({ limit: '1mb' }), async (req, res) => {
  if (PORTAL_CODE && !same(String(req.get('x-portal-code') || ''), PORTAL_CODE)) return res.status(401).json({ error: 'portal code required' });
  const { user, role, month, fields = [], filled = 0, total = 0, tags = {} } = req.body ?? {};
  if (!user || !role || !month || !Array.isArray(fields)) return res.status(400).json({ error: 'user, role, month and fields required' });
  const clean = (v) => String(v ?? '').replace(/[|\r\n]+/g, ' ').slice(0, 2000);
  const section = ROLE_NAMES[role] ?? role;
  const md = [
    `# التقرير الشهري — ${clean(month)} — ${section}`,
    '',
    `- **عبّاه:** ${clean(user)}`,
    `- **وقت الإرسال:** ${new Date().toISOString()}`,
    `- **الحقول المعبّاة:** ${Number(filled) || 0} / ${Number(total) || 0}`,
    '',
    '| الحقل | المفتاح | القيمة |',
    '|---|---|---|',
    ...fields.slice(0, 300).map((f) => `| ${clean(f.label)} | ${clean(f.id)} | ${clean(f.value)} |`),
    ...Object.entries(tags || {}).map(([k, v]) => `| ${clean(k)} | tags | ${clean(Array.isArray(v) ? v.join(', ') : v)} |`),
  ].join('\n');
  try {
    const name = `portal-${clean(month).replace(/\s+/g, '-')}-${role}.md`;
    const f = await addFile(Buffer.from(md), name, { by: clean(user), category: 'portal', key: `portal:${clean(month)}:${role}` });
    const preview = fields.slice(0, 4).map((x) => `${clean(x.label)}: ${clean(x.value)}`).join('، ');
    setSummary(f.id, `قسم ${section} لشهر ${clean(month)} من ${clean(user)} — ${preview}`);
    addInbox({ from: 'portal', title: `📊 بوابة التقرير: ${section} — ${clean(user)} (${clean(month)})`, body: md });
    log('portal', `وصل قسم ${section} لشهر ${clean(month)} من ${clean(user)} (${Number(filled) || 0}/${Number(total) || 0} حقل).`);
    addMemory({ kind: 'note', title: `بوابة التقرير: ${section} — ${clean(month)}`, text: `أرسل ${clean(user)} أرقام قسم ${section}. ${preview}. الملف الكامل: ${f.id}.`, by: 'portal' });
    res.json({ ok: true, fileId: f.id });
  } catch (err) {
    console.error('[portal] submit failed:', err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// --------------------------------------------- automated file ingest (token)
// For scheduled exports (Power Automate, scripts): POST a file with
// "Authorization: Bearer <INGEST_TOKEN>" and ?category=leads|emails|budget.
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
app.post('/api/ingest/file', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!INGEST_TOKEN || !token || !same(token, INGEST_TOKEN)) return res.status(401).json({ error: 'invalid token' });
  const category = req.query.category ? String(req.query.category) : null;
  if (category && (!CATEGORIES[category] || category === 'portal')) return res.status(400).json({ error: 'category must be leads, emails or budget' });
  const name = decodeURIComponent(String(req.get('x-file-name') || req.query.name || '')).replace(/[\\/]/g, '_').trim();
  if (!name || !req.body?.length) return res.status(400).json({ error: 'file name and body required' });
  try {
    const f = await addFile(req.body, name, { by: 'automation', category });
    summarizeFile(f);
    res.json({ ok: true, fileId: f.id });
  } catch (err) {
    res.status(400).json({ error: String(err?.message ?? err) });
  }
});
if (PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (same(pass, PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Office Studio", charset="UTF-8"');
    res.status(401).send('Password required');
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, '..', 'public')));
app.use('/vendor/three', express.static(path.join(here, '..', 'node_modules', 'three')));

const snapshot = () => ({
  live: LIVE,
  keyInfo,
  model: MODEL,
  company: state.company,
  departments: DEPARTMENTS,
  employees: Object.values(state.employees),
  openPositions: openPositions(),
  hiringQueue: state.hiringQueue,
  tasks: state.tasks.slice(0, 30),
  inbox: state.inbox.slice(0, 100),
  chat: state.chat.slice(-150),
  meetings: state.meetings.slice(0, 20),
  files: state.files,
  categories: CATEGORIES,
  ingestEnabled: Boolean(INGEST_TOKEN),
  portalCodeSet: Boolean(PORTAL_CODE),
  memory: state.memory,
});

// Long-running work runs in the background; the UI follows it over SSE.
const background = (res, fn) => {
  fn().catch((err) => {
    console.error(err);
    emit('error', { message: friendlyError(err) });
  });
  res.status(202).json({ ok: true });
};

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  bus.on('event', send);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

app.post('/api/request', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  background(res, () => runRequest(text));
});

// Hiring is queued: the response comes back at once and the queue shows progress.
const reply = (res, fn) => {
  try {
    res.json(fn());
  } catch (err) {
    res.status(400).json({ error: String(err?.message ?? err) });
  }
};

app.post('/api/hire', (req, res) => {
  const { positionId, customRole } = req.body ?? {};
  if (!positionId && !String(customRole ?? '').trim()) return res.status(400).json({ error: 'positionId or customRole required' });
  reply(res, () => enqueueHire({ positionId, customRole }));
});

app.post('/api/hire-all', (_req, res) => {
  reply(res, () => openPositions().map((p) => enqueueHire({ positionId: p.id })));
});

app.post('/api/hire/:id/retry', (req, res) => {
  reply(res, () => retryHire(req.params.id));
});

app.post('/api/meeting', (req, res) => {
  const { topic, participantIds } = req.body ?? {};
  if (!topic || !participantIds?.length) return res.status(400).json({ error: 'topic and participantIds required' });
  background(res, () => holdMeeting({ topic, participantIds }));
});

app.post('/api/dm/:id', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  background(res, () => directMessage(req.params.id, text));
});

// ------------------------------------------------------- company files
app.post('/api/files', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  const name = decodeURIComponent(String(req.get('x-file-name') || '')).replace(/[\\/]/g, '_').trim();
  if (!name || !req.body?.length) return res.status(400).json({ error: 'اسم الملف أو محتواه مفقود' });
  try {
    const category = String(req.get('x-file-category') || '') || null;
    if (category && (!CATEGORIES[category] || category === 'portal')) return res.status(400).json({ error: 'تصنيف غير معروف' });
    const f = await addFile(req.body, name, { category });
    summarizeFile(f);
    res.json(f);
  } catch (err) {
    res.status(400).json({ error: String(err?.message ?? err) });
  }
});

app.get('/api/files/:id/download', (req, res) => {
  const b = fileBlob(req.params.id);
  if (!b) return res.status(404).send('Not found');
  res.download(b.path, b.file.name);
});

app.post('/api/files/:id/delete', (req, res) => {
  reply(res, () => (removeFile(req.params.id), { ok: true }));
});

// --------------------------------------------------------- team memory
app.post('/api/memory', (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  reply(res, () => addMemory({ kind: 'note', title: title || 'ملاحظة من المالك', text, by: 'owner' }));
});

app.post('/api/memory/:id/delete', (req, res) => {
  reply(res, () => (removeMemory(req.params.id), { ok: true }));
});

app.post('/api/company', (req, res) => {
  const { name, about } = req.body ?? {};
  if (name) state.company.name = String(name);
  if (about) state.company.about = String(about);
  save();
  emit('company', { company: state.company });
  res.json(state.company);
});

app.post('/api/inbox/:id/read', (req, res) => {
  const item = state.inbox.find((i) => i.id === req.params.id);
  if (item) item.read = true;
  save();
  res.json({ ok: true });
});

app.post('/api/reset', (_req, res) => {
  reset();
  res.json(snapshot());
});

const PORT = Number(process.env.PORT || 4241);
app.listen(PORT, HOST, () => {
  pumpHiring();
  seedBuiltins().catch((err) => console.error('[files] seeding failed:', err));
  console.log(`\n  🏢 AI Office Studio → http://${HOST}:${PORT}${PASSWORD ? '  (password protected)' : ''}`);
  console.log(LIVE ? `  ✅ Live mode (model: ${MODEL})` : '  🧪 Demo mode — set ANTHROPIC_API_KEY for real agents');
  console.log('');
});
