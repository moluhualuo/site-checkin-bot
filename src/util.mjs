import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bus } from './bus.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const CONFIG_DIR = path.join(ROOT, 'config');

export { delay };

for (const d of [DATA_DIR, PROFILE_DIR, LOG_DIR, CONFIG_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/* ---------------- 日志 ---------------- */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
};

let logFile = null;
function getLogFile() {
  if (logFile) return logFile;
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  logFile = path.join(LOG_DIR, name);
  return logFile;
}

export function writeLog(line) {
  try {
    fs.appendFileSync(getLogFile(), line + '\n', 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

const ICON = {
  info: `${C.blue}·${C.reset}`,
  ok: `${C.green}✔${C.reset}`,
  warn: `${C.yellow}!${C.reset}`,
  err: `${C.red}✘${C.reset}`,
  debug: `${C.dim}·${C.reset}`,
};

export function log(level, msg, scope = '') {
  const ts = new Date().toTimeString().slice(0, 8);
  const tag = scope ? `${C.dim}[${scope}]${C.reset} ` : '';
  const icon = ICON[level] || ICON.info;
  const text = String(msg ?? '');
  const plain = `${ts} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${text}`;
  writeLog(plain);
  bus.emit('log', { ts, level, msg: text, scope });
  if (level === 'debug' && !process.env.CHECKIN_DEBUG) return;
  const color = level === 'err' ? C.red : level === 'warn' ? C.yellow : level === 'ok' ? C.green : '';
  process.stdout.write(`${C.dim}${ts}${C.reset} ${icon} ${tag}${color}${text}${color ? C.reset : ''}\n`);
}

/* ---------------- JSON 读写 ---------------- */

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/* ---------------- HTTP ---------------- */

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * 带超时与 Cookie 支持的 JSON 请求。
 * 返回 { status, headers, body, cookies }
 */
export async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, cookie, timeout = 20000, redirect = 'follow' } = opts;
  const h = { 'User-Agent': DEFAULT_UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers };
  if (cookie) h['Cookie'] = cookie;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new HttpError(`网络请求失败: ${e.message}`, 0, null);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, headers: res.headers, body: json, text, cookies: setCookies };
}

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Set-Cookie 数组 -> Cookie 请求头 */
export function cookieHeader(setCookies) {
  return setCookies
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c && !c.toLowerCase().startsWith('deleted'))
    .join('; ');
}

/** 合并两段 Cookie 头，后者优先 */
export function mergeCookie(base, extra) {
  const map = new Map();
  for (const part of `${base || ''};${extra || ''}`.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    map.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ---------------- 结果分类 ---------------- */

export const R = {
  OK: 'ok',
  ALREADY: 'already',
  AUTH: 'auth',
  BLOCKED: 'blocked',
  FAIL: 'fail',
};

/**
 * 从任意站点的响应里猜签到结果。
 * 兼容 new-api（{success,message}）与福利站（{code,message,data}）。
 */
/**
 * 有的站（如 freeapi.dgbmc.top）后端文案是英文，混在中文界面里很扎眼。
 * 只翻译「整句完全匹配」的已知文案，其它一律原样返回，避免把站点特有的提示改坏。
 */
const MSG_ZH = [
  [/^already\s*checked\s*in\s*today\.?$/i, '今日已签到'],
  [/^check-?in\s*success(ful(ly)?)?\.?$/i, '签到成功'],
  [/^unauthorized.*invalid\s*access\s*token\.?$/i, '凭据失效（access token 无效）'],
  [/^turnstile\s*token\s*(is\s*)?(empty|null)\.?$/i, 'Turnstile token 为空'],
];

export function localizeMessage(msg) {
  const s = String(msg || '').trim();
  if (!s) return s;
  for (const [re, zh] of MSG_ZH) if (re.test(s)) return zh;
  return s;
}

export function classify(payload, httpStatus) {
  const msg = localizeMessage(String(payload?.message || payload?.msg || payload?.error?.message || '').trim());
  const code = payload?.code;
  const success = payload?.success === true || code === 0;

  if (httpStatus === 401 || httpStatus === 403 || code === 401 || code === 403) {
    return { state: R.AUTH, message: msg || '未登录/凭据失效' };
  }
  if (/已签到|已经签到|重复签到|already\s*(checked|check)/i.test(msg)) {
    return { state: R.ALREADY, message: msg || '今日已签到' };
  }
  if (success) {
    // 尽量把奖励额度带出来，方便一眼看出签到了多少
    const d = payload?.data;
    let extra = '';
    if (d && typeof d === 'object') {
      for (const k of ['quota_awarded', 'quota', 'amount', 'reward', 'award', 'credits', 'points']) {
        if (d[k] !== undefined && d[k] !== null && d[k] !== 0) {
          extra = `（+${d[k]}）`;
          break;
        }
      }
    }
    const base = msg && !/^(success|ok|操作成功)$/i.test(msg) ? msg : '签到成功';
    return { state: R.OK, message: base + extra };
  }
  if (httpStatus >= 200 && httpStatus < 300 && payload == null) {
    return { state: R.FAIL, message: '返回内容非 JSON' };
  }
  return { state: R.FAIL, message: msg || `签到失败 (HTTP ${httpStatus})` };
}

/* ---------------- 格式化 ---------------- */

const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** 按显示宽度补齐（中文算 2 列），超长自动截断加省略号 */
export function pad(s, n) {
  const chars = [...String(s)];
  let out = '';
  let w = 0;
  for (const ch of chars) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > n) {
      out = out.length ? out.slice(0, -1) + '…' : '…';
      w = n;
      break;
    }
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(Math.max(0, n - w));
}
