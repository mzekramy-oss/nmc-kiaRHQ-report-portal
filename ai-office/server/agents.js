// The brain of the office: one General Manager agent (Rami) that owns every
// request and delegates to specialist employee agents through tool calls.
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { POSITIONS, DEPARTMENTS, positionById } from './roster.js';
import { state, save, emit, setStatus, log, addInbox, newId } from './store.js';
import { knowledgeBlock, knowledgeTools, addMemory, fileText, imageBlock, setSummary } from './knowledge.js';

export const MODEL = process.env.OFFICE_MODEL || 'claude-opus-5-5';
export const LIVE = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OFFICE_LIVE === '1',
);

// Keys pasted into a dashboard often pick up invisible characters (spaces,
// quotes, Arabic direction marks). A real key is plain ASCII with no spaces,
// so keep only that.
const RAW_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const API_KEY = RAW_KEY.replace(/[^\x21-\x7E]/g, '').replace(/^['"]+|['"]+$/g, '');

/** Safe-to-show summary of the configured key (never the key itself). */
export const keyInfo = {
  set: Boolean(API_KEY),
  prefix: API_KEY.slice(0, 10),
  suffix: API_KEY.slice(-4),
  length: API_KEY.length,
  cleaned: RAW_KEY.length !== API_KEY.length,
  looksValid: /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(API_KEY),
};
if (API_KEY) {
  console.log(`  🔑 API key: ${keyInfo.prefix}…${keyInfo.suffix} (${keyInfo.length} chars)${keyInfo.cleaned ? ' — removed hidden characters' : ''}${keyInfo.looksValid ? '' : ' — does not look like an Anthropic key'}`);
}

let client = null;
const api = () => (client ??= API_KEY ? new Anthropic({ apiKey: API_KEY }) : new Anthropic());

// Shared request settings. `fallbacks: "default"` lets the API re-run a
// request on a fallback model if the primary model declines it.
const base = (effort) => ({
  model: MODEL,
  max_tokens: 16000,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  output_config: { effort },
});

/** Turn an API/SDK error into a short Arabic message the owner can act on. */
export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'مفتاح ANTHROPIC_API_KEY غير صحيح. حدّثه وأعد التشغيل.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'المفتاح لا يملك صلاحية لهذا النموذج.';
  if (err instanceof Anthropic.RateLimitError) return 'تم تجاوز حد الاستخدام مؤقتاً. انتظر قليلاً وأعد المحاولة.';
  if (err instanceof Anthropic.BadRequestError) {
    const m = String(err.message ?? '');
    if (/credit balance/i.test(m)) return 'رصيد Anthropic غير كافٍ. اشحن الرصيد من console.anthropic.com.';
    return `طلب غير صالح: ${m.slice(0, 300)}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'تعذّر الاتصال بـ Claude API. أعد المحاولة.';
  if (err instanceof Anthropic.APIError) return `خطأ من Claude API (${err.status}): ${String(err.message).slice(0, 200)}`;
  return String(err?.message ?? err);
}

function isSystemic(err) {
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    (err instanceof Anthropic.BadRequestError && /credit balance/i.test(String(err.message)))
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (t, n = 140) => (t.length > n ? `${t.slice(0, n).trim()}…` : t);

function textOf(message) {
  if (message.stop_reason === 'refusal') {
    return '⚠️ اعتذر النموذج عن تنفيذ هذا الطلب. جرّب صياغة مختلفة.';
  }
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function companyBlock() {
  const c = state.company;
  return `Company: ${c.name}\nAbout the company: ${c.about}`;
}

function teamList({ excludeLead = true } = {}) {
  return Object.values(state.employees)
    .filter((e) => !(excludeLead && e.lead))
    .map((e) => `- ${e.id}: ${e.name} — ${e.role} (${DEPARTMENTS[e.dept]?.label ?? e.dept}). ${e.brief}`)
    .join('\n');
}

function systemFor(emp) {
  const jd = emp.jd ? `\n\nYour job description (written by HR):\n${emp.jd}` : '';
  return [
    `You are ${emp.name} (${emp.nameAr ?? emp.name}), the ${emp.role} at ${state.company.name}.`,
    `Your responsibilities: ${emp.brief}${jd}`,
    '',
    companyBlock(),
    '',
    'You work inside an AI team led by Rami, the General Manager. Tasks reach you from Rami or directly from the owner.',
    'Deliver finished, usable work (plans, copy, tables, scripts, checklists), not advice about how to do the work.',
    'If something essential is unknown, state your assumption in one line and continue.',
    'Reply in the language the task is written in; default to Arabic (Saudi-friendly, professional).',
    'Use clear Markdown headings and tables where they help. Keep it focused.',
    'Check the company files and team memory below for anything relevant before you start; cite the file or earlier work you used.',
    '',
    knowledgeBlock(),
  ].join('\n');
}

function gmSystem() {
  return [
    `You are Rami (رامي), the General Manager of ${state.company.name}'s AI team. You are responsible for every piece of work the team does.`,
    companyBlock(),
    '',
    'Your team (employee_id: name — role):',
    teamList(),
    '',
    'How you work:',
    '1. Read the owner\'s request and break it into concrete tasks.',
    '2. Assign each task to the best-fitting employee with the assign_task tool. Give each one a precise brief with everything they need. Assign independent tasks in the same turn so they run in parallel; assign dependent tasks after their inputs are back, passing the earlier results along.',
    '3. Use hold_meeting only when several people must agree on one decision.',
    '4. If no current employee fits a needed skill, use hire_employee; HR writes the job description and the new hire joins.',
    '5. Review what comes back. If something is weak, send it back with specific notes.',
    '6. Finish with one consolidated deliverable for the owner: a short executive summary, then the combined work, then next steps with owners.',
    'Do simple questions yourself without delegating. Reply in the owner\'s language (default Arabic).',
    'Before planning, check the company files and team memory below. Point employees to the file ids and earlier work they should use.',
    '',
    knowledgeBlock(),
  ].join('\n');
}

// ---------------------------------------------------------------- employees

async function runEmployee(emp, task, { context = '', effort = 'medium', onRead, onPast } = {}) {
  setStatus(emp.id, 'working', short(task, 80));
  emit('say', { id: emp.id, text: 'جاري العمل…' });
  try {
    let out;
    if (!LIVE) {
      await sleep(2500 + Math.random() * 3000);
      // In demo mode, pretend to read one current file so the Sources list can be checked.
      const files = (state.files ?? []).filter((f) => !f.superseded);
      if (files.length && onRead) onRead(files[Math.floor(Math.random() * files.length)]);
      out = demoAnswer(emp, task);
    } else {
      const params = {
        ...base(effort),
        system: systemFor(emp),
        messages: [{ role: 'user', content: context ? `${task}\n\n---\nContext:\n${context}` : task }],
      };
      const tools = knowledgeTools({
        onRead: (f) => (emit('say', { id: emp.id, text: `أقرأ ملف: ${f.name}` }), onRead?.(f)),
        onPast,
      });
      if (emp.webSearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 6 });
      const runner = api().beta.messages.toolRunner({ ...params, tools });
      out = textOf(await runner.runUntilDone());
    }
    emit('say', { id: emp.id, text: 'خلصت ✅' });
    return out;
  } finally {
    setStatus(emp.id, 'idle');
  }
}

// --------------------------------------------------------------------- HR

const JD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short first name in English letters' },
    nameAr: { type: 'string', description: 'Same first name in Arabic' },
    role: { type: 'string', description: 'Job title in English' },
    roleAr: { type: 'string', description: 'Job title in Arabic' },
    dept: { type: 'string', enum: Object.keys(DEPARTMENTS) },
    brief: { type: 'string', description: 'One-sentence summary of responsibilities, in English' },
    jd: { type: 'string', description: 'Full job description in Arabic Markdown: mission, responsibilities, deliverables, KPIs, tools, who they work with' },
  },
  required: ['name', 'nameAr', 'role', 'roleAr', 'dept', 'brief', 'jd'],
  additionalProperties: false,
};

const PALETTE = {
  skin: ['#8d5a3b', '#a8714c', '#c99a76', '#d6a985', '#9a6644', '#b88866'],
  hair: ['#111', '#1b1410', '#2b1d14', '#3a2416', '#181818'],
  suit: ['#2f2f35', '#3a3a3f', '#283548', '#4b3b5b', '#5c4a3a', '#2d3b2d'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function openPositions() {
  const builtIn = POSITIONS.filter((p) => !state.employees[p.id]);
  const custom = state.customPositions.filter((p) => !state.employees[p.id]);
  return [...builtIn, ...custom];
}

const hiring = new Set();

// ------------------------------------------------------------ hiring queue
// Every hire goes through one queue so Layla writes one job description at a
// time and the owner can always see what is queued, in progress or failed.
const emitQueue = () => {
  // Keep the list short: drop old finished entries.
  const q = state.hiringQueue;
  while (q.length > 40 && q.findIndex((x) => x.status === 'done') >= 0) q.splice(q.findIndex((x) => x.status === 'done'), 1);
  save();
  emit('hiring', { queue: q });
};

export function enqueueHire({ positionId, customRole }) {
  const preset = positionId ? positionById(positionId) : null;
  if (positionId && !preset) throw new Error(`Unknown position ${positionId}`);
  if (preset && state.employees[preset.id]) throw new Error(`${preset.nameAr} موجود في الفريق بالفعل`);
  const key = preset ? preset.id : `custom:${customRole.trim()}`;
  const existing = state.hiringQueue.find((x) => x.key === key && x.status !== 'done');
  if (existing) {
    // Re-asking for a role that failed puts it back in the queue.
    if (existing.status === 'failed') return retryHire(existing.id);
    return existing;
  }
  const item = {
    id: newId('h'), key, positionId: preset?.id, customRole: preset ? undefined : customRole.trim(),
    title: preset ? `${preset.roleAr} — ${preset.nameAr}` : customRole.trim(),
    status: 'queued', at: new Date().toISOString(),
  };
  state.hiringQueue.push(item);
  emitQueue();
  pumpHiring();
  return item;
}

export function retryHire(id) {
  const item = state.hiringQueue.find((x) => x.id === id);
  if (!item || item.status !== 'failed') throw new Error('Nothing to retry');
  item.status = 'queued';
  item.error = undefined;
  emitQueue();
  pumpHiring();
  return item;
}

let pumping = false;
export async function pumpHiring() {
  if (pumping) return;
  pumping = true;
  try {
    let item;
    while ((item = state.hiringQueue.find((x) => x.status === 'queued'))) {
      item.status = 'writing';
      item.startedAt = new Date().toISOString();
      emitQueue();
      console.log(`[hire] start ${item.title}`);
      try {
        const e = await hire({ positionId: item.positionId, customRole: item.customRole });
        item.status = 'done';
        item.employeeId = e.id;
        console.log(`[hire] done ${item.title} -> ${e.id}`);
      } catch (err) {
        console.error(`[hire] failed ${item.title}:`, err);
        item.status = 'failed';
        item.error = friendlyError(err);
        // A bad key or an empty balance fails every hire the same way:
        // stop the queue and say it once instead of once per role.
        const systemic = isSystemic(err);
        const stopped = [];
        if (systemic) {
          for (const x of state.hiringQueue) {
            if (x.status === 'queued') {
              x.status = 'failed';
              x.error = item.error;
              stopped.push(x);
            }
          }
        }
        const what = stopped.length ? `توقف التوظيف (${stopped.length + 1} وظائف)` : `تعذّر توظيف «${item.title}»`;
        log('layla', `⚠️ ${what}: ${item.error}`);
        emit('error', { message: `${what}: ${item.error}` });
      }
      emitQueue();
    }
  } finally {
    pumping = false;
  }
}

/** HR writes the JD, then the new employee joins the office. */
export async function hire({ positionId, customRole }) {
  const hr = state.employees.layla;
  if (!hr) throw new Error('HR (Layla) is not hired');
  const preset = positionId ? positionById(positionId) : null;
  if (positionId && !preset) throw new Error(`Unknown position ${positionId}`);
  if (preset && state.employees[preset.id]) return state.employees[preset.id];
  const key = preset?.id ?? customRole;
  if (hiring.has(key)) throw new Error('Already hiring for this role');
  hiring.add(key);

  const title = preset ? preset.role : customRole;
  setStatus(hr.id, 'working', `Job description: ${title}`);
  emit('say', { id: hr.id, text: `أكتب الوصف الوظيفي: ${title}` });
  log('layla', `بدأت كتابة الوصف الوظيفي لوظيفة: ${title}`);

  try {
    let data;
    if (!LIVE) {
      await sleep(1800);
      data = preset
        ? { ...preset, jd: demoJD(preset) }
        : {
            name: 'Adam', nameAr: 'آدم', role: customRole, roleAr: customRole, dept: 'operations',
            brief: `Handles: ${customRole}`, jd: demoJD({ role: customRole, roleAr: customRole, brief: customRole }),
          };
    } else {
      const ask = preset
        ? `Write the job description for our new ${preset.role} (${preset.roleAr}), named ${preset.name} (${preset.nameAr}), department ${preset.dept}. Responsibilities: ${preset.brief}\nKeep name, role, roleAr and dept exactly as given.`
        : `The owner wants to hire for this role: "${customRole}". Pick a fitting first name, job title, department, and write the job description.`;
      const msg = await api().beta.messages.create({
        ...base('low'),
        output_config: { effort: 'low', format: { type: 'json_schema', schema: JD_SCHEMA } },
        system: systemFor(hr),
        messages: [{ role: 'user', content: `${ask}\n\nCurrent team:\n${teamList({ excludeLead: false })}` }],
      });
      if (msg.stop_reason === 'refusal') throw new Error('HR request was declined by the model');
      data = JSON.parse(textOf(msg));
      if (preset) data = { ...preset, jd: data.jd };
    }

    const id = preset?.id ?? `${data.name.toLowerCase().replace(/[^a-z]/g, '') || 'emp'}_${Date.now().toString(36).slice(-3)}`;
    const employee = {
      ...(preset ?? {}),
      id,
      name: data.name,
      nameAr: data.nameAr,
      role: data.role,
      roleAr: data.roleAr,
      dept: DEPARTMENTS[data.dept] ? data.dept : 'operations',
      brief: data.brief,
      look: preset?.look ?? { skin: pick(PALETTE.skin), hair: pick(PALETTE.hair), suit: pick(PALETTE.suit), gender: pick(['m', 'f']) },
      jd: data.jd,
      status: 'idle',
      hiredAt: new Date().toISOString(),
    };
    state.employees[id] = employee;
    save();
    emit('hired', { employee });
    log('layla', `انضم ${employee.nameAr} (${employee.roleAr}) للفريق. الوصف الوظيفي في صندوق الوارد.`);
    addInbox({ from: 'layla', title: `الوصف الوظيفي: ${employee.roleAr} — ${employee.nameAr}`, body: employee.jd });
    return employee;
  } finally {
    hiring.delete(key);
    setStatus(hr.id, 'idle');
  }
}

// ---------------------------------------------------------------- meetings

export async function holdMeeting({ topic, participantIds }) {
  const gm = state.employees.rami;
  const people = participantIds.map((id) => state.employees[id]).filter((e) => e && !e.lead);
  if (!people.length) throw new Error('No valid participants');
  const meeting = { id: newId('meet'), topic, participants: people.map((p) => p.id), transcript: [], at: new Date().toISOString() };
  state.meetings.unshift(meeting);
  emit('meeting_start', { meeting: { ...meeting, participants: [gm.id, ...meeting.participants] } });
  log('rami', `📅 اجتماع في غرفة الاجتماعات: ${topic}`);

  try {
    for (const p of people) {
      const sofar = meeting.transcript.map((t) => `${state.employees[t.id]?.name}: ${t.text}`).join('\n\n');
      const text = await runEmployee(
        p,
        `Meeting led by Rami. Topic: ${topic}\nGive your input from your role's angle in at most 120 words. Build on what colleagues said; don't repeat it.`,
        { context: sofar, effort: 'low' },
      );
      meeting.transcript.push({ id: p.id, text });
      emit('say', { id: p.id, text: short(text, 90) });
      log(p.id, text, { meeting: meeting.id });
    }
    setStatus(gm.id, 'working', 'Closing the meeting');
    let decision;
    if (!LIVE) {
      await sleep(1500);
      decision = `**قرارات الاجتماع (${topic})**\n\n${people.map((p) => `- ${p.nameAr}: ينفّذ الجزء الخاص بـ ${p.roleAr}.`).join('\n')}\n- المتابعة بعد أسبوع.`;
    } else {
      const msg = await api().beta.messages.create({
        ...base('medium'),
        system: gmSystem(),
        messages: [{
          role: 'user',
          content: `You just ran a meeting on: ${topic}\n\nTranscript:\n${meeting.transcript.map((t) => `${state.employees[t.id].name}: ${t.text}`).join('\n\n')}\n\nClose the meeting: decisions, owners, deadlines. Short.`,
        }],
      });
      decision = textOf(msg);
    }
    meeting.decision = decision;
    addMemory({ kind: 'meeting', title: `اجتماع: ${topic}`, text: short(decision.replace(/\s+/g, ' '), 600), ref: meeting.id });
    log('rami', decision, { meeting: meeting.id });
    addInbox({ from: 'rami', title: `محضر اجتماع: ${topic}`, body: `${meeting.transcript.map((t) => `### ${state.employees[t.id].nameAr}\n${t.text}`).join('\n\n')}\n\n---\n${decision}` });
    return decision;
  } finally {
    setStatus(gm.id, 'idle');
    save();
    emit('meeting_end', { id: meeting.id });
  }
}

// ------------------------------------------------------------ the GM loop

export async function runRequest(request) {
  const gm = state.employees.rami;
  const task = { id: newId('task'), request, status: 'running', steps: [], sources: [], at: new Date().toISOString() };
  // Which files and earlier work each agent actually read, for the "Sources" list.
  const addSource = (kind, id, name, by) => {
    let src = task.sources.find((x) => x.kind === kind && x.id === id);
    if (!src) task.sources.push((src = { kind, id, name, by: [] }));
    if (!src.by.includes(by)) src.by.push(by);
  };
  const pastName = (ref) => state.tasks.find((t) => t.id === ref)?.request ?? state.meetings.find((m) => m.id === ref)?.topic ?? ref;
  const memoryCount = (state.memory ?? []).length;
  state.tasks.unshift(task);
  emit('task', { task });
  log('owner', request, { task: task.id });
  setStatus(gm.id, 'working', 'Planning');
  emit('say', { id: gm.id, text: 'وصلني الطلب، أوزّع المهام…' });

  const assign = async ({ employee_id, task: brief, context = '' }) => {
    const emp = state.employees[employee_id];
    if (!emp || emp.lead) return `No employee with id "${employee_id}". Valid ids: ${Object.keys(state.employees).filter((k) => k !== 'rami').join(', ')}`;
    const step = { id: newId('st'), employee: emp.id, brief, status: 'running' };
    task.steps.push(step);
    emit('assign', { taskId: task.id, step, from: gm.id, to: emp.id });
    log('rami', `@${emp.name} ${brief}`, { task: task.id });
    const result = await runEmployee(emp, brief, {
      context,
      onRead: (f) => addSource('file', f.id, f.name, emp.id),
      onPast: (ref) => addSource('past', ref, pastName(ref), emp.id),
    });
    step.status = 'done';
    step.result = result;
    emit('task', { task });
    log(emp.id, result, { task: task.id });
    return result;
  };

  try {
    let final;
    if (!LIVE) {
      final = await demoGM(request, assign);
    } else {
      const runner = api().beta.messages.toolRunner({
        ...base('high'),
        system: gmSystem(),
        messages: [{ role: 'user', content: request }],
        tools: [
          ...knowledgeTools({
            onRead: (f) => (emit('say', { id: gm.id, text: `أقرأ ملف: ${f.name}` }), addSource('file', f.id, f.name, gm.id)),
            onPast: (ref) => addSource('past', ref, pastName(ref), gm.id),
          }),
          betaTool({
            name: 'assign_task',
            description: 'Assign a task to one employee and get their finished work back. Call several in one turn for independent tasks.',
            inputSchema: {
              type: 'object',
              properties: {
                employee_id: { type: 'string', description: 'The employee id from the team list' },
                task: { type: 'string', description: 'A precise, self-contained brief' },
                context: { type: 'string', description: 'Earlier results or facts this employee needs' },
              },
              required: ['employee_id', 'task'],
            },
            run: (input) => assign(input),
          }),
          betaTool({
            name: 'hold_meeting',
            description: 'Gather several employees in the meeting room to discuss one decision. Returns the decisions.',
            inputSchema: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                participant_ids: { type: 'array', items: { type: 'string' } },
              },
              required: ['topic', 'participant_ids'],
            },
            run: ({ topic, participant_ids }) => holdMeeting({ topic, participantIds: participant_ids }),
          }),
          betaTool({
            name: 'hire_employee',
            description: `Ask HR to hire someone. Use a position_id from the open positions when one fits (${openPositions().map((p) => `${p.id}: ${p.role}`).join('; ') || 'none open'}), otherwise describe the role in custom_role.`,
            inputSchema: {
              type: 'object',
              properties: {
                position_id: { type: 'string' },
                custom_role: { type: 'string' },
              },
            },
            run: async ({ position_id, custom_role }) => {
              const e = await hire({ positionId: position_id, customRole: position_id ? undefined : custom_role });
              return `Hired ${e.name} (${e.role}), employee_id "${e.id}". You can assign tasks to them now.`;
            },
          }),
        ],
      });
      final = textOf(await runner.runUntilDone());
    }
    task.status = 'done';
    task.final = final;
    rememberTask(task).catch((err) => console.error('[memory] task note failed:', err));
    log('rami', final, { task: task.id, final: true });
    addInbox({ from: 'rami', title: short(request, 70), body: `${final}\n\n---\n${sourcesText(task.sources, memoryCount)}`, taskId: task.id });
    emit('say', { id: gm.id, text: 'التسليم جاهز في صندوق الوارد 📥' });
    return task;
  } catch (err) {
    task.status = 'failed';
    task.error = String(err?.message ?? err);
    log('rami', `⚠️ تعذّر إكمال الطلب: ${task.error}`, { task: task.id });
    throw err;
  } finally {
    setStatus(gm.id, 'idle');
    emit('task', { task });
    save();
  }
}

// ------------------------------------------------------------- knowledge

/** The "Sources" section shown under every deliverable. */
function sourcesText(sources, memoryCount) {
  const who = (ids) => ids.map((id) => state.employees[id]?.nameAr ?? id).join('، ');
  const files = sources.filter((x) => x.kind === 'file');
  const past = sources.filter((x) => x.kind === 'past');
  const lines = ['### 📚 المصادر'];
  if (files.length) lines.push(...files.map((x) => {
    const f = state.files?.find((y) => y.id === x.id);
    return `- 📄 ${x.name}${f ? ` (نسخة ${f.at.slice(0, 10)})` : ''} — قرأه: ${who(x.by)}`;
  }));
  if (past.length) lines.push(...past.map((x) => `- 📋 شغل سابق: ${x.name} — رجع له: ${who(x.by)}`));
  if (!files.length && !past.length) lines.push('- ما انقرأ أي ملف أو شغل سابق في هذي المهمة.');
  lines.push(`- 🧠 ذاكرة الفريق: ${memoryCount} ملاحظة كانت قدام الفريق وقت التنفيذ.`);
  return lines.join('\n');
}

/** Rami writes a short memory note after every finished task. */
async function rememberTask(task) {
  let text;
  if (!LIVE) {
    text = short(task.final.replace(/\s+/g, ' '), 400);
  } else {
    const msg = await api().beta.messages.create({
      ...base('low'),
      max_tokens: 4000,
      system: 'You keep the team memory for a company. Write one compact note in Arabic (max 120 words): what was asked, what was delivered or decided, key numbers, and open next steps with owners. No headings.',
      messages: [{ role: 'user', content: `Request: ${task.request}\n\nFinal deliverable:\n${task.final.slice(0, 40000)}` }],
    });
    text = textOf(msg);
  }
  addMemory({ kind: 'task', title: short(task.request, 80), text, ref: task.id });
}

/** A one-line summary for a newly uploaded file, so agents know what's in it. */
export async function summarizeFile(f) {
  try {
    let summary;
    if (!LIVE) {
      summary = f.kind === 'image' ? `صورة: ${f.name}` : short(fileText(f).replace(/\s+/g, ' '), 160);
    } else {
      const content = f.kind === 'image'
        ? [imageBlock(f), { type: 'text', text: `File name: ${f.name}. Describe what this image is in one Arabic sentence.` }]
        : `File name: ${f.name}\n\n${fileText(f).slice(0, 30000)}\n\nSummarize what this file contains in one or two Arabic sentences (what it is, period covered, key figures). Plain text.`;
      const msg = await api().beta.messages.create({ ...base('low'), max_tokens: 3000, messages: [{ role: 'user', content }] });
      summary = textOf(msg);
    }
    setSummary(f.id, short(summary, 300));
  } catch (err) {
    console.error('[files] summary failed:', err);
    setSummary(f.id, f.name);
  }
}

// -------------------------------------------------------- direct messages

export async function directMessage(id, text) {
  const emp = state.employees[id];
  if (!emp) throw new Error('Unknown employee');
  state.dm ??= {};
  const history = (state.dm[id] ??= []);
  log('owner', `@${emp.name} ${text}`, { dm: id });
  let reply;
  if (!LIVE) {
    setStatus(id, 'working', 'Replying');
    await sleep(1200);
    reply = `أهلاً! أنا ${emp.nameAr}، ${emp.roleAr}. (وضع التجربة: أضف مفتاح ANTHROPIC_API_KEY عشان أرد عليك فعلياً.)`;
    setStatus(id, 'idle');
  } else {
    const messages = [...history.slice(-20), { role: 'user', content: text }];
    setStatus(id, 'working', 'Replying');
    try {
      const runner = api().beta.messages.toolRunner({ ...base('low'), system: emp.lead ? gmSystem() : systemFor(emp), messages, tools: knowledgeTools() });
      reply = textOf(await runner.runUntilDone());
    } finally {
      setStatus(id, 'idle');
    }
  }
  history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
  emit('say', { id, text: short(reply, 90) });
  log(id, reply, { dm: id });
  return reply;
}

// ----------------------------------------------------------- demo mode

function demoAnswer(emp, task) {
  return `**${emp.nameAr} — ${emp.roleAr}**\n\nاستلمت المهمة: «${short(task, 120)}»\n\n- الخطوة 1: تحليل المطلوب من زاوية ${emp.roleAr}.\n- الخطوة 2: تجهيز المخرجات.\n- الخطوة 3: التسليم لرامي للمراجعة.\n\n_(وضع التجربة — شغّل المفتاح للحصول على عمل حقيقي.)_`;
}

function demoJD(p) {
  return `## ${p.roleAr ?? p.role}\n\n**المهمة:** ${p.brief}\n\n### المسؤوليات\n- تنفيذ المهام المسندة من المدير العام.\n- التنسيق مع الفريق.\n- تسليم مخرجات قابلة للاستخدام مباشرة.\n\n### مؤشرات الأداء\n- جودة المخرجات وسرعة التسليم.\n\n_(وضع التجربة)_`;
}

async function demoGM(request, assign) {
  await sleep(1200);
  const words = request.toLowerCase();
  const team = Object.values(state.employees).filter((e) => !e.lead);
  const scored = team
    .map((e) => ({ e, s: [e.role, e.roleAr, e.brief].join(' ').toLowerCase().split(/\W+/).filter((w) => w.length > 3 && words.includes(w)).length }))
    .map((x) => ({ ...x, s: x.s + (x.e.dept === 'marketing' ? 0.5 : 0) + Math.random() * 0.4 }))
    .sort((a, b) => b.s - a.s);
  const chosen = scored.slice(0, Math.min(3, scored.length)).map((x) => x.e);
  const results = await Promise.all(chosen.map((e) => assign({ employee_id: e.id, task: request })));
  return `## ملخص المدير العام\n\nوزّعت الطلب على: ${chosen.map((e) => e.nameAr).join('، ')}.\n\n${results.join('\n\n---\n\n')}\n\n### الخطوات التالية\n- مراجعة المخرجات واعتمادها.`;
}
