/**
 * new-api / one-api 系站点适配器
 * 已确认的接口（windhub.cc、api.hcnsec.cn）：
 *   POST /api/user/login      { username, password }  -> data.token
 *   POST /api/user/checkin    Authorization: Bearer <token>
 *   GET  /api/user/checkin?month=YYYY-MM  查询签到记录
 *   GET  /api/user/self       探测登录态
 *
 * 关于 New-Api-User 头：
 *   新版 new-api 用「访问令牌」调 /api/user/* 时，必须同时带上 `New-Api-User: <用户ID>`，
 *   否则返回 401「无权进行此操作，未提供 New-Api-User」。
 *   旧版（如 api.hcnsec.cn）不校验这个头，带上也无害，所以统一都带。
 */
import { request, classify, cookieHeader, log as defaultLog } from '../util.mjs';
import { gotoWithShield, solveTurnstile, readTurnstileToken, renderTurnstileToken, hasTurnstileWidget } from '../turnstile.mjs';
import { authorize, applySessionCookie } from '../linuxdo.mjs';

/** 统一的鉴权头：Bearer token + New-Api-User */
function authHeaders(site, cred) {
  const headers = {};
  if (cred?.token) headers.Authorization = `Bearer ${cred.token}`;
  const uid = cred?.userId || site.userId;
  if (uid) headers['New-Api-User'] = String(uid);
  return headers;
}

/* ---------------- HTTP ---------------- */

export async function loginHttp(site, { log = defaultLog } = {}) {
  if (!site.username || !site.password) {
    throw new Error('未配置账号密码，请先在 config/sites.json 里填写 username / password');
  }
  const r = await request(`${site.url}/api/user/login`, {
    method: 'POST',
    body: { username: site.username, password: site.password },
  });
  const j = r.body;
  if (!j) throw new Error(`登录返回非 JSON (HTTP ${r.status})`);
  if (!j.success) throw new Error(j.message || `登录失败 (HTTP ${r.status})`);
  if (j.data?.require_2fa) throw new Error('账号开启了二次验证(2FA)，无法自动登录，请用 login 命令手动登录一次');

  const token = j.data?.token || null;
  const cookie = cookieHeader(r.cookies);
  if (!token && !cookie) throw new Error('登录成功但没拿到 token / cookie');
  log('debug', `HTTP 登录成功，token=${token ? '有' : '无'} cookie=${cookie ? '有' : '无'}`);
  return { token, cookie, user: j.data };
}

/** 签到路径：多数站是 /api/user/checkin，魔改站可能换成混淆路径（如 ultrarouter 的 daily-9f3k） */
function checkinPath(site) {
  return site.checkinPath || '/api/user/checkin';
}

export async function checkinHttp(site, cred, { log = defaultLog } = {}) {
  const r = await request(`${site.url}${checkinPath(site)}`, {
    method: 'POST',
    headers: authHeaders(site, cred),
    cookie: cred?.cookie,
    body: {},
  });
  const res = classify(r.body, r.status);
  log('debug', `签到返回 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return { ...res, raw: r.body, httpStatus: r.status };
}

export async function fetchStatus(site, cred) {
  const month = new Date().toISOString().slice(0, 7);
  const r = await request(`${site.url}${checkinPath(site)}?month=${month}`, { headers: authHeaders(site, cred), cookie: cred?.cookie });
  return r.body;
}

/** 探测登录态（200 = 已登录） */
export async function probeHttp(site, cred) {
  const r = await request(`${site.url}${site.probe || '/api/user/self'}`, { headers: authHeaders(site, cred), cookie: cred?.cookie });
  return r.status === 200 && r.body?.success !== false;
}

/* ---------------- 浏览器登录（带 Turnstile） ---------------- */

async function fillLoginForm(page, site, log) {
  // 部分站点默认只显示 OAuth 按钮，需要先展开「邮箱/用户名登录」
  const hasPw = () => page.evaluate(`!!document.querySelector('input[type="password"]')`).catch(() => false);
  if (!(await hasPw())) {
    const clicked = await page.clickByText([
      '使用 邮箱或用户名 登录',
      '使用邮箱或用户名登录',
      '邮箱或用户名登录',
      '邮箱/用户名登录',
      '账号登录',
      '密码登录',
      '邮箱登录',
      '用户名登录',
    ]);
    if (clicked) {
      log('debug', `已展开账号登录表单: ${clicked}`);
      await page.waitFor(`!!document.querySelector('input[type="password"]')`, { timeout: 8000 }).catch(() => {});
    }
  }

  const hasUser = await page.evaluate(`!!document.querySelector('input[name="username"], input#username')`);
  if (!hasUser) {
    // 有些站点用 email / 手机号登录
    const first = await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('input')].find(i => ['text','email','tel'].includes(i.type));
      return el ? (el.name || el.id || '') : '';
    })()`);
    if (!first) throw new Error('找不到账号输入框');
    await page.setInput(`input[name="${first}"]`, site.username);
  } else {
    const sel = (await page.evaluate(`document.querySelector('input[name="username"]') ? 'input[name="username"]' : 'input#username'`)) || 'input[name="username"]';
    await page.setInput(sel, site.username);
  }
  await page.setInput('input[type="password"]', site.password);

  // 用户协议勾选
  await page
    .evaluate(`(() => {
      const ids = ['legal-consent', 'agree', 'agreement'];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.type === 'checkbox' && !el.checked) { (el.closest('label') || el).click(); return 'clicked:' + id; }
      }
      const box = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => c.offsetParent !== null);
      if (box && !box.checked) { (box.closest('label') || box).click(); return 'clicked:auto'; }
      return 'none';
    })()`)
    .then((r) => log('debug', `协议勾选: ${r}`))
    .catch(() => {});

  log('debug', '账号密码已填入');
}

async function submitLogin(page) {
  const ok = await page.evaluate(`(() => {
    const pw = document.querySelector('input[type="password"]');
    const scope = (pw && pw.closest('form')) || document;
    const btns = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')];
    const b = btns.find((x) => /^(登录|登 录|Login|Sign in)$/i.test(((x.innerText || x.value || '') + '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error('找不到「登录」按钮');
  return ok;
}

export async function loginBrowser(site, page, { log = defaultLog, timeout = 60000 } = {}) {
  if (!site.username || !site.password) {
    throw new Error('未配置账号密码，请先在 config/sites.json 里填写该站点的 username / password');
  }
  const res = await gotoWithShield(page, `${site.url}/login`, { log, timeout });
  if (res.blocked) throw new Error(res.reason);

  // 已经登录过（profile 里有会话）
  const already = await page.evaluate(`!!localStorage.getItem('user')`).catch(() => false);
  if (!already) {
    await page.waitFor(`document.body && document.body.innerText.length > 5`, { timeout: 25000, label: '登录页渲染' });
    await fillLoginForm(page, site, log);

    if (site.turnstile) {
      log('info', '正在通过 Turnstile…');
      const s = await solveTurnstile(page, { timeout: 45000, wantToken: true, log });
      if (!s.passed) throw new Error(`Turnstile 未通过：${s.reason}`);
      const tok = await readTurnstileToken(page);
      log('ok', `Turnstile 已通过${tok ? `（token ${tok.slice(0, 12)}…）` : ''}`);
    }

    await submitLogin(page);
    const ok = await page
      .waitFor(`!!localStorage.getItem('user')`, { timeout: 20000 })
      .catch(() => false);
    if (!ok) {
      const err = await page
        .evaluate(`(() => {
          const t = document.body.innerText || '';
          const m = t.match(/(用户名或密码错误|密码错误|用户不存在|登录失败|验证失败|Turnstile[^\\n]{0,30})/);
          return m ? m[0] : t.slice(0, 160).replace(/\\n/g, ' | ');
        })()`)
        .catch(() => '');
      throw new Error(`登录未成功：${err}`);
    }
  } else {
    log('debug', '检测到已有登录会话');
  }

  const token = await page.evaluate(`(() => {
    try { const u = JSON.parse(localStorage.getItem('user') || '{}'); return u.token || null; } catch (e) { return null; }
  })()`);
  const cookies = await page.cookies([site.url]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!token && !cookie) throw new Error('登录后未取到 token/cookie');
  log('ok', '浏览器登录成功');
  return { token, cookie, cookies };
}

/** 在页面上下文里调签到接口（自动带上站内 Cookie） */
async function postCheckinInPage(page, site, cred, turnstileToken, log) {
  const base = `${site.url}${checkinPath(site)}`;
  const url = turnstileToken ? `${base}?turnstile=${encodeURIComponent(turnstileToken)}` : base;
  const r = await page.evaluate(`fetch(${JSON.stringify(url)}, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ${JSON.stringify(cred?.token || '')},
      'New-Api-User': ${JSON.stringify(String(cred?.userId || site.userId || ''))}
    },
    body: '{}'
  }).then(async r => ({ status: r.status, body: await r.text() }))
    .catch(e => ({ status: 0, body: 'ERR:' + e.message }))`);
  let body = null;
  try {
    body = JSON.parse(r.body);
  } catch {
    /* 非 JSON */
  }
  log('debug', `页面内签到 HTTP ${r.status}: ${String(r.body).slice(0, 160)}`);
  return { ...classify(body, r.status), raw: body, httpStatus: r.status };
}

/**
 * 签到接口要求 Turnstile token 时的解法：
 * 在登录页过盾拿一个 token（全站同一 sitekey），立刻拿去签到。
 */
export async function checkinWithTurnstile(page, site, cred, { log = defaultLog } = {}) {
  // 登录页路径各站不同：老版 /login，新版前端 /sign-in
  await gotoWithShield(page, `${site.url}${site.loginPath || '/login'}`, { log, timeout: 45000 });
  await page.waitFor(`document.querySelectorAll('input').length > 0`, { timeout: 6000 }).catch(() => {});

  // 已登录时登录页会跳走，页面上根本没有盾组件 —— 这种情况别在登录页上死等，
  // 直接走下面的自渲染（实测在 aapi.ssite.site 上省掉 65 秒）
  let tok = null;
  if (await hasTurnstileWidget(page)) {
    tok = await readTurnstileToken(page);
    if (!tok) {
      const s = await solveTurnstile(page, { timeout: 30000, wantToken: true, log });
      if (s.passed) tok = await readTurnstileToken(page);
    }
  }

  if (!tok) {
    const st = await request(`${site.url}/api/status`).catch(() => null);
    const key = st?.body?.data?.turnstile_site_key || site.turnstileKey;
    if (key) {
      log('debug', '登录页拿不到盾 token，改为自渲染 Turnstile');
      tok = await renderTurnstileToken(page, key, { log });
    }
  }
  if (!tok) throw new Error('未取到 Turnstile token');

  log('ok', `Turnstile token 已获取（${tok.slice(0, 12)}…）`);

  return postCheckinInPage(page, site, cred, tok, log);
}

/** 兜底：直接在页面里点「签到」按钮 */
export async function checkinInPage(page, site, { log = defaultLog } = {}) {
  const paths = ['/console/personal', '/console', '/'];
  for (const p of paths) {
    try {
      await gotoWithShield(page, `${site.url}${p}`, { log, timeout: 40000 });
      await page.waitFor('document.body && document.body.innerText.length > 5', { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      const clicked = await page.clickByText(['签到', '立即签到', '每日签到', '今日签到', '领取额度']);
      if (!clicked) continue;
      log('debug', `在 ${p} 点击了「${clicked}」`);

      // 等 toast
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        const hit = await page
          .evaluate(`(() => {
            const t = document.body.innerText || '';
            const m = t.match(/(签到成功[^\\n]{0,40}|今日已签到|已经签到|签到失败[^\\n]{0,40}|请先完成验证|验证失败)/);
            return m ? m[0] : null;
          })()`)
          .catch(() => null);
        if (hit) {
          const state = /成功/.test(hit) ? 'ok' : /已签到|已经签到/.test(hit) ? 'already' : 'fail';
          return { state, message: hit, raw: null, via: 'browser' };
        }
      }
      return { state: 'fail', message: '点击签到后未收到结果提示', raw: null, via: 'browser' };
    } catch (e) {
      log('debug', `${p} 页面签到失败: ${e.message}`);
    }
  }
  return null;
}

/**
 * 用 LinuxDO OAuth 登录（新版 new-api 的流程）：
 *   1. 前端调 /api/oauth/state?mode=login 拿 state
 *   2. 跳 connect.linux.do/oauth2/authorize?client_id=<站点>&redirect_uri=<站点>/api/oauth/linuxdo
 *   3. 授权后回调 /api/oauth/linuxdo?code=...&state=...，服务端下发 session cookie
 * 注意：直接 GET /api/oauth/linuxdo 会返回「无效的授权码」——那个 URL 是回调端点，不是入口。
 * @returns {{token:string|null, cookie:string, userId:number, username:string}}
 */
export async function loginOAuth(site, page, { linuxdo, log = defaultLog, timeout = 90000 } = {}) {
  if (!linuxdo?.cookie && !(linuxdo?.username && linuxdo?.password)) {
    throw new Error('未配置 LinuxDO 账号或 cookie');
  }

  const st = await request(`${site.url}/api/status`);
  const d = st.body?.data || {};
  if (!d.linuxdo_oauth || !d.linuxdo_client_id) throw new Error('站点未开启 LinuxDO OAuth');

  // 新版前端（ultrarouter.org / happycoding.xyz）的凭据获取方式：
  //   OAuth 回调只下发 httpOnly 的 refresh cookie，
  //   前端调 /api/user/auth/refresh 换一个 15 分钟的 access token（只存内存，localStorage 是空的）
  const tryRefresh = async () => {
    const rt = await page
      .evaluate(`fetch('/api/user/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(async r => { const t = await r.text(); return { status: r.status, body: t }; })
        .catch(e => ({ status: 0, body: 'ERR:' + e.message }))`)
      .catch(() => null);
    if (!rt || rt.status !== 200) return null;
    try {
      return JSON.parse(rt.body)?.data?.access_token || null;
    } catch {
      return null;
    }
  };

  /** 用 refresh 换 token 并验证真的能访问 /api/user/self */
  const currentCred = async () => {
    const token = await tryRefresh();
    if (!token) return null;
    const code = await page
      .evaluate(`fetch('/api/user/self', { credentials: 'include', headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)} } })
        .then(r => r.status).catch(() => 0)`)
      .catch(() => 0);
    if (code !== 200) return null;
    const cookies = await page.cookies([site.url]);
    return {
      token,
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      userId: jwtSubject(token),
      username: '',
    };
  };

  const g = await gotoWithShield(page, `${site.url}${site.loginPath || '/login'}`, { log, timeout: 60000 });
  if (g.blocked) throw new Error(g.reason);

  // 浏览器 profile 里的会话可能还在（refresh cookie 有的是持久化的），
  // 能复用就别再走一遍 OAuth——省 30 秒，也省掉 OAuth 接口的限流风险
  const reuse = await currentCred();
  if (reuse) {
    log('ok', `沿用浏览器里已有的会话${reuse.userId ? `（用户 ID ${reuse.userId}）` : ''}`);
    return reuse;
  }

  // 要走 OAuth 了，先把 linux.do 会话灌进浏览器：否则第一次点按钮会落到 linux.do/login，
  // 白多走一轮跳转，还会多消耗一次 OAuth state 请求（有的站点会因此 429）
  if (linuxdo.cookie) {
    const lg = await gotoWithShield(page, 'https://linux.do/', { log, timeout: 60000 }).catch(() => null);
    if (lg && !lg.blocked) {
      const injected = await applySessionCookie(page, linuxdo.cookie).catch(() => false);
      if (injected) {
        log('debug', '已预置 linux.do 会话 cookie');
        await gotoWithShield(page, `${site.url}${site.loginPath || '/login'}`, { log, timeout: 60000 }).catch(() => {});
      }
    }
  }

  const state = await page
    .evaluate(`fetch('/api/oauth/state?mode=login', { credentials: 'include' })
      .then(r => r.json()).then(j => (j && j.data) || null).catch(() => null)`)
    .catch(() => null);

  // 两种前端实现：
  //   老版：前端先取 state，再自己拼 connect.linux.do 授权地址
  //   新版（如 ultrarouter.org）：没有 /api/oauth/state 接口（返回「未知的 OAuth 提供商」），
  //         state 由服务端在跳转时自己生成，所以直接点登录页上的「使用 LinuxDO 继续」即可
  let entry;
  if (state) {
    log('debug', `OAuth state: ${state}`);
    entry =
      `https://connect.linux.do/oauth2/authorize?client_id=${encodeURIComponent(d.linuxdo_client_id)}` +
      `&redirect_uri=${encodeURIComponent(`${site.url}/api/oauth/linuxdo`)}` +
      `&response_type=code&scope=user&state=${encodeURIComponent(state)}`;
  } else {
    log('debug', '该站不支持前端取 state，改为点击登录页上的 LinuxDO 按钮');
    entry = `${site.url}${site.loginPath || '/login'}`;
    // SPA 渲染需要时间，等按钮出来再交给状态机。
    // 注意条件要包含「已经不在登录页了」——如果会话其实还有效，站点会自动跳 dashboard，
    // 这时永远等不到按钮，纯等按钮会把超时时间白白耗光（实测 15 秒）
    await page
      .waitFor(
        `(() => {
          if (!/\\/(sign-?in|login)/i.test(location.pathname)) return true;
          return [...document.querySelectorAll('button, a, [role="button"]')].some(e => /linux/i.test(e.innerText || ''));
        })()`,
        { timeout: 8000, label: 'LinuxDO 登录按钮' },
      )
      .catch(() => {});
  }

  const r = await authorize(page, entry, {
    cookie: linuxdo.cookie,
    username: linuxdo.username,
    password: linuxdo.password,
    log,
    timeout,
    // 按钮模式下页面已经停在登录页了，不用再导航一次
    skipNavigate: !state,
  });
  if (!r.ok) throw new Error(r.reason);

  // 授权完成后拿凭据：
  //   新版：refresh 换 access token（tryRefresh 已在上面定义）
  //   老版：token 和 user 存在 localStorage
  let token = await tryRefresh();

  if (!token) {
    // 老版前端：等 localStorage 里的 user 出现（新版不会出现，所以这里只是兜底，别等太久）
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 800));
      const u = await page
        .evaluate(`(() => {
          try { const x = JSON.parse(localStorage.getItem('user') || 'null'); return x ? { id: x.id, token: x.token || null, username: x.username || '' } : null; } catch (e) { return null; }
        })()`)
        .catch(() => null);
      if (u?.id) {
        const cookies = await page.cookies([site.url]);
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        log('ok', `OAuth 登录成功（${u.username || u.id}）`);
        return { token: u.token, cookie, userId: u.id, username: u.username };
      }
    }
    token = await tryRefresh();
  }

  if (token) {
    const userId = jwtSubject(token);
    const cookies = await page.cookies([site.url]);
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    log('ok', `OAuth 登录成功（refresh 换到 access token${userId ? `，用户 ID ${userId}` : ''}）`);
    return { token, cookie, userId, username: '' };
  }

  throw new Error('OAuth 授权完成但没拿到站点用户信息');
}

/** 从 JWT 里取 sub（new-api 的 access token 里 sub 就是用户 ID） */
function jwtSubject(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const n = Number(payload?.sub);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ---------------- 组合：跑一个站点 ---------------- */

const isTurnstileBlock = (msg) => /turnstile|验证|人机|robot|challenge/i.test(String(msg || ''));

function needBrowser() {
  const err = new Error('需要浏览器过盾');
  err.code = 'NEED_BROWSER';
  return err;
}

/**
 * 登录后签到；如果签到接口要求 Turnstile，就过盾拿 token 再签一次。
 * 注意 OAuth 分支以前直接 return 了 checkinHttp 的结果，
 * 导致「OAuth 能登录但签到要过盾」的站点（如 aapi.ssite.site）永远签不上。
 */
async function checkinAfterLogin(site, cred, page, { log }) {
  let r = await checkinHttp(site, cred, { log });
  if (r.state === 'fail' && isTurnstileBlock(r.message)) {
    log('warn', `接口签到被拦截（${r.message}），改为过盾后签到`);
    if (!page) throw needBrowser();
    try {
      const alt = await checkinWithTurnstile(page, site, cred, { log });
      if (alt.state !== 'fail') return alt;
      r = alt;
    } catch (e) {
      log('warn', `过盾签到失败：${e.message}`);
    }
    const btn = await checkinInPage(page, site, { log });
    if (btn) return btn;
  }
  return r;
}

export async function run(site, ctx) {
  const { cred, saveCred, log, linuxdo } = ctx;
  const canOAuth = !!(linuxdo?.cookie || (linuxdo?.username && linuxdo?.password));

  // 0) 什么都没有：直接失败，不用白启一次浏览器
  if (!cred?.token && !cred?.cookie && (!site.username || !site.password) && !canOAuth) {
    throw new Error('未配置账号密码或访问令牌，请在控制台点该站点的「配置」填入');
  }

  // 1) 已有凭据：先走接口（最快，不启浏览器）
  if (cred?.token || cred?.cookie) {
    const r = await checkinHttp(site, cred, { log });
    if (r.state === 'ok' || r.state === 'already') return r;

    if (r.state === 'fail' && isTurnstileBlock(r.message)) {
      // 签到接口也要过盾
      if (!ctx.page) throw needBrowser();
      log('warn', `接口签到被拦截（${r.message}），改为过盾后签到`);
      try {
        const alt = await checkinWithTurnstile(ctx.page, site, cred, { log });
        if (alt.state !== 'fail') return alt;
      } catch (e) {
        log('warn', `过盾签到失败：${e.message}`);
      }
      const btn = await checkinInPage(ctx.page, site, { log });
      return btn || r;
    }
    if (r.state !== 'auth') return r;
    log('warn', '凭据已失效，尝试重新登录');
  }

  // 2) 优先用 LinuxDO OAuth 重新登录（不需要账号密码，还能顺便拿到用户 ID）
  if (canOAuth) {
    if (!ctx.page) throw needBrowser();
    try {
      const c = await loginOAuth(site, ctx.page, { linuxdo, log });
      saveCred(site.id, c);
      const r = await checkinAfterLogin(site, c, ctx.page, { log });
      if (r.state === 'auth') throw new Error('OAuth 登录后签到仍返回未授权');
      return r;
    } catch (e) {
      log('warn', `OAuth 登录失败：${e.message}`);
    }
  }

  // 3) 无 Turnstile 的站点：纯 HTTP 账号密码登录
  if (!site.turnstile && site.username && site.password) {
    try {
      const c = await loginHttp(site, { log });
      saveCred(site.id, c);
      const r = await checkinHttp(site, c, { log });
      if (r.state === 'auth') throw new Error('登录后签到仍返回未授权');
      return r;
    } catch (e) {
      log('warn', `HTTP 登录失败：${e.message}，改用浏览器重试`);
    }
  }

  // 4) 浏览器登录 + 签到
  if (!ctx.page) throw needBrowser();
  const c = await loginBrowser(site, ctx.page, { log });
  saveCred(site.id, c);
  return checkinAfterLogin(site, c, ctx.page, { log });
}
