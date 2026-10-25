/**
 * 签到执行器：CLI 与 Web 控制台共用的核心流程。
 *
 * 每个站点的策略是「先轻后重」：
 *   1. 有凭据 → 直接打签到接口（不启浏览器，亚秒级）
 *   2. 适配器抛出 NEED_BROWSER → 才启动 Chrome（过盾/刷新会话）
 */
import { log as defaultLog, R } from './util.mjs';
import { pickSites, getCred, saveCred, profileDir } from './sites.mjs';
import { openPage } from './cdp.mjs';
import * as newapi from './adapters/newapi.mjs';
import * as welfare from './adapters/welfare.mjs';

const ADAPTERS = { newapi, welfare };

export function adapterOf(site) {
  const a = ADAPTERS[site.type];
  if (!a) throw new Error(`未知站点类型: ${site.type}`);
  return a;
}

/** 启动浏览器跑一段逻辑，无论成败都关掉 Chrome */
export async function withBrowser(site, cfg, fn, { forceVisible = false, headless, log = defaultLog } = {}) {
  const useHeadless = headless !== undefined ? headless : cfg.settings?.headless === true;
  const offscreen = !forceVisible;
  let ctx;
  try {
    ctx = await openPage({
      port: site.port || 9300,
      userDataDir: profileDir(site),
      headless: useHeadless,
      offscreen,
      proxy: site.proxy || cfg.settings?.proxy || undefined,
      log,
    });
    return await fn(ctx);
  } finally {
    if (ctx?.cdp) await ctx.cdp.closeBrowser().catch(() => {});
  }
}

/**
 * 跑一批站点。
 * @param {object} cfg   完整配置
 * @param {string[]} ids 站点 id 列表（空=全部启用）
 * @param {object} o
 * @param {Function} [o.onSiteStart] (site) => void
 * @param {Function} [o.onSiteDone]  (result) => void
 */
export async function runSites(cfg, ids = [], { log = defaultLog, onSiteStart, onSiteDone, headless } = {}) {
  const sites = pickSites(cfg, ids);
  if (!sites.length) throw new Error('没有可执行的站点，请检查 config/sites.json');

  const results = [];
  for (const site of sites) {
    const t0 = Date.now();
    log('info', `—— ${site.name} (${site.url})`);
    onSiteStart?.(site);

    const adapter = adapterOf(site);
    const cred = getCred(site.id);
    const ctxArgs = { cred, saveCred, log, linuxdo: cfg.linuxdo };

    // 一次完整尝试：先走 HTTP，需要浏览器时再启 Chrome
    const attempt = async () => {
      try {
        return await adapter.run(site, ctxArgs);
      } catch (e) {
        if (e.code !== 'NEED_BROWSER') throw e;
        log('debug', '需要浏览器，启动中…');
        return await withBrowser(site, cfg, (ctx) => adapter.run(site, { ...ctxArgs, page: ctx.page }), { log, headless });
      }
    };

    let item;
    try {
      let res;
      try {
        res = await attempt();
      } catch (e) {
        throw e;
      }

      // 过盾是概率性的，偶发超时就再给一次机会
      if (res.state === R.FAIL && /Turnstile|过盾|验证超时/i.test(res.message || '')) {
        log('warn', '过盾失败，10 秒后自动重试一次');
        await new Promise((r) => setTimeout(r, 10000));
        res = await attempt();
      }

      item = { id: site.id, name: site.name, state: res.state, message: res.message, ms: Date.now() - t0 };
    } catch (e) {
      item = { id: site.id, name: site.name, state: R.FAIL, message: e.message, ms: Date.now() - t0 };
    }

    results.push(item);
    onSiteDone?.(item);

    if (item.state === R.OK) log('ok', item.message);
    else if (item.state === R.ALREADY) log('info', item.message);
    else log('err', item.message);
  }

  return results;
}

/** 登录单个站点并保存凭据（new-api 自动登录；福利站优先 LinuxDO 自动授权，失败转人工） */
export async function loginSite(cfg, site, { log = defaultLog } = {}) {
  return withBrowser(
    site,
    cfg,
    async (ctx) => {
      if (site.type === 'newapi') {
        return newapi.loginBrowser(site, ctx.page, { log });
      }
      if (cfg.linuxdo?.username && cfg.linuxdo?.password) {
        try {
          return await welfare.loginAuto(site, ctx.page, { linuxdo: cfg.linuxdo, log });
        } catch (e) {
          log('warn', `自动登录失败：${e.message}，转为人工登录`);
        }
      }
      return welfare.loginInteractive(site, ctx.page, { log });
    },
    { forceVisible: true, log }
  );
}

/** 汇总统计，供界面显示 */
export function summarize(results) {
  const ok = results.filter((r) => r.state === R.OK).length;
  const already = results.filter((r) => r.state === R.ALREADY).length;
  const fail = results.length - ok - already;
  return { total: results.length, ok, already, fail };
}

/** 结果推送到 webhook（可选，settings.notify.webhook 为空时跳过） */
export async function notifyWebhook(cfg, results, log = defaultLog) {
  const url = cfg.settings?.notify?.webhook;
  if (!url) return false;
  const text = results
    .map((r) => `${r.state === R.OK ? '✅' : r.state === R.ALREADY ? '🔁' : '❌'} ${r.name}: ${r.message}`)
    .join('\n');
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '签到结果', content: text, text }),
      signal: AbortSignal.timeout(10000),
    });
    log('debug', '通知已发送');
    return true;
  } catch (e) {
    log('warn', `通知发送失败: ${e.message}`);
    return false;
  }
}
