// Tiny JSON-file store + event bus. Everything the office shows lives here.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { POSITIONS } from './roster.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR can point at a persistent volume (e.g. /data on Railway).
const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');
const FILE = path.join(DATA_DIR, 'state.json');

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const now = () => new Date().toISOString();
let seq = 0;
export const newId = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

function initialState() {
  const employees = {};
  for (const p of POSITIONS.filter((x) => x.hiredByDefault)) {
    employees[p.id] = { ...p, jd: null, status: 'idle', hiredAt: now() };
  }
  return {
    company: {
      name: 'NMC Kia',
      about: 'وكالة سيارات كيا. نبيع السيارات الجديدة، ونقدم الصيانة وقطع الغيار، ونسوّق عبر السوشال ميديا والإعلانات المدفوعة.',
    },
    employees,
    customPositions: [],
    hiringQueue: [],
    tasks: [],
    inbox: [],
    chat: [],
    meetings: [],
  };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Nobody is "working" after a restart.
    for (const e of Object.values(s.employees)) e.status = 'idle';
    s.hiringQueue ??= [];
    // A hire interrupted by a restart goes back in the queue.
    for (const q of s.hiringQueue) if (q.status === 'writing') q.status = 'queued';
    return s;
  } catch {
    return initialState();
  }
}

export const state = load();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  }, 200);
}

export function emit(type, payload = {}) {
  bus.emit('event', { type, at: now(), ...payload });
}

export function setStatus(id, status, note = '') {
  const e = state.employees[id];
  if (!e) return;
  e.status = status;
  e.note = note;
  emit('status', { id, status, note });
}

export function log(from, text, extra = {}) {
  const entry = { id: newId('m'), at: now(), from, text, ...extra };
  state.chat.push(entry);
  if (state.chat.length > 400) state.chat.splice(0, state.chat.length - 400);
  emit('chat', { entry });
  save();
  return entry;
}

export function addInbox(item) {
  const entry = { id: newId('in'), at: now(), read: false, ...item };
  state.inbox.unshift(entry);
  emit('inbox', { entry });
  save();
  return entry;
}

export function reset() {
  const fresh = initialState();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  save();
  emit('reset');
}
