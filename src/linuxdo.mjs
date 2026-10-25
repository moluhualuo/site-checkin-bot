/**
 * LinuxDO（Discourse）登录自动化
 *
 * 登录页结构（实测 linux.do/login）：
 *   #login-account-name     text
 *   #login-account-password password
 *   #login-button           登录按钮
 *
 * 两个坑（2026-10 实测）：
 *   1. 点「登录」后会弹出「人机验证」对话框（hCaptcha），不处理就永远停在登录页；
 *   2. /session/current.json 会被限流返回 429，不能只靠它判断登录态，
 *      改用「URL 是否已离开 /login」作为主信号。
 *
 * 另外 curl 访问 linux.do 会超时（命令行被拦），但浏览器可以正常打开，
 * 所以这里全部走浏览器上下文，不做 HTTP 登录。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { log as defaultLog } from './util.mjs';
import { hasCaptchaDialog, solveHcaptcha, clickVerifyButton, bringToFront, readHcaptchaToken } from './captcha.mjs';
import { gotoWithShield, hasTurnstileWidget, readTurnstileToken, solveTurnstile } from './turnstile.mjs';

export const LINUXDO_HOST = 'linux.do';
export const CONNECT_HOST = 'connect.linux.do';

/** 严格匹配 linux.do 本身（不含 connect.linux.do 等子域） */
export function onLinuxDo(url) {
  try {
    return new URL(url).hostname === LINUXDO_HOST;
  } catch {
    return false;
  }
}

/** LINUX DO Connect 授权域（OAuth2 的 authorize / approve 页面在这里） */
export function onLinuxConnect(url) {
  try {
    return new URL(url).hostname === CONNECT_HOST;
  } catch {
    return false;
  }
}

/** 是否已登录 linux.do（DOM 优先，网络兜底；429 不算未登录） */
export async function isLoggedIn(page) {
  const url = await page.url().catch(() => '');

  // /session/sso_provider 是纯跳转端点，DOM 里没有用户信息。
  // 能停在这里说明 Discourse 已经认了这个会话（否则会先 302 到 /login），
  // 所以不能用 DOM/current.json 判否，否则会反复重新登录形成死循环。
  if (/\/session\/sso_provider/.test(url)) return true;

  const dom = await page
    .evaluate(`(() => {
      if (document.querySelector('#current-user, .current-user')) return true;
      if (document.body && document.body.classList.contains('logged-in')) return true;
      return false;
    })()`)
    .catch(() => false);
  if (dom) return true;

  const status = await page
    .evaluate(`fetch('/session/current.json', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(r => r.status).catch(() => 0)`)
    .catch(() => 0);
  return status === 200;
}

/** 是否停在登录页 */
async function onLoginPage(page) {
  const url = await page.url().catch(() => '');
  if (!/\/login/.test(url)) return false;
  return page.evaluate(`!!document.querySelector('#login-account-password')`).catch(() => false);
}

/**
 * 注入 linux.do 的会话 cookie，用来跳过账号密码 + hCaptcha。
 * 支持三种形式：
 *   - 裸值                → 当作 `_t`
 *   - `_t=xxx`            → 单个
 *   - `_t=xxx; _forum_session=yyy` → 多个（推荐，两个一起给最稳）
 * @returns {Promise<boolean>} 是否至少写入成功一个
 */
export async function applySessionCookie(page, cookieValue) {
  const raw = String(cookieValue || '')
    .trim()
    .replace(/^cookie:\s*/i, '');
  if (!raw) return false;

  await page.send('Network.enable').catch(() => {});

  const setOne = async (name, value) => {
    try {
      const r = await page.send('Network.setCookie', {
        name,
        value,
        domain: '.linux.do',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return !!(r && r.success);
    } catch {
      return false;
    }
  };

  const parts = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // 单个值、且前半段不像 cookie 名（base64 里可能有 '=' 填充）→ 整体当 _t 的值
  if (parts.length === 1) {
    const i = parts[0].indexOf('=');
    const name = i > 0 ? parts[0].slice(0, i) : '';
    if (!/^[\w-]+$/.test(name)) return setOne('_t', parts[0]);
    return setOne(name, parts[0].slice(i + 1));
  }

  let any = false;
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const ok = await setOne(p.slice(0, i).trim(), p.slice(i + 1).trim());
    any = any || ok;
  }
  return any;
}

/** 页面上的登录错误提示 */
async function readLoginError(page) {
  return page
    .evaluate(`(() => {
      const els = [...document.querySelectorAll('.alert-error, .form-kit__error, .login-error, .tip.bad, #login-account-name + .tip')];
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || '').trim();
        if (t) return t.slice(0, 80);
      }
      return '';
    })()`)
    .catch(() => '');
}

/** 是否要求两步验证 */
async function needSecondFactor(page) {
  return page
    .evaluate(`!!document.querySelector('input[name="second_factor_code"], #second-factor, .second-factor-input')`)
    .catch(() => false);
}

/**
 * 确保 linux.do 已登录；未登录则用账号密码登录。
 * 遇到 hCaptcha 会尝试自动通过；过不了就把窗口弹到前台等你手动完成（最多等 manualWaitMs）。
 * @returns {{ok:boolean, reason?:string}}
 */
export async function ensureLogin(page, { username, password, cookie, log = defaultLog, timeout = 60000, manualWaitMs = 180000 } = {}) {
  // 有现成会话 cookie 就先注入，能直接跳过账号密码和 hCaptcha
  if (cookie) {
    const injected = await applySessionCookie(page, cookie);
    if (injected) {
      log('debug', '已注入 linux.do 会话 cookie');
      await gotoWithShield(page, 'https://linux.do/', { log, timeout: 60000 });
      await delay(2000);
      if (await isLoggedIn(page)) {
        log('ok', 'linux.do 会话有效（用 cookie 登录）');
        return { ok: true };
      }
      log('warn', 'linux.do cookie 已失效，改用账号密码登录');
    } else {
      log('warn', 'linux.do cookie 注入失败');
    }
  }

  if (!onLinuxDo(await page.url().catch(() => ''))) {
    await gotoWithShield(page, 'https://linux.do/', { log, timeout: 60000 });
    await delay(1500);
  }
  if (await isLoggedIn(page)) {
    log('debug', 'linux.do 已是登录状态');
    return { ok: true };
  }
  if (!(await onLoginPage(page))) {
    await gotoWithShield(page, 'https://linux.do/login', { log, timeout: 60000 });
    await delay(2000);
  }
  await page.waitFor(`!!document.querySelector('#login-account-password')`, { timeout: 20000, label: 'linux.do 登录表单' });

  if (!username || !password) {
    return { ok: false, reason: '未配置 LinuxDO 账号密码' };
  }

  log('info', '正在登录 linux.do…');
  await page.setInput('#login-account-name', username);
  await page.setInput('#login-account-password', password);
  await delay(200);
  await page.clickSelector('#login-button');

  let deadline = Date.now() + timeout;
  let captchaRounds = 0;
  let manual = false;
  let manualDeadline = 0;
  let netCheckedAt = 0;

  while (Date.now() < deadline) {
    await delay(1200);
    const url = await page.url().catch(() => '');

    // 主信号：离开 /login 就说明登录成功（会跳回首页或 sso_provider）
    if (url && !/\/login/.test(url)) {
      log('ok', 'linux.do 登录成功');
      return { ok: true };
    }

    if (await needSecondFactor(page)) {
      return { ok: false, reason: '账号开启了两步验证，无法自动登录' };
    }

    // 人机验证
    if (await hasCaptchaDialog(page)) {
      if (!manual && captchaRounds < 2) {
        captchaRounds += 1;
        log('info', '检测到人机验证（hCaptcha），尝试自动通过…');
        const r = await solveHcaptcha(page, { timeout: 25000, log });
        if (r.passed) {
          log('ok', `hCaptcha ${r.reason}`);
          await delay(400);
          const btn = await clickVerifyButton(page);
          if (btn) log('debug', `点击「${btn}」`);
          await delay(1800);
          continue;
        }
        if (r.needManual) {
          manual = true;
        } else {
          log('warn', `${r.reason}，改为人工`);
          manual = true;
        }
      }

      if (manual) {
        // 只延长一次，否则每轮都把截止时间往后推会变成死循环
        if (!manualDeadline) {
          manualDeadline = Date.now() + manualWaitMs;
          deadline = Math.max(deadline, manualDeadline);
          const shown = await bringToFront(page);
          log(
            'warn',
            `人机验证需要人工完成：${shown ? '浏览器窗口已弹到屏幕前面' : '浏览器窗口可能被挡住，请从任务栏找 Chrome'}，` +
              `请在里面完成拼图/勾选，完成后会自动继续（最多等 ${Math.round(manualWaitMs / 1000)} 秒）`
          );
        }
        // 人解完之后 token 就有了，帮忙点一下「验证」
        if (await readHcaptchaToken(page)) {
          const btn = await clickVerifyButton(page);
          if (btn) log('debug', `点击「${btn}」`);
          await delay(1500);
        }
        continue;
      }
    }

    // 错误提示（验证弹窗盖住时先不看，避免误判）
    const err = await readLoginError(page);
    if (err) return { ok: false, reason: `linux.do 登录失败：${err}` };

    // 网络兜底：低频调用，避免被 429
    if (Date.now() - netCheckedAt > 5000) {
      netCheckedAt = Date.now();
      if (await isLoggedIn(page)) {
        log('ok', 'linux.do 登录成功');
        return { ok: true };
      }
    }
  }

  return {
    ok: false,
    reason: manual ? '人机验证未完成（已等待人工操作超时）' : 'linux.do 登录超时',
  };
}

/** 点掉页面上「使用 Linux.do 登录」这类按钮（站点自己的登录页） */
/**
 * 勾上「我已阅读并同意 用户协议」。
 * 新版 new-api 前端（aapi.ssite.site 实测）在协议没勾选时，
 * 点「使用 LinuxDO 继续」**完全不发请求**——没有任何报错，只是没反应，
 * 很容易误判成选择器不对。所以点按钮前先把它勾上。
 */
async function ensureTermsChecked(page) {
  return page
    .evaluate(`(() => {
      const boxes = [...document.querySelectorAll('input[type=checkbox], [role="checkbox"]')];
      for (const b of boxes) {
        if (b.offsetParent === null) continue;
        const on = b.checked === true || b.getAttribute('aria-checked') === 'true' || b.getAttribute('data-state') === 'checked';
        if (on) continue;
        b.click();
        return true;
      }
      return false;
    })()`)
    .catch(() => false);
}

/**
 * 点登录页上的「使用 LinuxDO 继续」。
 * 有些站点（aapi.ssite.site 实测）的 `POST /api/oauth/state` 也要 Turnstile token，
 * 盾没过时点按钮**完全没反应**（不发请求也不报错），所以点之前先确保盾已通过。
 */
async function clickLinuxDoButton(page, { log = defaultLog } = {}) {
  if (await hasTurnstileWidget(page)) {
    const tok = await readTurnstileToken(page);
    if (!tok) {
      const s = await solveTurnstile(page, { timeout: 45000, wantToken: true, log });
      if (!s.passed) log('warn', `登录页 Turnstile 未通过：${s.reason}`);
      else log('debug', '登录页 Turnstile 已通过');
    }
  }
  const justChecked = await ensureTermsChecked(page);
  // React 勾选后要等一次重渲染按钮才会变可用，同一帧点下去等于点在禁用按钮上（aapi.ssite.site 实测）
  if (justChecked) {
    await delay(700);
    await page
      .waitFor(
        `[...document.querySelectorAll('button, a, [role="button"]')].some(e => /linux/i.test(e.innerText || '') && !e.disabled && e.getAttribute('aria-disabled') !== 'true')`,
        { timeout: 6000, label: 'LinuxDO 按钮可用' },
      )
      .catch(() => {});
  }
  return page
    .evaluate(`(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const txt = (el.innerText || el.value || '').trim();
        if (!txt || txt.length > 30) continue;
        const low = txt.toLowerCase();
        if (low.includes('linux') && (low.includes('do') || low.includes('登录') || low.includes('login'))) {
          el.click();
          return txt;
        }
      }
      return null;
    })()`)
    .catch(() => null);
}

/**
 * 点掉授权确认页。
 * LINUX DO Connect 的授权页长这样（2026-10 实测）：
 *   <a href="/oauth2/approve/<token>" class="btn-pill btn-pill-primary">允许</a>
 *   <a href="/oauth2/decline/<token>" class="btn-pill btn-pill-secondary">拒绝</a>
 * 注意 class 是 `btn-pill` 而不是 `btn`，用 `a.btn` 选不到，所以优先按 href 找。
 */
async function clickConsent(page) {
  return page
    .evaluate(`(() => {
      const approve = document.querySelector('a[href*="/oauth2/approve/"], form[action*="/oauth2/approve"]');
      if (approve && approve.offsetParent !== null) {
        approve.click();
        return (approve.innerText || '').trim() || 'oauth2/approve';
      }
      const els = [...document.querySelectorAll('button, a, input[type=submit], [role="button"]')];
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const txt = (el.innerText || el.value || '').trim();
        if (!txt || txt.length > 12) continue;
        if (/^(授权|允许|同意|Authorize|Allow|Approve)$/i.test(txt)) {
          el.click();
          return txt;
        }
      }
      return null;
    })()`)
    .catch(() => null);
}

/**
 * 走 OAuth 授权流程（状态机，处理多跳）：
 *   站点入口 → linux.do 登录 → 授权确认 → 回到站点
 * @param {string} entryUrl 站点自己的 OAuth 入口
 */
export async function authorize(page, entryUrl, { username, password, cookie, log = defaultLog, timeout = 90000, skipNavigate = false } = {}) {
  // skipNavigate：调用方已经把页面打开在入口上了（例如登录页按钮模式），
  // 再导航一次会白等一次 SPA 首屏加载，几秒到十几秒不等
  if (!skipNavigate) await gotoWithShield(page, entryUrl, { log, timeout: 60000 });
  // 站点多是 SPA，导航返回不代表按钮已经渲染出来。
  // 不等这一步，前两轮会「找不到可操作元素」直接退出（新版前端首屏可能要 5 秒以上）。
  await page
    .waitFor(`document.body && (document.body.innerText || '').trim().length > 10`, { timeout: 15000, label: '登录页渲染' })
    .catch(() => {});
  await delay(1800);

  let deadline = Date.now() + timeout;
  let idle = 0;
  let approved = false;
  let clickUrl = '';
  let clickCount = 0;

  for (let step = 0; step < 24 && Date.now() < deadline; step++) {
    await delay(1500);
    const url = await page.url().catch(() => '');
    const onConnect = onLinuxConnect(url);
    log('debug', `[oauth ${step + 1}] ${url}`);

    // 0) LINUX DO Connect 授权页：点「允许」就继续往下走
    if (onConnect) {
      const ok = await clickConsent(page);
      if (ok) {
        approved = true;
        log('ok', `已授权（点击「${ok}」）`);
        await delay(2500);
        idle = 0;
        continue;
      }
      // 授权页可能还在渲染，或者正在从 sso_provider 跳回来，别急着退出
      idle = 0;
      continue;
    }

    // 0b) 已授权且回到了站点（不在登录页）→ 流程结束，别空转到步数上限
    if (approved && url && !onLinuxDo(url) && !/\/(sign-?in|login)\b/i.test(url)) {
      log('debug', '已回到站点，授权流程结束');
      break;
    }

    // 0c) 已授权但仍停在站点登录页：前端可能还在等会话，也可能回调没建会话。
    //     这里绝对不能再去点「使用 LinuxDO 登录」——每次点击都会 POST /api/oauth/state，
    //     连续点会把该接口打成 429，之后连正常的授权都进不去了（实测 ultrarouter.org）。
    //     只等待，把判断交给调用方（它会用 refresh / localStorage 探测）。
    if (approved && url && !onLinuxDo(url)) {
      idle += 1;
      if (idle >= 6) {
        log('warn', '已授权但仍停在登录页，放弃继续点击（避免 OAuth state 限流）');
        break;
      }
      continue;
    }

    // 1) 停在 linux.do 登录页 → 登录
    if (onLinuxDo(url) && (await onLoginPage(page))) {
      const r = await ensureLogin(page, { username, password, cookie, log, timeout: Math.min(timeout, 60000) });
      if (!r.ok) return r;
      // 人工过验证可能花掉几分钟，把循环的截止时间往后推
      deadline = Math.max(deadline, Date.now() + 60000);
      await gotoWithShield(page, entryUrl, { log, timeout: 60000 });
      await delay(1800);
      idle = 0;
      continue;
    }

    // 1b) 在 linux.do 但不在登录页（如 /session/sso_provider）且未登录 → 先登录再重走入口
    if (onLinuxDo(url) && !(await isLoggedIn(page))) {
      const r = await ensureLogin(page, { username, password, cookie, log, timeout: Math.min(timeout, 60000) });
      if (!r.ok) return r;
      deadline = Math.max(deadline, Date.now() + 60000);
      await gotoWithShield(page, entryUrl, { log, timeout: 60000 });
      await delay(1800);
      idle = 0;
      continue;
    }

    // 2) 站点登录页上的「使用 Linux.do 登录」（connect.linux.do 上不能点，会点到品牌链接）
    if (!onLinuxDo(url) && !onConnect) {
      // 同一个地址上连点超过 2 次说明按钮根本没起作用（协议没勾、前端校验没过、接口 429…），
      // 再点下去只会把 OAuth 接口打限流，所以直接放弃这一轮
      if (clickUrl === url && clickCount >= 2) {
        log('warn', `「使用 LinuxDO 登录」点了 ${clickCount} 次页面都没跳转，停止点击（避免 OAuth 接口限流）`);
        idle += 1;
        if (idle >= 2) break;
        continue;
      }
      const btn = await clickLinuxDoButton(page, { log });
      if (btn) {
        log('debug', `点击「${btn}」`);
        clickCount = clickUrl === url ? clickCount + 1 : 1;
        clickUrl = url;
        await delay(2500);
        idle = 0;
        continue;
      }
    }

    // 3) 授权确认页（其它实现风格）
    const ok = await clickConsent(page);
    if (ok) {
      approved = true;
      log('ok', `已授权（点击「${ok}」）`);
      await delay(2500);
      idle = 0;
      continue;
    }

    // 已授权且离开了 linux.do / connect → 说明回调链在跑，给它点时间
    if (approved && !onLinuxDo(url) && !onConnect) {
      await delay(1500);
      idle = 0;
      continue;
    }

    // 没有可操作的东西了，连续几次都空转才退出（给 SPA 渲染和跳转留余量）
    idle += 1;
    if (idle >= 4) break;
  }

  return { ok: true };
}
