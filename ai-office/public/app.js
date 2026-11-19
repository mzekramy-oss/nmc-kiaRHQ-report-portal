import { Office } from './office.js';
import { md } from './markdown.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });

const S = { employees: {}, inbox: [], chat: [], tasks: [], openPositions: [], hiringQueue: [], departments: {}, company: {} };
const prefs = loadPrefs();
let currentPanel = null;
let panelArg = null;

const office = new Office($('#stage'), { onSelect: (id) => openPanel('profile', id) });

// ------------------------------------------------------------------ api
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function boot() {
  const s = await api('/api/state');
  applySnapshot(s);
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
}

function applySnapshot(s) {
  Object.assign(S, s, { employees: Object.fromEntries(s.employees.map((e) => [e.id, e])) });
  const mode = $('#mode');
  mode.textContent = s.live ? `Live · ${s.model}` : 'Demo mode';
  mode.classList.toggle('live', s.live);
  mode.title = s.live ? 'الإيجنتات متصلة بـ Claude API' : 'وضع التجربة: شغّل السيرفر مع ANTHROPIC_API_KEY للحصول على عمل حقيقي';
  office.setDepartments(s.departments);
  office.syncEmployees(s.employees);
  for (const e of s.employees) office.setStatus(e.id, e.status);
  updateBadge();
  updateHiringBadge();
  rerender();
}

// --------------------------------------------------------------- events
function onEvent(ev) {
  switch (ev.type) {
    case 'status':
      if (S.employees[ev.id]) S.employees[ev.id].status = ev.status;
      office.setStatus(ev.id, ev.status);
      if (ev.status === 'working') typing.start();
      else if (!Object.values(S.employees).some((e) => e.status === 'working')) typing.stop();
      if (['team', 'profile'].includes(currentPanel)) rerender();
      break;
    case 'say':
      office.say(ev.id, ev.text);
      break;
    case 'chat':
      S.chat.push(ev.entry);
      tick(`${nameOf(ev.entry.from)}: ${ev.entry.text.split('\n')[0].slice(0, 80)}`);
      if (currentPanel === 'chat' || (currentPanel === 'profile' && ev.entry.dm === panelArg)) appendChat(ev.entry);
      break;
    case 'inbox':
      S.inbox.unshift(ev.entry);
      updateBadge();
      chime();
      toast(`📥 ${nameOf(ev.entry.from)}: ${ev.entry.title}`, () => openPanel('item', ev.entry.id));
      if (prefs.read && ev.entry.from === 'rami') speak(ev.entry.body);
      if (currentPanel === 'inbox') rerender();
      break;
    case 'task': {
      const i = S.tasks.findIndex((t) => t.id === ev.task.id);
      if (i >= 0) S.tasks[i] = ev.task;
      else S.tasks.unshift(ev.task);
      if (currentPanel === 'tasks') rerender();
      break;
    }
    case 'assign':
      tick(`رامي ← ${nameOf(ev.to)}: مهمة جديدة`);
      break;
    case 'hired':
      S.employees[ev.employee.id] = ev.employee;
      S.openPositions = S.openPositions.filter((p) => p.id !== ev.employee.id);
      office.syncEmployees(Object.values(S.employees), { animateNew: true });
      toast(`🎉 انضم ${ev.employee.nameAr} — ${ev.employee.roleAr}`, () => openPanel('profile', ev.employee.id));
      if (['hiring', 'team'].includes(currentPanel)) rerender();
      break;
    case 'hiring':
      S.hiringQueue = ev.queue;
      updateHiringBadge();
      if (currentPanel === 'hiring') rerender();
      break;
    case 'meeting_start':
      office.startMeeting(ev.meeting.participants);
      toast(`📅 اجتماع: ${ev.meeting.topic}`);
      break;
    case 'meeting_end':
      office.endMeeting();
      break;
    case 'company':
      S.company = ev.company;
      break;
    case 'reset':
      api('/api/state').then(applySnapshot);
      break;
    case 'error':
      toast(`⚠️ ${ev.message}`, null, true);
      break;
  }
}

// --------------------------------------------------------------- panels
const TITLES = { inbox: 'صندوق الوارد', chat: 'محادثة الفريق', tasks: 'المهام', meeting: 'بدء اجتماع', hiring: 'التوظيف — ليلى (HR)', team: 'الفريق', settings: 'الإعدادات', profile: 'الملف الوظيفي', item: 'التسليم' };

function openPanel(name, arg = null) {
  currentPanel = name;
  panelArg = arg;
  $('#panel').classList.remove('hidden');
  $('#panel-title').textContent = TITLES[name] ?? '';
  if (name === 'profile') office.focus(arg);
  rerender();
}
function closePanel() {
  currentPanel = null;
  $('#panel').classList.add('hidden');
}

function rerender() {
  if (!currentPanel) return;
  const body = $('#panel-body');
  const scroll = body.scrollTop;
  body.innerHTML = RENDER[currentPanel]?.(panelArg) ?? '';
  BIND[currentPanel]?.(body, panelArg);
  if (currentPanel !== 'chat') body.scrollTop = scroll;
}

const deptChip = (d) => `<span class="dept" style="background:${S.departments[d]?.color ?? '#ddd'}">${esc(S.departments[d]?.labelAr ?? d)}</span>`;
const avatar = (id) => {
  const e = S.employees[id];
  if (id === 'owner') return '<span class="avatar" style="background:#f3b06b">👤</span>';
  return `<span class="avatar" style="background:${S.departments[e?.dept]?.color ?? '#ddd'}">${esc((e?.name ?? '?')[0])}</span>`;
};
function nameOf(id) {
  if (id === 'owner') return 'أنت';
  return S.employees[id]?.nameAr ?? id;
}
const team = () => Object.values(S.employees);

const RENDER = {
  inbox: () => {
    if (!S.inbox.length) return '<p class="muted">لا يوجد شيء بعد. أرسل طلباً لرامي من الشريط بالأسفل.</p>';
    return S.inbox.map((i) => `
      <div class="item ${i.read ? '' : 'unread'}" data-open="${i.id}">
        <div class="meta">${avatar(i.from)} ${esc(nameOf(i.from))} · ${timeOf(i.at)}</div>
        <div class="title">${esc(i.title)}</div>
      </div>`).join('');
  },

  item: (id) => {
    const i = S.inbox.find((x) => x.id === id);
    if (!i) return '';
    return `
      <div class="meta">${avatar(i.from)} ${esc(nameOf(i.from))} · ${timeOf(i.at)}</div>
      <h3 style="color:var(--ink)">${esc(i.title)}</h3>
      <div class="row-input"><button class="btn secondary" data-act="copy">نسخ</button><button class="btn secondary" data-act="speak">قراءة بصوت</button><button class="btn secondary" data-act="back">رجوع</button></div>
      <div class="md">${md(i.body)}</div>`;
  },

  chat: () => `
    <div id="chat-log">${S.chat.map(chatHtml).join('')}</div>
    <div class="row-input">
      <select id="dm-to" style="max-width:150px">
        <option value="rami">رامي (مهمة للفريق)</option>
        ${team().filter((e) => !e.lead).map((e) => `<option value="${e.id}">${esc(e.nameAr)} — ${esc(e.roleAr)}</option>`).join('')}
      </select>
      <input id="dm-text" placeholder="اكتب رسالة…" />
      <button class="btn" id="dm-send">إرسال</button>
    </div>`,

  tasks: () => {
    if (!S.tasks.length) return '<p>لا توجد مهام بعد.</p>';
    return S.tasks.map((t) => `
      <div class="item">
        <div class="meta"><span class="status ${t.status === 'running' ? 'working' : ''}">${{ running: 'قيد التنفيذ', done: 'مكتمل', failed: 'تعذّر' }[t.status]}</span> ${timeOf(t.at)}</div>
        <div class="title">${esc(t.request)}</div>
        ${(t.steps ?? []).map((s) => `<div class="step">${avatar(s.employee)} <b>${esc(nameOf(s.employee))}</b> — ${s.status === 'done' ? '✅' : '⏳'} ${esc(s.brief.slice(0, 120))}</div>`).join('')}
        ${t.error ? `<p style="color:#e5484d">${esc(t.error)}</p>` : ''}
      </div>`).join('');
  },

  meeting: () => `
    <p>رامي يدير الاجتماع. كل عضو يعطي رأيه من زاوية تخصصه، وبعدها رامي يطلع بالقرارات ويرسل المحضر لصندوق الوارد.</p>
    <input class="field" id="m-topic" placeholder="موضوع الاجتماع… مثال: خطة تسويق شهر ديسمبر" />
    <h3>الحضور</h3>
    ${team().filter((e) => !e.lead).map((e) => `<label class="check"><input type="checkbox" value="${e.id}" /> ${avatar(e.id)} ${esc(e.nameAr)} <small style="color:var(--muted)">${esc(e.roleAr)}</small></label>`).join('')}
    <div class="row-input"><button class="btn accent" id="m-start">ابدأ الاجتماع</button></div>`,

  hiring: () => {
    const q = S.hiringQueue ?? [];
    const active = q.filter((x) => x.status === 'writing' || x.status === 'queued');
    const failed = q.filter((x) => x.status === 'failed');
    const pending = new Set([...active, ...failed].map((x) => x.positionId).filter(Boolean));
    const open = S.openPositions.filter((p) => !pending.has(p.id));
    const writing = q.find((x) => x.status === 'writing');
    const since = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return `
    <p>ليلى (HR) تكتب الوصف الوظيفي لكل وظيفة، وحدة ورا الثانية. كل وظيفة تاخذ تقريباً من 20 إلى 60 ثانية، وبعدها الموظف يدخل المكتب ويمشي لمكتبه.</p>
    ${active.length ? `
      <h3>قيد التوظيف (${active.length})</h3>
      ${active.map((x) => `
        <div class="person">
          <span class="status ${x.status === 'writing' ? 'working' : ''}">${x.status === 'writing' ? '✍️ ليلى تكتب الآن' : '⏳ بالانتظار'}</span>
          <div class="info"><b>${esc(x.title)}</b>${x.status === 'writing' && x.startedAt ? `<small>من ${since(x.startedAt)} ثانية</small>` : ''}</div>
        </div>`).join('')}` : ''}
    ${failed.length ? `
      <h3>تعذّر التوظيف</h3>
      ${failed.map((x) => `
        <div class="person">
          <div class="info"><b>${esc(x.title)}</b><small style="color:#e5484d">${esc(x.error ?? '')}</small></div>
          <button class="btn secondary" data-retry="${x.id}">إعادة المحاولة</button>
        </div>`).join('')}` : ''}
    <div class="row-input"><button class="btn accent" id="h-all" ${open.length + failed.length ? '' : 'disabled'}>وظّف الكل واحد واحد (${open.length + failed.length})</button></div>
    <h3>الوظائف المفتوحة</h3>
    ${open.map((p) => `
      <div class="person">
        <div class="info"><b>${esc(p.nameAr)} — ${esc(p.roleAr)}</b> ${deptChip(p.dept)}<small>${esc(p.brief)}</small></div>
        <button class="btn" data-hire="${p.id}">توظيف</button>
      </div>`).join('') || (active.length || failed.length ? '<p>كل الوظائف المتبقية في القوائم بالأعلى.</p>' : '<p>كل الوظائف مشغولة ✅</p>')}
    <h3>وظيفة جديدة مخصّصة</h3>
    <div class="row-input"><input id="h-custom" placeholder="مثال: مسؤول علاقات عامة" /><button class="btn" id="h-custom-go">اطلب من ليلى</button></div>
    `;
  },

  team: () => {
    const byDept = {};
    for (const e of team()) (byDept[e.dept] ??= []).push(e);
    return Object.entries(byDept).map(([d, list]) => `
      <h3>${esc(S.departments[d]?.labelAr ?? d)}</h3>
      ${list.map((e) => `
        <div class="person" data-profile="${e.id}" style="cursor:pointer">
          ${avatar(e.id)}
          <div class="info"><b>${esc(e.nameAr)}</b> <small>${esc(e.roleAr)} · ${esc(e.role)}</small></div>
          <span class="status ${e.status}">${e.status === 'working' ? 'يعمل' : 'متاح'}</span>
        </div>`).join('')}`).join('');
  },

  profile: (id) => {
    const e = S.employees[id];
    if (!e) return '';
    const dms = S.chat.filter((c) => c.dm === id);
    return `
      <div class="person">${avatar(id)}<div class="info"><b>${esc(e.nameAr)} (${esc(e.name)})</b><small>${esc(e.roleAr)} · ${esc(e.role)}</small></div>${deptChip(e.dept)}</div>
      <p>${esc(e.brief)}</p>
      ${e.lead ? '<p><b>المسؤول عن الفريق كامل.</b> أرسل له الطلبات من الشريط بالأسفل وهو يوزّعها.</p>' : ''}
      ${e.jd ? `<h3>الوصف الوظيفي</h3><div class="md">${md(e.jd)}</div>` : ''}
      <h3>محادثة مباشرة</h3>
      <div id="chat-log">${dms.map(chatHtml).join('')}</div>
      <div class="row-input"><input id="p-text" placeholder="اكتب لـ ${esc(e.nameAr)}…" /><button class="btn" id="p-send">إرسال</button></div>`;
  },

  settings: () => `
    <h3>الشركة</h3>
    <input class="field" id="c-name" value="${esc(S.company.name)}" />
    <textarea class="field" id="c-about" style="margin-top:8px">${esc(S.company.about)}</textarea>
    <p><small>هذا الوصف يوصل لكل الإيجنتات، فكل ما كان أدق (المنتجات، السوق، الجمهور، الميزانيات) كانت النتائج أفضل.</small></p>
    <div class="row-input"><button class="btn" id="c-save">حفظ</button></div>
    <h3>المكتب</h3>
    <p><small>الوضع الحالي: ${S.live ? `متصل بـ Claude API (${esc(S.model)})` : 'وضع التجربة — شغّل السيرفر مع <code>ANTHROPIC_API_KEY</code>.'}</small></p>
    ${S.keyInfo?.set ? `<p><small>المفتاح اللي وصل للسيرفر: <code dir="ltr">${esc(S.keyInfo.prefix)}…${esc(S.keyInfo.suffix)}</code> (${S.keyInfo.length} حرف)${S.keyInfo.cleaned ? ' — تم حذف حروف مخفية منه' : ''}${S.keyInfo.looksValid ? '' : ' — <b style="color:#e5484d">شكله مو مفتاح Anthropic صحيح</b>'}</small></p>
    <p><small>قارن آخر 4 حروف مع المفتاح في console.anthropic.com. إذا مختلفة، Railway للحين يستخدم المفتاح القديم.</small></p>` : ''}
    <div class="row-input"><button class="btn danger" id="c-reset">إعادة ضبط المكتب</button></div>`,
};

function chatHtml(c) {
  return `<div class="msg ${c.from === 'owner' ? 'owner' : ''}">${avatar(c.from)}<div class="body"><div class="who">${esc(nameOf(c.from))} · ${timeOf(c.at)}</div><div class="md">${md(c.text)}</div></div></div>`;
}
function appendChat(entry) {
  const log = $('#chat-log');
  if (!log) return;
  log.insertAdjacentHTML('beforeend', chatHtml(entry));
  $('#panel-body').scrollTop = 1e9;
}

const BIND = {
  inbox: (b) => b.querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => openPanel('item', el.dataset.open))),
  item: (b, id) => {
    const i = S.inbox.find((x) => x.id === id);
    if (!i) return;
    if (!i.read) {
      i.read = true;
      updateBadge();
      api(`/api/inbox/${id}/read`, {});
    }
    b.querySelector('[data-act=copy]').onclick = () => navigator.clipboard.writeText(i.body).then(() => toast('تم النسخ'));
    b.querySelector('[data-act=speak]').onclick = () => speak(i.body);
    b.querySelector('[data-act=back]').onclick = () => openPanel('inbox');
  },
  chat: (b) => {
    $('#panel-body').scrollTop = 1e9;
    const send = async () => {
      const to = $('#dm-to').value;
      const text = $('#dm-text').value.trim();
      if (!text) return;
      $('#dm-text').value = '';
      try {
        await api(to === 'rami' ? '/api/request' : `/api/dm/${to}`, { text });
      } catch (e) {
        toast(e.message, null, true);
      }
    };
    $('#dm-send').onclick = send;
    $('#dm-text').onkeydown = (e) => e.key === 'Enter' && send();
  },
  meeting: () => {
    $('#m-start').onclick = async () => {
      const topic = $('#m-topic').value.trim();
      const participantIds = [...document.querySelectorAll('#panel-body input[type=checkbox]:checked')].map((x) => x.value);
      if (!topic || !participantIds.length) return toast('اكتب الموضوع واختر الحضور', null, true);
      try {
        await api('/api/meeting', { topic, participantIds });
        closePanel();
      } catch (e) {
        toast(e.message, null, true);
      }
    };
  },
  hiring: (b) => {
    const call = (path, body) => api(path, body).catch((e) => toast(e.message, null, true));
    b.querySelectorAll('[data-hire]').forEach((el) => (el.onclick = () => {
      el.disabled = true;
      call('/api/hire', { positionId: el.dataset.hire });
    }));
    b.querySelectorAll('[data-retry]').forEach((el) => (el.onclick = () => {
      el.disabled = true;
      call(`/api/hire/${el.dataset.retry}/retry`, {});
    }));
    $('#h-all').onclick = () => {
      $('#h-all').disabled = true;
      call('/api/hire-all', {});
    };
    const custom = () => {
      const role = $('#h-custom').value.trim();
      if (!role) return;
      $('#h-custom').value = '';
      call('/api/hire', { customRole: role });
    };
    $('#h-custom-go').onclick = custom;
    $('#h-custom').onkeydown = (e) => e.key === 'Enter' && custom();
  },
  team: (b) => b.querySelectorAll('[data-profile]').forEach((el) => (el.onclick = () => openPanel('profile', el.dataset.profile))),
  profile: (b, id) => {
    const send = async () => {
      const text = $('#p-text').value.trim();
      if (!text) return;
      $('#p-text').value = '';
      try {
        await api(id === 'rami' ? '/api/request' : `/api/dm/${id}`, { text });
        setTimeout(rerender, 300);
      } catch (e) {
        toast(e.message, null, true);
      }
    };
    $('#p-send').onclick = send;
    $('#p-text').onkeydown = (e) => e.key === 'Enter' && send();
  },
  settings: () => {
    $('#c-save').onclick = async () => {
      S.company = await api('/api/company', { name: $('#c-name').value, about: $('#c-about').value });
      toast('تم الحفظ');
    };
    $('#c-reset').onclick = async () => {
      if (!confirm('مسح كل الموظفين والمهام والرسائل؟')) return;
      applySnapshot(await api('/api/reset', {}));
    };
  },
};

// ------------------------------------------------------------- chrome
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => office.flyTo(b.dataset.view)));
document.querySelectorAll('[data-panel]').forEach((b) => (b.onclick = () => (currentPanel === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel))));
$('#panel-close').onclick = closePanel;

$('#command').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#command-text').value.trim();
  if (!text) return;
  $('#command-text').value = '';
  try {
    await api('/api/request', { text });
    toast('📨 وصل الطلب لرامي');
  } catch (err) {
    toast(err.message, null, true);
  }
};
$('#command-text').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#command').requestSubmit();
  }
};

function updateBadge() {
  const n = S.inbox.filter((i) => !i.read).length;
  const b = $('#inbox-badge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

function updateHiringBadge() {
  const n = (S.hiringQueue ?? []).filter((x) => x.status === 'queued' || x.status === 'writing').length;
  const btn = document.querySelector('[data-panel=hiring]');
  btn.textContent = n ? `Hiring (HR) · ${n}` : 'Hiring (HR)';
}
setInterval(() => currentPanel === 'hiring' && (S.hiringQueue ?? []).some((x) => x.status === 'writing') && rerender(), 5000);

function tick(text) {
  const t = $('#ticker');
  const d = document.createElement('div');
  d.textContent = text;
  t.appendChild(d);
  while (t.children.length > 5) t.firstChild.remove();
  setTimeout(() => d.remove(), 8000);
}

function toast(text, onClick, error = false) {
  if (!prefs.alerts && !error) return;
  const d = document.createElement('div');
  d.className = `toast ${error ? 'error' : ''}`;
  d.textContent = text;
  if (onClick) d.onclick = () => (onClick(), d.remove());
  const box = $('#toasts');
  box.appendChild(d);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => d.remove(), error ? 15000 : 6000);
}

// ---------------------------------------------- sound, alerts, read aloud
function loadPrefs() {
  try {
    return { sound: false, alerts: true, read: false, ...JSON.parse(localStorage.getItem('office-prefs') || '{}') };
  } catch {
    return { sound: false, alerts: true, read: false };
  }
}
function savePrefs() {
  try {
    localStorage.setItem('office-prefs', JSON.stringify(prefs));
  } catch {}
}
function renderToggles() {
  for (const [id, key, label] of [['#t-sound', 'sound', 'Sound'], ['#t-alerts', 'alerts', 'Alerts'], ['#t-read', 'read', 'Read aloud']]) {
    const b = $(id);
    b.textContent = `${label} ${prefs[key] ? 'on' : 'off'}`;
    b.classList.toggle('on', prefs[key]);
    b.onclick = () => {
      prefs[key] = !prefs[key];
      savePrefs();
      renderToggles();
      if (key === 'sound' && !prefs.sound) typing.stop();
      if (key === 'read' && !prefs.read) speechSynthesis.cancel();
    };
  }
}
renderToggles();

let audio = null;
const ctx = () => (audio ??= new AudioContext());
function blip(freq, dur = 0.05, vol = 0.03) {
  if (!prefs.sound) return;
  const a = ctx();
  const o = a.createOscillator();
  const g = a.createGain();
  o.frequency.value = freq;
  g.gain.value = vol;
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}
function chime() {
  blip(880, 0.25, 0.06);
  setTimeout(() => blip(1320, 0.3, 0.05), 140);
}
const typing = {
  timer: null,
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => Math.random() < 0.6 && blip(1800 + Math.random() * 900, 0.015, 0.012), 90);
  },
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  },
};

function speak(text) {
  if (!('speechSynthesis' in window)) return toast('المتصفح لا يدعم القراءة بصوت', null, true);
  speechSynthesis.cancel();
  const plain = text.replace(/[#*_`|>-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 1200);
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = /[؀-ۿ]/.test(plain) ? 'ar-SA' : 'en-US';
  speechSynthesis.speak(u);
}

boot().catch((e) => toast(`تعذّر الاتصال بالسيرفر: ${e.message}`, null, true));
