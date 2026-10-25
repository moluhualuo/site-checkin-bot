/**
 * hCaptcha 过验证模块
 *
 * 场景：linux.do（Discourse）登录时会弹出「人机验证」对话框，里面是 hCaptcha。
 * 该组件是标准 hCaptcha checkbox widget，点一下多数情况下直接放行；
 * 少数情况会升级成图片挑战，那种没法自动完成，只能把窗口交给人。
 *
 * 与 Turnstile 一样，iframe 可能藏在 shadow DOM 里，
 * 所以定位走 DOM.getDocument({pierce:true}) + DOM.getBoxModel + 坐标点击。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { log as defaultLog } from './util.mjs';

const HC_HOST = 'hcaptcha.com';

function nodeAttrs(node) {
  const a = node.attributes || [];
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}

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
  await delay(140 + Math.floor(Math.random() * 200));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await delay(70 + Math.floor(Math.random() * 90));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** 找出页面内所有 hCaptcha iframe（含 shadow DOM 中的） */
export async function findHcaptchaFrames(page) {
  try {
    const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
    const out = [];
    walkTree(root, (n) => {
      if (n.nodeName !== 'IFRAME') return;
      const { src } = nodeAttrs(n);
      if (src && src.includes(HC_HOST)) out.push({ nodeId: n.nodeId, src });
    });
    return out;
  } catch {
    return [];
  }
}

/** 读 hCaptcha token（插件可能把 token 写进 textarea，也可能只在内存里） */
export async function readHcaptchaToken(page) {
  return page
    .evaluate(`(() => {
      const el = document.querySelector('[name="h-captcha-response"], textarea[name*="captcha-response"]');
      if (el && el.value) return el.value;
      try {
        if (window.hcaptcha && typeof window.hcaptcha.getResponse === 'function') {
          const t = window.hcaptcha.getResponse();
          if (t) return t;
        }
      } catch (e) {}
      return null;
    })()`)
    .catch(() => null);
}

/**
 * 取所有 hCaptcha iframe 的位置。
 * 先用 JS 查（普通 iframe 够用且便宜），再退回 DOM.pierce（shadow DOM 里的）。
 */
export async function hcaptchaBoxes(page) {
  const js = await page
    .evaluate(`(() => [...document.querySelectorAll('iframe')]
      .filter(f => /hcaptcha/i.test(f.src || ''))
      .map(f => { const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, src: f.src }; }))()`)
    .catch(() => []);
  if (Array.isArray(js) && js.length) return js;

  const out = [];
  for (const f of await findHcaptchaFrames(page)) {
    try {
      out.push({ ...boxOf((await page.send('DOM.getBoxModel', { nodeId: f.nodeId })).model), src: f.src });
    } catch {
      /* 节点已失效 */
    }
  }
  return out;
}

/**
 * 页面上是否真的弹出了「人机验证」。
 * 注意：Discourse 登录页 DOM 里可能常驻一个隐藏的 .h-captcha 容器，
 * 所以不能只看元素存在，必须判断「可见」。
 */
export async function hasCaptchaDialog(page) {
  const boxes = await hcaptchaBoxes(page);
  if (boxes.some((b) => b.w > 40 && b.h > 20)) return true;

  return page
    .evaluate(`(() => {
      const titles = [...document.querySelectorAll('.modal-title, .d-modal__title, .modal-body h2, .modal-body h3, .modal-body .title')];
      return titles.some(e => e.offsetParent !== null && /人机验证|hCaptcha|verify/i.test(e.innerText || ''));
    })()`)
    .catch(() => false);
}

/** 点弹窗里的「验证」按钮 */
export async function clickVerifyButton(page) {
  return page
    .evaluate(`(() => {
      const els = [...document.querySelectorAll('button, .btn, [role="button"]')];
      for (const el of els) {
        if (el.offsetParent === null || el.disabled) continue;
        const txt = (el.innerText || el.value || '').trim();
        if (/^(验证|确认|继续|Verify|Submit)$/i.test(txt)) {
          el.click();
          return txt;
        }
      }
      return null;
    })()`)
    .catch(() => null);
}

/**
 * 尝试通过 hCaptcha。
 * @returns {Promise<{passed:boolean, needManual:boolean, reason:string}>}
 */
export async function solveHcaptcha(page, { timeout = 30000, log = defaultLog } = {}) {
  const deadline = Date.now() + timeout;
  let round = 0;

  while (Date.now() < deadline) {
    if (await readHcaptchaToken(page)) {
      return { passed: true, needManual: false, reason: '已取得 token' };
    }

    const boxes = (await hcaptchaBoxes(page)).filter((b) => b.w > 40 && b.h > 20);

    // 图片挑战帧（尺寸明显大于标准 300x70 的复选框组件）→ 自动解不了
    if (boxes.some((b) => /\/challenge/i.test(b.src || '') || b.w > 460 || b.h > 180)) {
      return { passed: false, needManual: true, reason: 'hCaptcha 出现图片挑战' };
    }
    if (!boxes.length) {
      await delay(800);
      continue;
    }

    round += 1;
    for (const b of boxes) {
      // 标准 checkbox widget：复选框在左侧偏上
      const x = Math.round(b.x + 26);
      const y = Math.round(b.y + Math.min(34, b.h / 2));
      await humanClick(page, x, y);
      log('debug', `点击 hCaptcha 复选框 @(${x},${y}) 尺寸 ${Math.round(b.w)}x${Math.round(b.h)}`);
      await delay(600);
    }

    // 等 token
    const waitUntil = Math.min(deadline, Date.now() + 10000);
    while (Date.now() < waitUntil) {
      await delay(800);
      if (await readHcaptchaToken(page)) {
        return { passed: true, needManual: false, reason: '验证通过' };
      }
      const now = await hcaptchaBoxes(page);
      if (now.some((b) => /\/challenge/i.test(b.src || '') || b.w > 460 || b.h > 180)) {
        return { passed: false, needManual: true, reason: 'hCaptcha 出现图片挑战' };
      }
    }
    log('debug', `第 ${round} 轮 hCaptcha 未通过，重试`);
    if (round >= 3) break;
  }

  return { passed: false, needManual: false, reason: 'hCaptcha 验证超时' };
}

/**
 * 把浏览器窗口移到屏幕内并置前，方便人工接手。
 * 屏幕外运行的窗口人是看不见的。
 */
export async function bringToFront(page) {
  try {
    const { windowId } = await page.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await page.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 80, top: 60, width: 1240, height: 900, windowState: 'normal' },
    });
    await page.send('Page.bringToFront');
    return true;
  } catch {
    return false;
  }
}
