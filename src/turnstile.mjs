/**
 * Cloudflare 过盾模块
 *
 * 关键结论（本机实测）：
 *  - `--headless=new` 会被 Cloudflare 识别，Turnstile 必定「验证失败」
 *  - 有头但窗口移到屏幕外（--window-position=-2400,-2400）可稳定通过
 *  - Turnstile 复选框在 closed shadow DOM 里，querySelectorAll 抓不到，
 *    必须用 DOM.getDocument({pierce:true}) + DOM.getBoxModel 定位后按坐标点击
 *
 * 参考：moluhualuo/headless-chrome-cdp 的 CDP-only 思路，此处按实测结果重写。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { log as defaultLog } from './util.mjs';

const CF_HOST = 'challenges.cloudflare.com';
const CHALLENGE_TEXT =
  /Just a moment|请稍候|Checking your browser|Verifying you are human|Verify you are human|确认您是真人|请验证您是真人|正在验证/i;
const BLOCKED_TEXT = /Sorry, you have been blocked|您已被阻止|Attention Required|已被拦截/i;

/* ---------------- 页面状态 ---------------- */

export async function pageState(page) {
  return page
    .evaluate(`(() => {
      const title = document.title || '';
      const text = (document.body ? document.body.innerText : '').slice(0, 800);
      return { title, text, url: location.href };
    })()`)
    .catch(() => ({ title: '', text: '', url: '' }));
}

/** 被 WAF 硬拦截（IP/规则拦截，点不出来，只能换出口 IP） */
export async function isHardBlocked(page) {
  const s = await pageState(page);
  return BLOCKED_TEXT.test(`${s.title} ${s.text}`);
}

/* ---------------- DOM 工具 ---------------- */

function nodeAttrs(node) {
  const a = node.attributes || [];
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}

/** 深度遍历（穿透 shadow root / contentDocument） */
function walkTree(root, visit) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (visit(n) === false) return;
    for (const c of n.children || []) stack.push(c);
    for (const c of n.shadowRoots || []) stack.push(c);
    if (n.contentDocument) stack.push(n.contentDocument);
  }
}

/** 找出页面内所有 Cloudflare 挑战 iframe（含 shadow DOM 中的） */
async function findCfFrames(page) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const ids = [];
  walkTree(root, (n) => {
    if (n.nodeName !== 'IFRAME') return;
    const { src } = nodeAttrs(n);
    if (src && src.includes(CF_HOST)) ids.push(n.nodeId);
  });
  return ids;
}

function boxOf(model) {
  const q = model.border;
  const x0 = Math.min(q[0], q[2], q[4], q[6]);
  const y0 = Math.min(q[1], q[3], q[5], q[7]);
  const x1 = Math.max(q[0], q[2], q[4], q[6]);
  const y1 = Math.max(q[1], q[3], q[5], q[7]);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function humanClick(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await delay(120 + Math.floor(Math.random() * 180));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await delay(60 + Math.floor(Math.random() * 80));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** 读 Turnstile token */
export async function readTurnstileToken(page) {
  return page
    .evaluate(`(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      if (el && el.value) return el.value;
      try { if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
        const t = window.turnstile.getResponse(); if (t) return t;
      } } catch (e) {}
      return null;
    })()`)
    .catch(() => null);
}

/** 页面上是否存在 Turnstile 组件（新版 SPA 不一定有 name=cf-turnstile-response 的 input，所以也看 iframe） */
export async function hasTurnstileWidget(page) {
  const byInput = await page
    .evaluate(`!!document.querySelector('[name="cf-turnstile-response"]')`)
    .catch(() => false);
  if (byInput) return true;
  const frames = await findCfFrames(page).catch(() => []);
  return frames.length > 0;
}

/* ---------------- 核心：点击复选框 ---------------- */

async function clickTurnstileBoxes(page, log) {
  const ids = await findCfFrames(page);
  if (!ids.length) return false;

  let clicked = false;
  for (const nodeId of ids) {
    let box;
    try {
      const m = await page.send('DOM.getBoxModel', { nodeId });
      box = boxOf(m.model);
    } catch {
      continue;
    }
    if (box.w < 40 || box.h < 20) continue; // 隐藏的检测帧

    // 标准组件 300x65：复选框在左上约 (22, h/2)
    // 全屏 interstitial：点在偏中位置
    const isWidget = box.w <= 420 && box.h <= 140;
    const x = Math.round(isWidget ? box.x + 22 : box.x + box.w / 2);
    const y = Math.round(isWidget ? box.y + box.h / 2 : box.y + box.h / 2);

    await humanClick(page, x, y);
    log('debug', `点击挑战框 @(${x},${y}) 尺寸 ${Math.round(box.w)}x${Math.round(box.h)}`);
    clicked = true;
    await delay(500);
  }
  return clicked;
}

/* ---------------- 主流程 ---------------- */

/**
 * 等待 Turnstile 通过（或判断无法通过）。
 * @returns {Promise<{passed:boolean, blocked:boolean, reason:string}>}
 */
export async function solveTurnstile(page, { timeout = 45000, log = defaultLog, wantToken = false } = {}) {
  const deadline = Date.now() + timeout;
  let round = 0;
  let lastReason = '';

  while (Date.now() < deadline) {
    if (await isHardBlocked(page)) {
      return { passed: false, blocked: true, reason: 'IP 被 Cloudflare WAF 硬拦截' };
    }

    const token = await readTurnstileToken(page);
    if (token) return { passed: true, blocked: false, reason: '已取得 token' };
    if (!wantToken && !(await hasTurnstileWidget(page)) && !(await hasChallengeFrame(page))) {
      return { passed: true, blocked: false, reason: '页面无挑战' };
    }

    round += 1;
    const clicked = await clickTurnstileBoxes(page, log);
    if (!clicked) {
      lastReason = '未找到可见的挑战框';
      await delay(1200);
      continue;
    }

    // 等结果
    const waitUntil = Math.min(deadline, Date.now() + 9000);
    while (Date.now() < waitUntil) {
      await delay(900);
      if (await readTurnstileToken(page)) return { passed: true, blocked: false, reason: '验证通过' };
      const s = await pageState(page);
      if (/验证失败|Verification failed|故障排除|Troubleshoot/i.test(s.text)) {
        lastReason = 'Cloudflare 判定验证失败（浏览器指纹不被信任）';
        break;
      }
    }
    log('debug', `第 ${round} 轮未通过：${lastReason || '继续重试'}`);
    if (round >= 4) break;
  }

  return { passed: false, blocked: false, reason: lastReason || '等待 Turnstile 超时' };
}

async function hasChallengeFrame(page) {
  try {
    const ids = await findCfFrames(page);
    return ids.length > 0;
  } catch {
    return false;
  }
}

/** 打开页面并过盾 */
export async function gotoWithShield(page, url, { timeout = 60000, log = defaultLog } = {}) {
  await page.navigate(url, { timeout });
  await delay(1500);

  if (await isHardBlocked(page)) {
    return { passed: false, blocked: true, reason: 'IP 被 Cloudflare WAF 硬拦截' };
  }
  // 页面本身不是挑战页就直接返回
  const s = await pageState(page);
  if (!CHALLENGE_TEXT.test(`${s.title} ${s.text}`) && !(await hasChallengeFrame(page))) {
    return { passed: true, blocked: false, reason: '直接通过' };
  }
  return solveTurnstile(page, { timeout, log });
}

/**
 * 自己渲染一个 Turnstile 组件来取 token。
 *
 * 场景：站点开了 `turnstile_check`，签到接口要 `?turnstile=<token>`，
 * 但登录页上的盾组件在**已登录**时会跳走（拿不到），或者压根没渲染。
 * sitekey 是公开的（/api/status 里的 turnstile_site_key），
 * 所以直接在本站页面上用 explicit 模式渲染一个隐形组件即可。
 */
export async function renderTurnstileToken(page, siteKey, { timeout = 45000, log = defaultLog } = {}) {
  if (!siteKey) throw new Error('缺少 turnstile_site_key');

  const loaded = await page
    .evaluate(`new Promise((resolve) => {
      if (window.turnstile && typeof window.turnstile.render === 'function') return resolve(true);
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    })`)
    .catch(() => false);
  if (!loaded) throw new Error('Turnstile 脚本加载失败');

  await page
    .evaluate(`(() => {
      let box = document.getElementById('__ts_auto');
      if (!box) {
        box = document.createElement('div');
        box.id = '__ts_auto';
        box.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:70px';
        document.body.appendChild(box);
      }
      window.__tsToken = null;
      window.__tsErr = null;
      try {
        window.turnstile.render('#__ts_auto', {
          sitekey: ${JSON.stringify(siteKey)},
          callback: (t) => { window.__tsToken = t; },
          'error-callback': (e) => { window.__tsErr = String(e || 'error'); },
        });
      } catch (e) {
        window.__tsErr = 'render:' + e.message;
      }
      return true;
    })()`)
    .catch(() => {});

  const deadline = Date.now() + timeout;
  let round = 0;
  while (Date.now() < deadline) {
    await delay(1200);
    const r = await page
      .evaluate(`({ token: window.__tsToken || null, err: window.__tsErr || null })`)
      .catch(() => ({ token: null, err: null }));
    if (r.token) {
      log('debug', `自渲染 Turnstile 已取到 token（${String(r.token).slice(0, 12)}…）`);
      return r.token;
    }
    if (r.err) throw new Error(`Turnstile 渲染报错：${r.err}`);
    // 需要交互时点一下复选框
    round += 1;
    if (round % 3 === 0) await solveTurnstile(page, { timeout: 15000, wantToken: false, log }).catch(() => null);
  }
  throw new Error('Turnstile 超时：没拿到 token');
}
