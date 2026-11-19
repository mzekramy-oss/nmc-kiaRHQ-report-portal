import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, bus, save, reset, emit } from './store.js';
import { DEPARTMENTS } from './roster.js';
import { LIVE, MODEL, runRequest, hire, holdMeeting, directMessage, openPositions } from './agents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
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
  tasks: state.tasks.slice(0, 30),
  inbox: state.inbox.slice(0, 100),
  chat: state.chat.slice(-150),
  meetings: state.meetings.slice(0, 20),
});

// Long-running work runs in the background; the UI follows it over SSE.
const background = (res, fn) => {
  fn().catch((err) => {
    console.error(err);
    let message = String(err?.message ?? err);
    if (err instanceof Anthropic.AuthenticationError) message = 'مفتاح ANTHROPIC_API_KEY غير صحيح. حدّثه في ملف .env وأعد تشغيل السيرفر.';
    else if (err instanceof Anthropic.RateLimitError) message = 'تم تجاوز حد الاستخدام مؤقتاً. انتظر قليلاً وحاول مرة أخرى.';
    emit('error', { message });
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

app.post('/api/hire', (req, res) => {
  const { positionId, customRole } = req.body ?? {};
  if (!positionId && !customRole) return res.status(400).json({ error: 'positionId or customRole required' });
  background(res, () => hire({ positionId, customRole }));
});

app.post('/api/hire-all', (_req, res) => {
  background(res, async () => {
    for (const p of openPositions()) await hire({ positionId: p.id });
  });
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
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🏢 AI Office Studio → http://127.0.0.1:${PORT}`);
  console.log(LIVE ? `  ✅ Live mode (model: ${MODEL})` : '  🧪 Demo mode — set ANTHROPIC_API_KEY for real agents');
  console.log('');
});
