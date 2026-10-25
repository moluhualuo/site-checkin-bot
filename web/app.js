/* 自动签到控制台 —— 纯原生 JS，无构建步骤 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATE_LABEL = { ok: '成功', already: '已签到', fail: '失败', auth: '凭据失效', blocked: '被拦截' };
const MAX_LOG_LINES = 800;

const ui = {
  boot: null,
  busy: null,
  active: new Set(),
  currentSite: null,
  logCount: 0,
};

/* ---------------- 工具 ---------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}-${pad2(d.getDate())} ${hm}`;
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="bar"></span><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败 (HTTP ${res.status})`);
  }
  return data;
}

/* ---------------- 渲染：统计 ---------------- */

function renderStats() {
  const { stats, sites, busy } = ui.boot;
  const lastRun = sites
    .map((s) => s.last?.at)
    .filter(Boolean)
    .sort()
    .pop();

  const done = sites.filter((s) => s.last && (s.last.state === 'ok' || s.last.state === 'already'));
  const okCount = sites.filter((s) => s.last?.state === 'ok').length;
  const alreadyCount = sites.filter((s) => s.last?.state === 'already').length;
  const trouble = sites.filter((s) => !s.last || (s.last.state !== 'ok' && s.last.state !== 'already'));

  const cards = [
    {
      k: '站点总数',
      v: stats.total,
      unit: '个',
      s: `${stats.enabled} 个已启用 · ${stats.ready} 个已配置凭据`,
      c: '#5b8cff',
    },
    {
      k: '今日已签到',
      v: done.length,
      unit: `/ ${stats.total}`,
      s: `新签 ${okCount} · 重复 ${alreadyCount}`,
      c: '#3ddc97',
    },
    {
      k: '需要处理',
      v: trouble.length,
      unit: '个',
      s: trouble.length ? trouble.map((s) => s.name).join('、') : '全部正常',
      c: trouble.length ? '#ff5f7e' : '#3ddc97',
    },
    {
      k: '运行状态',
      v: busy ? '进行中' : '空闲',
      unit: '',
      s: lastRun ? `上次运行 ${ago(lastRun)}` : '还没有运行记录',
      c: busy ? '#ffb648' : '#8b5cf6',
    },
  ];

  $('#stats').innerHTML = cards
    .map(
      (c) => `
      <div class="stat" style="--c:${c.c}">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}${c.unit ? `<small>${esc(c.unit)}</small>` : ''}</div>
        <div class="s" title="${esc(c.s)}">${esc(c.s)}</div>
      </div>`
    )
    .join('');
}

/* ---------------- 渲染：站点卡片 ---------------- */

function chipsOf(site) {
  const out = [];
  if (site.account.username) {
    out.push(`<span class="chip plain">账号 ${esc(site.account.username)}</span>`);
  }
  if (site.cred.hasToken) {
    out.push(`<span class="chip"><b>token</b> ${esc(site.cred.tokenPreview)}</span>`);
  }
  if (site.cred.hasUserId) {
    out.push(`<span class="chip"><b>uid</b> ${esc(String(site.cred.userId))}</span>`);
  }
  if (site.cred.hasCookie) {
    out.push(`<span class="chip"><b>cookie</b> ${esc(site.cred.cookiePreview)}</span>`);
  }
  if (!out.length) {
    out.push(`<span class="chip miss plain"><b>·</b> 未配置凭据</span>`);
  }
  if (site.cred.updatedAt) {
    out.push(`<span class="chip plain">更新于 ${esc(fmtTime(site.cred.updatedAt))}</span>`);
  }
  return out.join('');
}

function cardOf(site) {
  const running = ui.active.has(site.id);
  const st = site.last?.state;
  const dotCls = running ? 'running' : st === 'ok' ? 'ok' : st === 'already' ? 'already' : st ? 'fail' : '';
  const msgCls = running ? 'info' : st === 'ok' ? 'ok' : st === 'already' ? 'already' : st ? 'fail' : 'idle';

  const msg = running ? '正在执行…' : site.last?.message || '还没有运行记录';
  const when = running ? '' : site.last?.at ? `<span class="when" title="${esc(new Date(site.last.at).toLocaleString('zh-CN', { hour12: false }))}">${esc(fmtTime(site.last.at))}</span>` : '';

  const badges = [
    `<span class="badge">${site.type === 'newapi' ? 'new-api' : '自建'}</span>`,
    site.turnstile ? '<span class="badge shield">Turnstile</span>' : '',
    site.needsOAuth ? '<span class="badge oauth">OAuth</span>' : '',
  ].join('');

  const disabled = !site.enabled;

  return `
  <article class="card ${disabled ? 'disabled' : ''} ${running ? 'running' : ''}" data-id="${esc(site.id)}">
    <div class="card-top">
      <div class="card-title">
        <span class="dot ${dotCls}"></span>
        <h3 title="${esc(site.name)}">${esc(site.name)}</h3>
        ${badges}
      </div>
      <label class="toggle" title="${disabled ? '已停用' : '已启用'}">
        <input type="checkbox" data-act="toggle" ${site.enabled ? 'checked' : ''} />
        <span></span>
      </label>
    </div>
    <a class="url" href="${esc(site.url)}" target="_blank" rel="noreferrer">${esc(site.url.replace(/^https?:\/\//, ''))}</a>
    <div class="last">
      <span class="msg ${msgCls}">${esc(msg)}</span>
      ${when}
    </div>
    <div class="chips">${chipsOf(site)}</div>
    <div class="card-actions">
      <button class="btn accent" data-act="run" ${running || ui.busy ? 'disabled' : ''}>
        ${running ? '执行中…' : '签到'}
      </button>
      <button class="btn ghost" data-act="login" ${ui.busy ? 'disabled' : ''}>登录</button>
      <button class="btn ghost icon" data-act="config" title="配置凭据">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7L4.5 7a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </div>
  </article>`;
}

function renderSites() {
  const sites = ui.boot.sites;
  $('#sites').innerHTML = sites.length ? sites.map(cardOf).join('') : '<div class="hint">config/sites.json 里还没有站点</div>';
}

/* ---------------- 渲染：状态 ---------------- */

function renderStatus() {
  const el = $('#status');
  const txt = $('#statusText');
  const { busy } = ui.boot;

  el.className = 'status';
  if (busy) {
    el.classList.add('busy');
    txt.textContent = busy.kind === 'login' ? '登录中…' : '签到中…';
  } else {
    const sites = ui.boot.sites;
    const bad = sites.filter((s) => s.last && s.last.state !== 'ok' && s.last.state !== 'already').length;
    if (bad) {
      el.classList.add('bad');
      txt.textContent = `${bad} 个站点失败`;
    } else if (sites.some((s) => s.last)) {
      el.classList.add('good');
      txt.textContent = '全部正常';
    } else {
      txt.textContent = '空闲';
    }
  }

  const btn = $('#btnRunAll');
  btn.disabled = !!busy;
  btn.querySelector('span').textContent = busy ? (busy.kind === 'login' ? '登录中…' : '签到中…') : '全部签到';

  $('#sub').textContent = busy
    ? `${busy.kind === 'login' ? '正在登录' : '正在签到'} · 开始于 ${fmtTime(busy.startedAt)}`
    : `${ui.boot.sites.length} 个站点 · ${ui.boot.chrome ? 'Chrome 就绪' : '未检测到 Chrome'}`;

  $('#footChrome').textContent = ui.boot.chrome ? '浏览器已就绪' : '未找到 Chrome';
}

function renderAll() {
  renderStats();
  renderSites();
  renderStatus();
}

/* ---------------- 日志 ---------------- */

function appendLog({ ts, level, msg }) {
  const box = $('#log');
  const line = document.createElement('div');
  line.className = `line ${level}`;
  line.innerHTML = `<span class="t">${esc(ts || '')}</span><span class="m">${esc(msg)}</span>`;
  box.appendChild(line);

  if (++ui.logCount > MAX_LOG_LINES) {
    box.removeChild(box.firstElementChild);
    ui.logCount--;
  }
  if ($('#autoScroll').checked) box.scrollTop = box.scrollHeight;
}

/* ---------------- 数据加载 ---------------- */

async function load() {
  try {
    const data = await api('/api/bootstrap');
    ui.boot = data;
    ui.busy = data.busy;
    if (data.busy) data.busy.ids?.forEach((id) => ui.active.add(id));
    renderAll();
  } catch (e) {
    $('#sub').textContent = `无法连接服务：${e.message}`;
    $('#status').className = 'status bad';
    $('#statusText').textContent = '离线';
  }
}

async function loadLogHistory() {
  try {
    const { lines } = await api('/api/logs?lines=120');
    if (!lines?.length) return;
    for (const raw of lines) {
      // 日志行格式：HH:MM:SS LEVEL [scope] message
      const m = raw.match(/^(\d{2}:\d{2}:\d{2})\s+([A-Z]+)\s+(?:\[[^\]]*\]\s*)?(.*)$/);
      if (m) appendLog({ ts: m[1], level: m[2].toLowerCase(), msg: m[3] });
    }
  } catch {
    /* 没有历史日志 */
  }
}

/* ---------------- 动作 ---------------- */

async function runSites(ids = []) {
  try {
    await api('/api/run', { method: 'POST', body: JSON.stringify({ ids }) });
    if (!ids.length) toast('已开始全部签到', 'info');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function loginSite(site) {
  const tip =
    site.type === 'newapi'
      ? `将为「${site.name}」自动登录并保存凭据。\n若站点有 Turnstile，会启动一个浏览器窗口过盾。`
      : `将为「${site.name}」打开一个可见的浏览器窗口完成 LinuxDO 授权。\n\n如果 LinuxDO 弹出「人机验证」拼图，需要你在窗口里手动完成一次；\n之后凭据会保存下来，大约 30 天内不用再登录。`;
  if (!confirm(tip)) return;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ id: site.id }) });
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function toggleSite(site, enabled) {
  try {
    await api(`/api/sites/${encodeURIComponent(site.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    site.enabled = enabled;
    renderAll();
    toast(`${site.name} 已${enabled ? '启用' : '停用'}`, enabled ? 'ok' : 'warn', 1800);
  } catch (e) {
    toast(e.message, 'err');
    renderAll();
  }
}

/* ---------------- 站点配置弹窗 ---------------- */

function openSiteDialog(site) {
  ui.currentSite = site;
  $('#siteTitle').textContent = site.name;
  $('#siteSub').textContent = site.note || site.url;

  const isCookie = site.auth === 'cookie';
  const cookieField = `
    <label class="field">
      <span>Cookie <em>${isCookie ? '该站用 Cookie 鉴权' : '可选'}</em></span>
      <textarea id="f-cookie" placeholder="粘贴完整 Cookie（留空则不修改）&#10;例如 welfare_session=eyJhbGciOi..."></textarea>
    </label>`;
  const tokenField = `
    <label class="field">
      <span>访问令牌 (token) <em>${site.auth === 'bearer' ? '该站用 Bearer 鉴权' : '可选'}</em></span>
      <input id="f-token" placeholder="粘贴访问令牌" autocomplete="off" />
    </label>`;
  // 新版 new-api 要求 New-Api-User 头，值是数字用户 ID
  const uidField =
    site.type === 'newapi'
      ? `
    <label class="field">
      <span>用户 ID (New-Api-User) <em>${site.cred.hasUserId ? `当前 ${site.cred.userId}` : '用令牌时必填'}</em></span>
      <input id="f-uid" inputmode="numeric" placeholder="纯数字，例如 7326" autocomplete="off" />
    </label>`
      : '';

  const accountFields =
    site.type === 'newapi'
      ? `
      <label class="field">
        <span>账号 / 邮箱</span>
        <input id="f-user" value="${esc(site.account.username)}" placeholder="登录账号" autocomplete="off" />
      </label>
      <label class="field">
        <span>密码 <em>${site.account.hasPassword ? '已保存' : '未设置'}</em></span>
        <input id="f-pass" type="password" placeholder="留空则不修改" autocomplete="new-password" />
      </label>`
      : `
      <label class="field">
        <span>账号 / 邮箱 <em>可选</em></span>
        <input id="f-user" value="${esc(site.account.username)}" placeholder="仅作记录" autocomplete="off" />
      </label>`;

  $('#siteFields').innerHTML = accountFields + (isCookie ? cookieField + tokenField : tokenField + uidField + cookieField);

  $('#btnClearCred').style.display = site.cred.has ? '' : 'none';
  $('#dlgSite').showModal();
}

async function saveSite() {
  const site = ui.currentSite;
  if (!site) return;
  const body = {};
  const user = $('#f-user');
  const pass = $('#f-pass');
  const token = $('#f-token');
  const cookie = $('#f-cookie');
  const uid = $('#f-uid');

  if (user && user.value !== site.account.username) body.username = user.value;
  if (pass && pass.value) body.password = pass.value;
  if (token && token.value.trim()) body.token = token.value.trim();
  if (cookie && cookie.value.trim()) body.cookie = cookie.value.trim();
  if (uid && uid.value.trim()) body.userId = uid.value.trim();

  if (!Object.keys(body).length) {
    $('#dlgSite').close();
    return;
  }
  try {
    await api(`/api/sites/${encodeURIComponent(site.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    $('#dlgSite').close();
    toast(`${site.name} 配置已保存`, 'ok');
    await load();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function clearCred() {
  const site = ui.currentSite;
  if (!site) return;
  if (!confirm(`确定清除「${site.name}」已保存的凭据？清除后需要重新登录。`)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(site.id)}/cred`, { method: 'DELETE' });
    $('#dlgSite').close();
    toast('凭据已清除', 'warn');
    await load();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 设置弹窗 ---------------- */

function openSettings() {
  const { linuxdo, settings } = ui.boot;
  $('#setUser').value = linuxdo.username || '';
  $('#setPass').value = '';
  $('#setPassHint').textContent = linuxdo.hasPassword ? '已保存，留空不改' : '未设置';
  $('#setCookie').value = '';
  $('#setCookieHint').textContent = linuxdo.hasCookie ? '已保存，留空不改' : '可选';
  $('#setProxy').value = settings.proxy || '';
  $('#setWebhook').value = settings.webhook || '';
  $('#setHeadless').checked = !!settings.headless;
  $('#dlgSettings').showModal();
}

async function saveSettings() {
  const body = {
    linuxdoUsername: $('#setUser').value.trim(),
    proxy: $('#setProxy').value.trim(),
    webhook: $('#setWebhook').value.trim(),
    headless: $('#setHeadless').checked,
  };
  const pass = $('#setPass').value;
  if (pass) body.linuxdoPassword = pass;
  const lc = $('#setCookie').value.trim();
  if (lc) body.linuxdoCookie = lc;

  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    $('#dlgSettings').close();
    toast('设置已保存', 'ok');
    await load();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 体检 ---------------- */

async function doctor() {
  const list = $('#doctorList');
  list.innerHTML = '<div class="check"><span class="label">正在检查…</span></div>';
  $('#dlgDoctor').showModal();
  try {
    const { checks } = await api('/api/doctor', { method: 'POST' });
    list.innerHTML = checks
      .map((c) => {
        const cls = c.ok ? 'ok' : c.optional ? 'opt' : 'bad';
        const mark = c.ok ? '✓' : c.optional ? '!' : '✕';
        return `<div class="check ${cls}">
          <span class="mark">${mark}</span>
          <span class="label">${esc(c.label)}</span>
          <span class="detail" title="${esc(c.detail)}">${esc(c.detail)}</span>
        </div>`;
      })
      .join('');
  } catch (e) {
    list.innerHTML = `<div class="check bad"><span class="mark">✕</span><span class="label">${esc(e.message)}</span></div>`;
  }
}

/* ---------------- 事件绑定 ---------------- */

$('#btnRunAll').addEventListener('click', () => runSites([]));
$('#btnDoctor').addEventListener('click', doctor);
$('#btnSettings').addEventListener('click', openSettings);
$('#btnSaveSettings').addEventListener('click', saveSettings);
$('#btnSaveSite').addEventListener('click', saveSite);
$('#btnClearCred').addEventListener('click', clearCred);
$('#btnClearLog').addEventListener('click', () => {
  $('#log').innerHTML = '';
  ui.logCount = 0;
});

$('#sites').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const site = ui.boot.sites.find((s) => s.id === card.dataset.id);
  if (!site) return;

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'run') runSites([site.id]);
  else if (act === 'login') loginSite(site);
  else if (act === 'config') openSiteDialog(site);
});

$('#sites').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'toggle') return;
  const card = e.target.closest('.card');
  const site = ui.boot.sites.find((s) => s.id === card.dataset.id);
  if (site) toggleSite(site, e.target.checked);
});

/* ---------------- SSE 实时事件 ---------------- */

function connect() {
  const es = new EventSource('/api/events');
  let opened = false;

  es.onopen = () => {
    // 断线重连后补一次全量状态（首次打开时 init 已拉过，不重复）
    if (opened) load();
    opened = true;
  };

  es.onerror = () => {
    $('#sub').textContent = '实时连接断开，正在重连…';
  };

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'hello':
        ui.busy = msg.busy;
        break;

      case 'log':
        appendLog(msg);
        // 需要人工过验证时，除了日志再弹一个显眼的提示
        if (msg.level === 'warn' && /人机验证需要人工完成/.test(msg.msg)) {
          toast('请在弹出的浏览器窗口里完成人机验证', 'warn', 10000);
        }
        break;

      case 'busy':
        ui.busy = msg.busy;
        ui.boot.busy = msg.busy;
        if (!msg.busy) ui.active.clear();
        renderStatus();
        renderSites();
        break;

      case 'site-start':
        ui.active.add(msg.id);
        renderSites();
        break;

      case 'site-done': {
        ui.active.delete(msg.id);
        const site = ui.boot.sites.find((s) => s.id === msg.id);
        if (site) site.last = { state: msg.state, message: msg.message, at: new Date().toISOString() };
        renderAll();
        break;
      }

      case 'run-start':
        toast('开始签到…', 'info', 1600);
        break;

      case 'run-done': {
        ui.active.clear();
        const parts = [];
        if (msg.ok) parts.push(`${msg.ok} 成功`);
        if (msg.already) parts.push(`${msg.already} 已签`);
        if (msg.fail) parts.push(`${msg.fail} 失败`);
        toast(`签到结束：${parts.join(' · ') || '无结果'}`, msg.fail ? 'err' : 'ok', 5000);
        load();
        break;
      }

      case 'login-start':
        toast(`正在登录 ${msg.name}…`, 'info', 2200);
        break;

      case 'login-done':
        toast(msg.ok ? `${msg.id} 登录成功，凭据已保存` : `登录失败：${msg.message}`, msg.ok ? 'ok' : 'err', 5000);
        load();
        break;

      case 'job-error':
        toast(msg.message, 'err', 5000);
        break;

      default:
        break;
    }
  };
}

/* ---------------- 启动 ---------------- */

(async function init() {
  await load();
  await loadLogHistory();
  connect();
  // 每分钟刷新相对时间
  setInterval(() => {
    if (ui.boot && !ui.busy) renderStats();
  }, 60000);
})();
