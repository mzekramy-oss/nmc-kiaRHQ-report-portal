// Company knowledge shared by every agent: uploaded files and team memory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { state, save, emit, newId, DATA_DIR } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES_DIR = path.join(DATA_DIR, 'files');
const BUILTIN_DIR = path.join(here, '..', 'knowledge');

export const MAX_UPLOAD = 25 * 1024 * 1024;

// Fixed slots for files the owner refreshes regularly. Uploading a new file
// into a slot makes it the current version; older versions stay downloadable
// but agents only see the latest.
export const CATEGORIES = {
  leads: { label: 'Leads dashboard', labelAr: 'داشبورد الليدز' },
  emails: { label: 'Emails dashboard', labelAr: 'داشبورد الإيميلات' },
  budget: { label: 'Budget dashboard', labelAr: 'داشبورد الميزانية' },
  portal: { label: 'Monthly report portal', labelAr: 'بوابة التقرير الشهري' },
};
const MAX_TOOL_TEXT = 60000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.tsv', '.log', '.xml']);

const ext = (name) => path.extname(name).toLowerCase();
const textPath = (f) => path.join(FILES_DIR, `${f.id}.txt`);
const blobPath = (f) => path.join(FILES_DIR, `${f.id}${ext(f.name)}`);

function ensureDirs() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// ------------------------------------------------------------- extraction

async function extractText(buf, name) {
  const e = ext(name);
  if (TEXT_EXT.has(e)) return buf.toString('utf8');
  if (e === '.html' || e === '.htm') {
    return buf
      .toString('utf8')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  }
  if (e === '.pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: false });
    return text.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n');
  }
  if (e === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (e === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const out = [];
    wb.eachSheet((ws) => {
      out.push(`--- Sheet: ${ws.name} ---`);
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells = row.values.slice(1).map((v) => {
          if (v == null) return '';
          if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((r) => r.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v));
          return String(v);
        });
        out.push(cells.join(' | '));
      });
    });
    return out.join('\n');
  }
  if (IMAGE_TYPES[e]) return null; // Images are passed to the model as images.
  throw new Error(`نوع الملف ${e || 'غير معروف'} غير مدعوم. الأنواع المدعومة: PDF, Word (.docx), Excel (.xlsx), CSV, TXT, صور`);
}

// ------------------------------------------------------------------ files

/** Save an uploaded file, extract its text, and register it. */
export async function addFile(buf, name, { by = 'owner', builtin = false, category = null, key = null } = {}) {
  ensureDirs();
  if (buf.length > MAX_UPLOAD) throw new Error('حجم الملف أكبر من 25MB');
  if (category && !CATEGORIES[category]) throw new Error(`Unknown category ${category}`);
  const text = await extractText(buf, name);
  const f = {
    id: newId('f'),
    name,
    size: buf.length,
    kind: text == null ? 'image' : 'text',
    chars: text?.length ?? 0,
    by,
    builtin,
    category,
    key: key ?? (category && category !== 'portal' ? category : null),
    superseded: false,
    summary: '',
    at: new Date().toISOString(),
  };
  fs.writeFileSync(blobPath(f), buf);
  if (text != null) fs.writeFileSync(textPath(f), text);
  state.files ??= [];
  // A new version replaces the previous one in the same slot.
  if (f.key) for (const old of state.files) if (old.key === f.key && !old.superseded) old.superseded = true;
  state.files.unshift(f);
  save();
  emit('files', { files: state.files });
  return f;
}

export function setSummary(id, summary) {
  const f = state.files?.find((x) => x.id === id);
  if (!f) return;
  f.summary = summary;
  save();
  emit('files', { files: state.files });
}

export function removeFile(id) {
  const i = (state.files ?? []).findIndex((x) => x.id === id);
  if (i < 0) throw new Error('الملف غير موجود');
  const [f] = state.files.splice(i, 1);
  for (const p of [blobPath(f), textPath(f)]) fs.rmSync(p, { force: true });
  save();
  emit('files', { files: state.files });
}

export function fileBlob(id) {
  const f = state.files?.find((x) => x.id === id);
  if (!f) return null;
  return { file: f, path: blobPath(f) };
}

export function fileText(f) {
  try {
    return fs.readFileSync(textPath(f), 'utf8');
  } catch {
    return '';
  }
}

export function imageBlock(f) {
  const data = fs.readFileSync(blobPath(f)).toString('base64');
  return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext(f.name)], data } };
}

/** Add the built-in knowledge documents (e.g. the report portal guide) once. */
export async function seedBuiltins() {
  if (!fs.existsSync(BUILTIN_DIR)) return;
  state.files ??= [];
  for (const name of fs.readdirSync(BUILTIN_DIR)) {
    if (state.files.some((f) => f.builtin && f.name === name)) continue;
    const buf = fs.readFileSync(path.join(BUILTIN_DIR, name));
    const f = await addFile(buf, name, { by: 'system', builtin: true });
    const firstLine = buf.toString('utf8').split('\n').find((l) => l.startsWith('>'));
    setSummary(f.id, firstLine ? firstLine.replace(/^>\s*/, '') : name);
  }
}

// ----------------------------------------------------------------- memory

export function addMemory({ kind, title, text, ref = null, by = 'rami' }) {
  state.memory ??= [];
  const note = { id: newId('mem'), kind, title, text, ref, by, at: new Date().toISOString() };
  state.memory.unshift(note);
  if (state.memory.length > 200) state.memory.length = 200;
  save();
  emit('memory', { memory: state.memory });
  return note;
}

export function removeMemory(id) {
  const i = (state.memory ?? []).findIndex((x) => x.id === id);
  if (i < 0) throw new Error('الملاحظة غير موجودة');
  state.memory.splice(i, 1);
  save();
  emit('memory', { memory: state.memory });
}

// ------------------------------------------------------- prompt + tools

/** The knowledge section added to every agent's system prompt. */
export function knowledgeBlock() {
  const current = (state.files ?? []).filter((f) => !f.superseded);
  const memory = state.memory ?? [];
  const line = (f) => `- ${f.id}: ${f.name} (updated ${f.at.slice(0, 10)})${f.summary ? ` — ${f.summary}` : ''}`;
  const parts = [];
  parts.push('## Dashboards (latest version of each)');
  const dash = Object.entries(CATEGORIES)
    .filter(([c]) => c !== 'portal')
    .map(([c, meta]) => {
      const f = current.find((x) => x.category === c);
      return f ? `- ${meta.label}: ${line(f).slice(2)}` : `- ${meta.label}: not uploaded yet`;
    });
  parts.push(`These are the owner's live numbers. For leads, emails or budget questions, read the matching file first and say which date it is from.\n${dash.join('\n')}`);
  parts.push('');
  const portal = current.filter((f) => f.category === 'portal');
  if (portal.length) {
    parts.push('## Monthly report portal submissions');
    parts.push(portal.map(line).join('\n'));
    parts.push('');
  }
  const other = current.filter((f) => !f.category || !CATEGORIES[f.category]);
  parts.push('## Company files');
  parts.push(
    other.length
      ? `Read a file with read_company_file before relying on it. Files:\n${other.map(line).join('\n')}`
      : 'No other company files uploaded yet.',
  );
  parts.push('');
  parts.push('## Team memory (newest first)');
  parts.push(
    memory.length
      ? `What the team has already done and decided. Build on it; don't contradict it without saying why. Use read_past_work for a full deliverable.\n${memory
          .slice(0, 40)
          .map((m) => `- [${m.at.slice(0, 10)}] (${m.kind}${m.ref ? ` ${m.ref}` : ''}) ${m.title}: ${m.text}`)
          .join('\n')}`
      : 'Nothing yet.',
  );
  return parts.join('\n');
}

/** Tools every agent gets for reading files and earlier work. */
export function knowledgeTools({ onRead, onPast } = {}) {
  return [
    betaTool({
      name: 'read_company_file',
      description: 'Read one of the company files listed under "Company files". Returns its text (or the image).',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The file id from the list' },
          offset: { type: 'integer', description: 'Character offset for long files (default 0)' },
        },
        required: ['file_id'],
      },
      run: ({ file_id, offset = 0 }) => {
        const f = state.files?.find((x) => x.id === file_id);
        if (!f) return `No file with id "${file_id}".`;
        onRead?.(f);
        if (f.kind === 'image') return [{ type: 'text', text: `Image: ${f.name}` }, imageBlock(f)];
        const text = fileText(f);
        const start = Math.max(0, Number(offset) || 0);
        const chunk = text.slice(start, start + MAX_TOOL_TEXT);
        const more = start + MAX_TOOL_TEXT < text.length ? `\n\n[… ${text.length - start - MAX_TOOL_TEXT} more characters; call again with offset=${start + MAX_TOOL_TEXT}]` : '';
        return `File: ${f.name}\n\n${chunk}${more}`;
      },
    }),
    betaTool({
      name: 'read_past_work',
      description: 'Read the full final deliverable of an earlier task or meeting referenced in Team memory.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'The task or meeting id shown in Team memory' } },
        required: ['ref'],
      },
      run: ({ ref }) => {
        onPast?.(ref);
        const task = state.tasks.find((t) => t.id === ref);
        if (task) return `Request: ${task.request}\n\n${task.final ?? task.error ?? '(no final deliverable)'}`;
        const meeting = state.meetings.find((m) => m.id === ref);
        if (meeting) return `Meeting: ${meeting.topic}\n\n${meeting.transcript.map((t) => `${t.id}: ${t.text}`).join('\n\n')}\n\nDecision:\n${meeting.decision ?? ''}`;
        return `Nothing found for "${ref}".`;
      },
    }),
  ];
}
