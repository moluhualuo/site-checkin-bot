/**
 * 自建「福利站」适配器（fuli / fengwind）
 *
 * 两者都是 OAuth 登录，没有账号密码接口：
 *   fuli     : LinuxDO OAuth -> 会话 Cookie，POST /api/checkin
 *   fengwind : 主站 SSO       -> localStorage.welfare_token (Bearer)，POST /api/checkin
 * 因此首次必须人工登录一次，之后复用持久化 profile + 保存下来的凭据。
 */
import { request, classify, log as defaultLog } from '../util.mjs';
import { gotoWithShield } from '../turnstile.mjs';
import { authorize, onLinuxDo } from '../linuxdo.mjs';

/**
 * 只要拿到 token 或 cookie 任意一种就发出去。
 * 同时带两个也无害，省得纠结站点到底认哪个。
 */
function authOf(cred) {
  const headers = {};
  if (cred?.token) headers.Authorization = `Bearer ${cred.token}`;
  return { headers, cookie: cred?.cookie || undefined };
}

export async function checkinHttp(site, cred, { log = defaultLog } = {}) {
  const { headers, cookie } = authOf(cred);
  const r = await request(`${site.url}${site.checkinPath || '/api/checkin'}`, {
    method: 'POST',
    headers,
    cookie,
    body: {},
  });
  const res = classify(r.body, r.status);
  log('debug', `签到返回 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return { ...res, raw: r.body, httpStatus: r.status };
}

export async function probeHttp(site, cred) {
  const { headers, cookie } = authOf(cred);
  const r = await request(`${site.url}${site.probe || '/api/user/self'}`, { headers, cookie });
  return r.status === 200;
}

/**
 * 在页面里探测登录态（用页面自身的 cookie 上下文）。
 * 注意：fengwind 的 /api/me 只认 Authorization: Bearer <localStorage.welfare_token>，
 * 光带 cookie 会返回 401，所以有 tokenKey 时必须把 token 一起带上。
 */
async function probeInPage(page, site) {
  const path = site.probe || '/api/user/self';
  const key = JSON.stringify(site.tokenKey || '');
  return page
    .evaluate(`(async () => {
      let tok = null;
      try { tok = ${key} ? localStorage.getItem(${key}) : null; } catch (e) { tok = null; }
      const headers = tok ? { Authorization: 'Bearer ' + tok } : {};
      try {
        const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers });
        return r.status;
      } catch (e) { return 0; }
    })()`)
    .then((s) => s === 200)
    .catch(() => false);
}

/** 从当前页面抓取凭据 */
export async function grabCreds(page, site) {
  const cookies = await page.cookies([site.url]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  let token = null;
  if (site.tokenKey) {
    token = await page
      .evaluate(`(() => { try { return localStorage.getItem(${JSON.stringify(site.tokenKey)}) || null; } catch (e) { return null; } })()`)
      .catch(() => null);
  }
  return { cookie, token, cookies, ua: await page.evaluate('navigator.userAgent').catch(() => '') };
}

/**
 * 解析站点的 OAuth 入口：
 *   fuli     -> /api/oauth/linuxdo（直接 302 到 linux.do）
 *   fengwind -> /api/auth/login-url 返回 { login_url }
 */
async function resolveOAuthEntry(page, site) {
  if (site.oauthUrl) return `${site.url}${site.oauthUrl}`;
  if (site.loginUrlApi) {
    const url = await page
      .evaluate(`fetch(${JSON.stringify(site.loginUrlApi)}, { credentials: 'include' })
        .then(r => r.json())
        .then(j => (j && j.data && j.data.login_url) || null)
        .catch(() => null)`)
      .catch(() => null);
    if (url) return url;
  }
  return site.url;
}

/**
 * 全自动登录：用 LinuxDO 账号密码走完 OAuth 授权，拿到站点会话。
 */
export async function loginAuto(site, page, { linuxdo, log = defaultLog, timeout = 120000 } = {}) {
  if (!linuxdo?.username || !linuxdo?.password) {
    throw new Error('未配置 LinuxDO 账号密码（config/sites.json 的 linuxdo 段）');
  }
  // 必须先站到站点源上，否则 /api/... 相对请求会打到 about:blank
  const cur = await page.url().catch(() => '');
  if (!cur.startsWith(site.url)) {
    const r = await gotoWithShield(page, site.url, { log, timeout: 60000 });
    if (r.blocked) throw new Error(r.reason);
  }

  const entry = await resolveOAuthEntry(page, site);
  log('debug', `OAuth 入口: ${entry.slice(0, 80)}`);

  const r = await authorize(page, entry, { username: linuxdo.username, password: linuxdo.password, cookie: linuxdo.cookie, log, timeout });
  if (!r.ok) throw new Error(r.reason);

  // 等回到站点并建立会话
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 1500));
    if (onLinuxDo(await page.url().catch(() => ''))) continue;
    if (await probeInPage(page, site)) {
      log('ok', '站点会话已建立');
      return grabCreds(page, site);
    }
  }
  throw new Error('授权完成但未检测到站点登录状态');
}

/**
 * 人工登录：打开可见浏览器，等用户在页面里完成 OAuth。
 * @returns 凭据
 */
export async function loginInteractive(site, page, { log = defaultLog, timeout = 300000 } = {}) {
  const res = await gotoWithShield(page, site.url, { log, timeout: 60000 });
  if (res.blocked) throw new Error(res.reason);

  await page.waitFor('document.body && document.body.innerText.length > 10', { timeout: 20000 }).catch(() => {});
  if (await probeInPage(page, site)) {
    log('ok', '检测到已登录，直接复用当前会话');
    return grabCreds(page, site);
  }

  log('info', '请在打开的浏览器窗口里完成登录（LinuxDO / 主站 SSO），登录后会自动继续…');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      if (await probeInPage(page, site)) {
        log('ok', '登录成功，正在保存凭据');
        return grabCreds(page, site);
      }
    } catch {
      /* 页面跳转中 */
    }
  }
  throw new Error('等待登录超时');
}

/* ---------------- 组合 ---------------- */

export async function run(site, ctx) {
  const { cred, saveCred, log, linuxdo } = ctx;

  if (cred && (cred.token || cred.cookie)) {
    const r = await checkinHttp(site, cred, { log });
    if (r.state !== 'auth') return r;
    log('warn', '保存的凭据已失效，尝试刷新会话');
  }

  if (!ctx.page) {
    const err = new Error('需要浏览器刷新会话');
    err.code = 'NEED_BROWSER';
    throw err;
  }

  const res = await gotoWithShield(ctx.page, site.url, { log, timeout: 60000 });
  if (res.blocked) throw new Error(res.reason);

  if (!(await probeInPage(ctx.page, site))) {
    // 会话没了，有 LinuxDO 账号就自动重新授权
    if (linuxdo?.username && linuxdo?.password) {
      log('info', '会话已过期，用 LinuxDO 账号重新授权…');
      const fresh = await loginAuto(site, ctx.page, { linuxdo, log });
      saveCred(site.id, fresh);
      return checkinHttp(site, fresh, { log });
    }
    throw new Error(`未登录，请点「登录」完成一次授权（或命令行 node checkin.mjs login --site ${site.id}）`);
  }

  const fresh = await grabCreds(ctx.page, site);
  saveCred(site.id, fresh);
  log('debug', '已刷新凭据');

  const r = await checkinHttp(site, fresh, { log });
  return r;
}
