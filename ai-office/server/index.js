import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { state, bus, save, reset, emit } from './store.js';
import { DEPARTMENTS } from './roster.js';
import { LIVE, MODEL, runRequest, holdMeeting, directMessage, openPositions, enqueueHire, retryHire, pumpHiring, friendlyError } from './agents.js';

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
  console.log(`\n  🏢 AI Office Studio → http://${HOST}:${PORT}${PASSWORD ? '  (password protected)' : ''}`);
  console.log(LIVE ? `  ✅ Live mode (model: ${MODEL})` : '  🧪 Demo mode — set ANTHROPIC_API_KEY for real agents');
  console.log('');
});
