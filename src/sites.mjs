import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, PROFILE_DIR, readJson, writeJson } from './util.mjs';

export const CONFIG_FILE = path.join(CONFIG_DIR, 'sites.json');
export const CREDS_FILE = path.join(DATA_DIR, 'creds.json');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_CONFIG = { settings: { headless: false, offscreen: true, timeoutMs: 60000, notify: { webhook: '' } }, sites: [] };

export function loadConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) {
    writeJson(CONFIG_FILE, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  cfg.settings = { ...DEFAULT_CONFIG.settings, ...(cfg.settings || {}) };
  cfg.sites = cfg.sites || [];
  cfg.linuxdo = { username: '', password: '', cookie: '', ...(cfg.linuxdo || {}) };

  // 环境变量优先，避免把 LinuxDO 密码明文写进配置文件
  if (process.env.CHECKIN_LINUXDO_USER) cfg.linuxdo.username = process.env.CHECKIN_LINUXDO_USER;
  if (process.env.CHECKIN_LINUXDO_PASS) cfg.linuxdo.password = process.env.CHECKIN_LINUXDO_PASS;
  if (process.env.CHECKIN_LINUXDO_COOKIE) cfg.linuxdo.cookie = process.env.CHECKIN_LINUXDO_COOKIE;

  return cfg;
}

export function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

export function pickSites(cfg, ids) {
  const list = cfg.sites.filter((s) => s.enabled !== false);
  if (!ids || !ids.length) return list;
  const want = new Set(ids);
  return list.filter((s) => want.has(s.id));
}

export function findSite(cfg, id) {
  return cfg.sites.find((s) => s.id === id);
}

export function profileDir(site) {
  return path.join(PROFILE_DIR, site.id);
}

/* ---------------- 凭据 ---------------- */

export function loadCreds() {
  return readJson(CREDS_FILE, {});
}

export function saveCred(siteId, data) {
  const all = loadCreds();
  all[siteId] = { ...(all[siteId] || {}), ...data, updatedAt: new Date().toISOString() };
  writeJson(CREDS_FILE, all);
  return all[siteId];
}

export function getCred(siteId) {
  return loadCreds()[siteId] || null;
}

/* ---------------- 运行状态 ---------------- */

export function loadState() {
  return readJson(STATE_FILE, {});
}

export function recordResult(siteId, result) {
  const st = loadState();
  st[siteId] = { ...result, at: new Date().toISOString() };
  writeJson(STATE_FILE, st);
  return st;
}

/** 首次运行时把 sites.json 备份一份，避免用户改坏 */
export function ensureWritable() {
  for (const d of [CONFIG_DIR, DATA_DIR, PROFILE_DIR]) fs.mkdirSync(d, { recursive: true });
}
