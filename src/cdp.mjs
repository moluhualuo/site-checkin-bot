/**
 * 极简 Chrome DevTools Protocol 客户端 + 浏览器启动器。
 * 只依赖 Node 内置模块（Node 20+ 自带 WebSocket / fetch）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WIN_BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser() {
  for (const p of WIN_BROWSERS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome / Edge，请设置环境变量 CHROME_PATH 指向浏览器可执行文件');
}

async function getJson(port, p, timeout = 2000) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 判断端口上是否已经有可用的调试浏览器 */
export async function probe(port) {
  try {
    const v = await getJson(port, '/json/version', 1200);
    return { ok: true, version: v.Browser, wsUrl: v.webSocketDebuggerUrl };
  } catch {
    return { ok: false };
  }
}

/**
 * 启动浏览器。
 * @param {object} o
 * @param {number} o.port 调试端口
 * @param {string} o.userDataDir 独立 profile 目录（每个站点一个）
 * @param {boolean} o.headless 是否无头
 * @param {string} [o.proxy] 形如 http://127.0.0.1:7897
 * @param {string} [o.url] 启动后打开的地址
 * @param {boolean} [o.offscreen] 有头模式下把窗口移到屏幕外（用户看不到，但 CF 认为是有头浏览器）
 */
export async function launchBrowser({ port, userDataDir, headless = true, proxy, url, offscreen = true }) {
  const existing = await probe(port);
  if (existing.ok) {
    return { version: existing.version, wsUrl: existing.wsUrl, reused: true };
  }

  const exe = findBrowser();
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    // 关键：抹掉自动化特征，Cloudflare 对 AutomationControlled 很敏感
    '--disable-blink-features=AutomationControlled',
    '--window-size=1366,900',
    '--lang=zh-CN',
    '--no-startup-window-focus',
  ];
  if (headless) args.push('--headless=new');
  else if (offscreen) args.push('--window-position=-2400,-2400');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(url || 'about:blank');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const deadline = Date.now() + 30000;
  let lastErr = '未知错误';
  while (Date.now() < deadline) {
    const p = await probe(port);
    if (p.ok) return { version: p.version, wsUrl: p.wsUrl, reused: false, exe };
    lastErr = '调试端口尚未就绪';
    await delay(250);
  }
  throw new Error(`浏览器启动超时（端口 ${port}）：${lastErr}`);
}

/* ------------------------------------------------------------------ */

export class CDP {
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(wsUrl, timeout = 15000) {
    const c = new CDP(wsUrl);
    await c.#open(timeout);
    return c;
  }

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.closed = false;
  }

  #open(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeout);
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (e) {
        clearTimeout(timer);
        return reject(e);
      }
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      };
      this.ws.onclose = () => {
        this.closed = true;
        for (const { reject: rj } of this.#pending.values()) rj(new Error('CDP 连接已关闭'));
        this.#pending.clear();
      };
      this.ws.onmessage = (ev) => this.#onMessage(ev.data);
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject, timer } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.method;
      const subs = this.#listeners.get(key);
      if (subs) for (const fn of [...subs]) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 已断开'));
    const id = ++this.#seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  waitEvent(method, predicate = () => true, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件超时: ${method}`));
      }, timeout);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  async closeBrowser() {
    try {
      await this.send('Browser.close', {}, undefined, 5000);
    } catch {
      /* ignore */
    }
    this.close();
  }
}

/* ------------------------------------------------------------------ */

const HIDE_AUTOMATION = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
try {
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
} catch (e) {}
try {
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'], configurable: true });
} catch (e) {}
try {
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5], configurable: true });
} catch (e) {}
`;

export function buildUA(browserVersion) {
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(browserVersion || '');
  const major = m ? m[1] : '141';
  const full = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : '141.0.7390.0';
  const ua =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`;
  return { ua, major, full };
}

/** 页面会话：封装一个 page target 的常用操作 */
export class PageSession {
  constructor(cdp, sessionId, targetId, info = {}) {
    this.cdp = cdp;
    this.sid = sessionId;
    this.targetId = targetId;
    this.info = info;
  }

  send(method, params = {}, timeout) {
    return this.cdp.send(method, params, this.sid, timeout);
  }

  async evaluate(expression, { awaitPromise = true, byValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: byValue,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`页面脚本异常: ${d}`);
    }
    return r.result?.value;
  }

  async waitFor(expression, { timeout = 20000, interval = 300, label = '' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {
        /* 页面跳转中，忽略 */
      }
      await delay(interval);
    }
    if (label) throw new Error(`等待超时: ${label}`);
    return false;
  }

  async navigate(url, { timeout = 45000, waitLoad = true } = {}) {
    const loaded = waitLoad ? this.cdp.waitEvent('Page.loadEventFired', () => true, timeout).catch(() => null) : null;
    const res = await this.send('Page.navigate', { url });
    if (res.errorText && res.errorText !== 'net::ERR_ABORTED') {
      throw new Error(`页面打开失败: ${res.errorText} (${url})`);
    }
    if (loaded) await loaded;
    // load 之后给 SPA 一点时间渲染
    await delay(600);
    return res;
  }

  async title() {
    return this.evaluate('document.title');
  }

  async url() {
    return this.evaluate('location.href');
  }

  async bodyText(limit = 4000) {
    return this.evaluate(`document.body ? document.body.innerText.slice(0, ${limit}) : ''`);
  }

  /** React 受控组件必须用原生 setter 赋值才会触发状态更新 */
  async setInput(selector, value) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    return this.evaluate(expr);
  }

  async clickSelector(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
  }

  /** 按可见文本点击（支持 button / a / div[role=button]） */
  async clickByText(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    return this.evaluate(`(() => {
      const want = ${JSON.stringify(list)};
      const cands = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], div, span')];
      for (const w of want) {
        for (const el of cands) {
          const t = (el.innerText || el.value || '').trim();
          if (!t || t.length > 20) continue;
          if (t === w || t.replace(/\\s+/g, '') === w.replace(/\\s+/g, '')) {
            if (el.offsetParent === null) continue;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return w;
          }
        }
      }
      return null;
    })()`);
  }

  async cookies(urls) {
    const r = await this.send('Network.getCookies', urls ? { urls } : {});
    return r.cookies || [];
  }
}

/** 打开浏览器并挂到一个页面 target 上 */
export async function openPage({ port, userDataDir, headless = true, proxy, url, log, offscreen = true }) {
  const { version, wsUrl } = await launchBrowser({ port, userDataDir, headless, proxy, url: 'about:blank', offscreen });
  const cdp = await CDP.connect(wsUrl);

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});

  let targets = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  if (!targets.length) {
    await cdp.send('Target.createTarget', { url: 'about:blank' });
    await delay(400);
    targets = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  }
  const target = targets[0];

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new PageSession(cdp, sessionId, target.targetId, { version });

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable').catch(() => {});

  // UA / 语言 / 平台伪装（用真实内核版本，避免版本号对不上）
  const { ua, major, full } = buildUA(version);
  await page
    .send('Emulation.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'Win32',
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not?A_Brand', version: '24' },
        ],
        fullVersion: full,
        fullVersionList: [
          { brand: 'Chromium', version: full },
          { brand: 'Google Chrome', version: full },
          { brand: 'Not?A_Brand', version: '24.0.0.0' },
        ],
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    })
    .catch(() => {});

  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_AUTOMATION }).catch(() => {});

  if (url) await page.navigate(url);
  log?.('debug', `浏览器已就绪 (${version}, UA Chrome/${major})`);
  return { cdp, page, version };
}
