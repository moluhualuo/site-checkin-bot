#!/usr/bin/env node
/**
 * 签到控制台 Web 服务（零依赖，只用 Node 内置模块）
 *
 *   node server.mjs                  # http://127.0.0.1:8787
 *   node server.mjs --port 9000
 *   node server.mjs --open           # 启动后自动打开浏览器
 *   node server.mjs --host 0.0.0.0   # 允许局域网访问（注意：会暴露凭据，慎用）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bus } from './src/bus.mjs';
import { ROOT, LOG_DIR, R, DEFAULT_UA, log } from './src/util.mjs';
import { loadConfig, saveConfig, loadCreds, loadState, getCred, saveCred, findSite, recordResult } from './src/sites.mjs';
import { runSites, loginSite, notifyWebhook } from './src/runner.mjs';
import { findBrowser } from './src/cdp.mjs';

/* ---------------- 启动参数 ---------------- */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PORT = Number(arg('port', 8787)) || 8787;
const HOST = arg('host', '127.0.0.1');
const AUTO_OPEN = process.argv.includes('--open');
const WEB_DIR = path.join(ROOT, 'web');

/* ---------------- 运行时状态 ---------------- */

let job = null; // { kind:'run'|'login', ids:[], startedAt }
const clients = new Set(); // SSE 连接

function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

bus.on('log', (e) => broadcast({ t: 'log', ...e }));

/* ---------------- 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function mask(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 12) return s.slice(0, 3) + '***';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * 把用户粘进来的东西整理成合法 Cookie 头：
 *  - 去掉 "Cookie:" 前缀和换行
 *  - 只给了值没给名字时，补上站点约定的 cookie 名
 */
function normalizeCookie(raw, site) {
  let s = String(raw || '')
    .trim()
    .replace(/^cookie:\s*/i, '')
    .replace(/[\r\n]+/g, '; ')
    .trim();
  if (!s) return '';
  // 只有站点明确约定了 cookie 名才补，避免给别的站拼错名字
  if (!s.includes('=') && site.cookieName) s = `${site.cookieName}=${s}`;
  return s;
}

function credView(siteId) {
  const c = getCred(siteId);
  if (!c) return { has: false };
  const cookieName = String(c.cookie || '').split('=')[0] || '';
  return {
    has: true,
    hasToken: !!c.token,
    hasCookie: !!c.cookie,
    hasUserId: !!c.userId,
    userId: c.userId || null,
    tokenPreview: c.token ? mask(c.token) : '',
    cookiePreview: c.cookie ? `${cookieName}=${mask(String(c.cookie).split('=').slice(1).join('='))}` : '',
    updatedAt: c.updatedAt || null,
  };
}

function siteView(site, state) {
  const st = state[site.id];
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    type: site.type,
    auth: site.auth || '',
    enabled: site.enabled !== false,
    turnstile: !!site.turnstile,
    note: site.note || '',
    port: site.port || 9300,
    account: { username: site.username || '', hasPassword: !!site.password },
    needsOAuth: site.type === 'welfare',
    cred: credView(site.id),
    last: st ? { state: st.state, message: st.message, at: st.at } : null,
  };
}

function buildBootstrap() {
  const cfg = loadConfig();
  const state = loadState();
  let chrome = null;
  try {
    chrome = findBrowser();
  } catch {
    /* 未安装 */
  }
  const sites = cfg.sites.map((s) => siteView(s, state));
  const stats = {
    total: sites.length,
    enabled: sites.filter((s) => s.enabled).length,
    ok: sites.filter((s) => s.last && (s.last.state === R.OK || s.last.state === R.ALREADY)).length,
    fail: sites.filter((s) => s.last && s.last.state !== R.OK && s.last.state !== R.ALREADY).length,
    pending: sites.filter((s) => !s.last).length,
    ready: sites.filter((s) => s.cred.has || s.account.username).length,
  };
  return {
    ok: true,
    now: new Date().toISOString(),
    busy: job,
    chrome,
    settings: {
      headless: cfg.settings.headless === true,
      offscreen: cfg.settings.offscreen !== false,
      proxy: cfg.settings.proxy || '',
      webhook: cfg.settings.notify?.webhook || '',
    },
    linuxdo: {
      username: cfg.linuxdo?.username || '',
      hasPassword: !!cfg.linuxdo?.password,
      hasCookie: !!cfg.linuxdo?.cookie,
    },
    stats,
    sites,
  };
}

/* ---------------- 任务 ---------------- */

function startJob(kind, ids, runner) {
  if (job) {
    const err = new Error('已有任务在运行，请等它结束');
    err.status = 409;
    throw err;
  }
  job = { kind, ids, startedAt: new Date().toISOString() };
  broadcast({ t: 'busy', busy: job });

  runner()
    .catch((e) => {
      log('err', e.message);
      broadcast({ t: 'job-error', message: e.message });
    })
    .finally(() => {
      job = null;
      broadcast({ t: 'busy', busy: null });
    });
}

function doRun(ids) {
  const cfg = loadConfig();
  const picked = ids?.length ? ids : [];
  const total = cfg.sites.filter((s) => s.enabled !== false && (!picked.length || picked.includes(s.id))).length;
  broadcast({ t: 'run-start', ids: picked, total });

  startJob('run', picked, async () => {
    const results = await runSites(cfg, picked, {
      log,
      onSiteStart: (s) => broadcast({ t: 'site-start', id: s.id, name: s.name }),
      onSiteDone: (r) => {
        recordResult(r.id, { state: r.state, message: r.message });
        broadcast({ t: 'site-done', ...r });
      },
    });
    const ok = results.filter((r) => r.state === R.OK).length;
    const already = results.filter((r) => r.state === R.ALREADY).length;
    broadcast({ t: 'run-done', results, ok, already, fail: results.length - ok - already });
    await notifyWebhook(cfg, results, log);
  });
}

function doLogin(id) {
  const cfg = loadConfig();
  const site = findSite(cfg, id);
  if (!site) {
    const err = new Error(`找不到站点: ${id}`);
    err.status = 404;
    throw err;
  }
  broadcast({ t: 'login-start', id, name: site.name });
  startJob('login', [id], async () => {
    try {
      const creds = await loginSite(cfg, site, { log });
      saveCred(site.id, creds);
      log('ok', `${site.name} 凭据已保存`);
      broadcast({ t: 'login-done', id, ok: true, message: '凭据已保存' });
    } catch (e) {
      broadcast({ t: 'login-done', id, ok: false, message: e.message });
      throw e;
    } finally {
      broadcast({ t: 'state', site: siteView(site, loadState()) });
    }
  });
}

/* ---------------- 体检 ---------------- */

async function runDoctor() {
  const cfg = loadConfig();
  const checks = [];
  checks.push({ label: 'Node 运行时', ok: true, detail: process.version });

  let chrome = null;
  try {
    chrome = findBrowser();
  } catch {
    /* ignore */
  }
  checks.push({ label: 'Chrome 浏览器', ok: !!chrome, detail: chrome || '未找到，请安装 Chrome' });
  checks.push({
    label: 'LinuxDO 账号',
    ok: !!(cfg.linuxdo?.username && cfg.linuxdo?.password),
    detail: cfg.linuxdo?.username ? `${cfg.linuxdo.username}（已配置）` : '未配置（福利站需手动登录）',
    optional: true,
  });

  // 各站点并发探测，避免慢站点拖住整个体检
  const probes = cfg.sites.map(async (site) => {
    const rows = [];
    const t0 = Date.now();
    try {
      const r = await fetch(`${site.url}/api/status`, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      await r.text().catch(() => '');
      rows.push({
        label: `${site.name} 连通性`,
        ok: r.status < 500,
        detail: `HTTP ${r.status} · ${Date.now() - t0}ms`,
      });
    } catch (e) {
      rows.push({ label: `${site.name} 连通性`, ok: false, detail: e.message });
    }
    const c = getCred(site.id);
    rows.push({
      label: `${site.name} 凭据`,
      ok: !!c,
      detail: c ? `已保存（${new Date(c.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}）` : '未保存',
      optional: site.type === 'newapi' && !site.turnstile && !!site.username,
    });
    return rows;
  });

  for (const rows of await Promise.all(probes)) checks.push(...rows);
  return checks;
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* --- SSE 实时日志 --- */
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`data: ${JSON.stringify({ t: 'hello', busy: job, now: new Date().toISOString() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    /* --- 初始化数据 --- */
    if (p === '/api/bootstrap' && req.method === 'GET') {
      return json(res, 200, buildBootstrap());
    }

    /* --- 触发签到 --- */
    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      doRun(Array.isArray(body.ids) ? body.ids.filter(Boolean) : []);
      return json(res, 202, { ok: true, started: true });
    }

    /* --- 登录 --- */
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { ok: false, error: '缺少站点 id' });
      doLogin(String(body.id));
      return json(res, 202, { ok: true, started: true });
    }

    /* --- 体检 --- */
    if (p === '/api/doctor' && req.method === 'POST') {
      return json(res, 200, { ok: true, checks: await runDoctor() });
    }

    /* --- 站点配置 --- */
    const mSite = p.match(/^\/api\/sites\/([\w-]+)$/);
    if (mSite && req.method === 'PATCH') {
      const cfg = loadConfig();
      const site = findSite(cfg, mSite[1]);
      if (!site) return json(res, 404, { ok: false, error: '站点不存在' });
      const b = await readBody(req);

      if (typeof b.enabled === 'boolean') site.enabled = b.enabled;
      if (typeof b.username === 'string') site.username = b.username.trim();
      if (typeof b.password === 'string') site.password = b.password;
      if (typeof b.note === 'string') site.note = b.note;

      // 凭据写入 data/creds.json（与 config 分离，方便单独清理）
      const cred = {};
      if (typeof b.token === 'string' && b.token.trim()) cred.token = b.token.trim().replace(/^bearer\s+/i, '');
      if (typeof b.cookie === 'string' && b.cookie.trim()) cred.cookie = normalizeCookie(b.cookie, site);
      // new-api 新版要求 New-Api-User 头，值是数字用户 ID
      if (b.userId !== undefined && b.userId !== '') {
        const uid = parseInt(String(b.userId).trim(), 10);
        if (Number.isFinite(uid) && uid > 0) cred.userId = uid;
      }
      if (b.clearToken) cred.token = '';
      if (b.clearCookie) cred.cookie = '';
      if (b.clearUserId) cred.userId = '';

      saveConfig(cfg);
      if (Object.keys(cred).length) {
        const merged = { ...(getCred(site.id) || {}), ...cred };
        if (!merged.token) delete merged.token;
        if (!merged.cookie) delete merged.cookie;
        if (!merged.userId) delete merged.userId;
        saveCred(site.id, merged);
      }
      return json(res, 200, { ok: true, site: siteView(site, loadState()) });
    }

    /* --- 清除凭据 --- */
    const mCred = p.match(/^\/api\/sites\/([\w-]+)\/cred$/);
    if (mCred && req.method === 'DELETE') {
      const all = loadCreds();
      delete all[mCred[1]];
      fs.writeFileSync(path.join(ROOT, 'data', 'creds.json'), JSON.stringify(all, null, 2) + '\n', 'utf8');
      const cfg = loadConfig();
      const site = findSite(cfg, mCred[1]);
      return json(res, 200, { ok: true, site: site ? siteView(site, loadState()) : null });
    }

    /* --- 全局设置 --- */
    if (p === '/api/settings' && req.method === 'POST') {
      const cfg = loadConfig();
      const b = await readBody(req);
      if (typeof b.headless === 'boolean') cfg.settings.headless = b.headless;
      if (typeof b.proxy === 'string') cfg.settings.proxy = b.proxy.trim();
      if (typeof b.webhook === 'string') cfg.settings.notify = { ...(cfg.settings.notify || {}), webhook: b.webhook.trim() };
      if (typeof b.linuxdoUsername === 'string') cfg.linuxdo.username = b.linuxdoUsername.trim();
      if (typeof b.linuxdoPassword === 'string' && b.linuxdoPassword) cfg.linuxdo.password = b.linuxdoPassword;
      if (typeof b.linuxdoCookie === 'string' && b.linuxdoCookie.trim()) cfg.linuxdo.cookie = b.linuxdoCookie.trim();
      if (b.clearLinuxdoCookie) cfg.linuxdo.cookie = '';
      if (b.clearLinuxdo) cfg.linuxdo = { username: '', password: '', cookie: '' };
      saveConfig(cfg);
      return json(res, 200, { ok: true });
    }

    /* --- 今日日志尾部 --- */
    if (p === '/api/logs' && req.method === 'GET') {
      const n = Math.min(Number(url.searchParams.get('lines')) || 200, 2000);
      const d = new Date();
      const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
      const file = path.join(LOG_DIR, name);
      let lines = [];
      try {
        lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n);
      } catch {
        /* 今天还没跑过 */
      }
      return json(res, 200, { ok: true, lines });
    }

    if (p.startsWith('/api/')) {
      return json(res, 404, { ok: false, error: '接口不存在' });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    const code = e.status || 500;
    log('err', e.message);
    return json(res, code, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const link = `http://${shown}:${PORT}`;
  console.log('');
  console.log(`  自动签到控制台已启动`);
  console.log(`  ${link}`);
  console.log(`  数据目录: ${path.join(ROOT, 'data')}`);
  console.log(`  按 Ctrl+C 停止`);
  console.log('');
  if (AUTO_OPEN) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const argv = process.platform === 'win32' ? ['/c', 'start', '', link] : [link];
    try {
      spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* 打不开就算了 */
    }
  }
});

process.on('SIGINT', () => {
  console.log('\n再见');
  process.exit(0);
});
