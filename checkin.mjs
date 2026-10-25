#!/usr/bin/env node
/**
 * 多站点自动签到工具
 *
 *   node checkin.mjs run                     # 全部站点签到
 *   node checkin.mjs run --site windhub      # 指定站点
 *   node checkin.mjs login --site fuli       # 手动登录并保存凭据
 *   node checkin.mjs status                  # 查看上次结果
 *   node checkin.mjs doctor                  # 环境与站点体检
 */
import { log, pad, R, DEFAULT_UA } from './src/util.mjs';
import { loadConfig, pickSites, findSite, loadCreds, getCred, loadState, recordResult, saveCred } from './src/sites.mjs';
import { findBrowser } from './src/cdp.mjs';
import { runSites, loginSite, notifyWebhook } from './src/runner.mjs';

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const args = { _: [], sites: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site' || a === '-s') args.sites.push(argv[++i]);
    else if (a.startsWith('--site=')) args.sites.push(a.slice(7));
    else if (a.startsWith('--')) args.flags.add(a.slice(2));
    else args._.push(a);
  }
  return args;
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args._[0] || 'run';

/* ---------------- 公共 ---------------- */

async function notify(cfg, summary) {
  await notifyWebhook(cfg, summary, log);
}

/* ---------------- run ---------------- */

async function cmdRun() {
  const cfg = loadConfig();
  const headless = args.flags.has('headless') ? true : undefined;
  if (args.flags.has('visible')) cfg.settings.headless = false;

  let results;
  try {
    results = await runSites(cfg, args.sites, { log, headless });
  } catch (e) {
    log('err', e.message);
    return 1;
  }

  for (const r of results) recordResult(r.id, { state: r.state, message: r.message });
  printSummary(results);
  await notify(cfg, results);

  const bad = results.filter((r) => r.state !== R.OK && r.state !== R.ALREADY);
  return bad.length ? 1 : 0;
}

function printSummary(results) {
  console.log('');
  console.log('─'.repeat(64));
  for (const r of results) {
    const mark =
      r.state === R.OK ? '\x1b[32m✔ 成功\x1b[0m' : r.state === R.ALREADY ? '\x1b[36m↻ 已签\x1b[0m' : '\x1b[31m✘ 失败\x1b[0m';
    console.log(`${mark}  ${pad(r.name, 26)} ${r.message}  \x1b[90m${(r.ms / 1000).toFixed(1)}s\x1b[0m`);
  }
  console.log('─'.repeat(64));
  const ok = results.filter((r) => r.state === R.OK || r.state === R.ALREADY).length;
  console.log(`共 ${results.length} 个站点，成功 ${ok} 个，失败 ${results.length - ok} 个`);
  console.log('');
}

/* ---------------- login ---------------- */

async function cmdLogin() {
  const cfg = loadConfig();
  if (!args.sites.length) {
    log('err', '请用 --site <id> 指定要登录的站点，例如：node checkin.mjs login --site fuli');
    return 1;
  }
  for (const id of args.sites) {
    const site = findSite(cfg, id);
    if (!site) {
      log('err', `找不到站点: ${id}`);
      continue;
    }
    log('info', `—— 登录 ${site.name}`);
    try {
      const creds = await loginSite(cfg, site, { log });
      saveCred(site.id, creds);
      log('ok', `凭据已保存到 data/creds.json（token=${creds.token ? '有' : '无'} cookie=${creds.cookie ? '有' : '无'}）`);
    } catch (e) {
      log('err', e.message);
    }
  }
  return 0;
}

/* ---------------- status ---------------- */

function cmdStatus() {
  const cfg = loadConfig();
  const st = loadState();
  const creds = loadCreds();

  console.log('');
  console.log(pad('站点', 26) + pad('上次结果', 14) + pad('时间', 20) + '凭据');
  console.log('─'.repeat(78));
  for (const s of cfg.sites) {
    const r = st[s.id];
    const c = creds[s.id];
    const stateTxt = !r ? '从未运行' : r.state === R.OK ? '成功' : r.state === R.ALREADY ? '已签到' : '失败';
    const at = r?.at ? new Date(r.at).toLocaleString('zh-CN', { hour12: false }) : '-';
    const credTxt = c ? `${c.token ? 'token' : ''}${c.token && c.cookie ? '+' : ''}${c.cookie ? 'cookie' : ''}` : '无';
    console.log(pad(s.name, 26) + pad(stateTxt, 14) + pad(at, 20) + credTxt);
    if (r?.message) console.log(`  \x1b[90m↳ ${r.message}\x1b[0m`);
  }
  console.log('');
  return 0;
}

/* ---------------- doctor ---------------- */

async function cmdDoctor() {
  console.log('');
  log('info', `Node ${process.version}`);
  try {
    log('ok', `浏览器: ${findBrowser()}`);
  } catch (e) {
    log('err', e.message);
  }

  const cfg = loadConfig();
  const ld = cfg.linuxdo || {};
  log('info', `LinuxDO 账号: ${ld.username ? ld.username + '（已配置）' : '未配置（福利站需手动登录）'}`);
  if (process.env.CHECKIN_LINUXDO_PASS) log('debug', '密码来自环境变量 CHECKIN_LINUXDO_PASS');

  for (const site of cfg.sites) {
    const line = [`\n—— ${site.name}  (${site.url})`];
    try {
      const r = await fetch(`${site.url}/api/status`, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const t = await r.text();
      let j = null;
      try {
        j = JSON.parse(t);
      } catch {
        /* ignore */
      }
      line.push(`  HTTP ${r.status}${j?.data?.checkin_enabled !== undefined ? `  签到开关=${j.data.checkin_enabled}` : ''}${j?.data?.turnstile_check !== undefined ? `  Turnstile=${j.data.turnstile_check}` : ''}`);
      if (r.status === 403) line.push('  ⚠ 被 WAF 拦截（可能需要换出口 IP）');
    } catch (e) {
      line.push(`  请求失败: ${e.message}`);
    }
    const c = getCred(site.id);
    line.push(`  凭据: ${c ? `已保存（${new Date(c.updatedAt).toLocaleString('zh-CN', { hour12: false })}）` : '未保存'}`);
    line.push(`  账号: ${site.username ? site.username : site.auth === 'password' ? '未配置' : 'OAuth'}`);
    console.log(line.join('\n'));
  }
  console.log('');
  return 0;
}

/* ---------------- main ---------------- */

(async () => {
  let code = 0;
  try {
    if (cmd === 'run') code = await cmdRun();
    else if (cmd === 'login') code = await cmdLogin();
    else if (cmd === 'status') code = cmdStatus();
    else if (cmd === 'doctor') code = await cmdDoctor();
    else {
      console.log('用法: node checkin.mjs <run|login|status|doctor> [--site id] [--headless] [--visible]');
      code = 1;
    }
  } catch (e) {
    log('err', e.stack || e.message);
    code = 1;
  }
  process.exit(code);
})();
