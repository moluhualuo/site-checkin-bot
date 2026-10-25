# 多站点自动签到工具

针对以下 9 个站点做每日自动签到，内置 Cloudflare Turnstile / WAF 过盾：

| 站点 | 内核 | 登录方式 | 过盾要求 |
|---|---|---|---|
| `https://windhub.cc/` (Ark API) | new-api | 账号密码 | 无 Turnstile，纯 HTTP 即可 |
| `https://api.hcnsec.cn/` (新疆幻城网安) | new-api | 账号密码 | 登录页有 Turnstile，需浏览器过盾 |
| `https://fuli.lucky0625.qzz.io/` (福利站) | 自建 | LinuxDO OAuth | 无 Turnstile，但有 UA 级 WAF |
| `https://api-welfalre.fengwind.com/` (Fengwind 福利站) | 自建 | 主站 SSO | 无 Turnstile，Bearer Token |
| `https://ultrarouter.org/` (Ultra Router 艺の公益站) | new-api（魔改） | LinuxDO OAuth | 无 Turnstile，签到接口是混淆路径 |
| `https://happycoding.xyz/` (HappyCoding) | new-api | LinuxDO OAuth | 无 Turnstile，标准签到接口 |
| `https://freeapi.dgbmc.top/` (DGB 公益站) | new-api | LinuxDO OAuth | 无 Turnstile，标准签到接口 |
| `https://aapi.ssite.site/` (Supra AI) | new-api | LinuxDO OAuth | **开了 Turnstile**，登录和签到都要盾 |
| `https://api.llm.pm/` (南梁 API) | new-api（魔改） | LinuxDO OAuth | 无 Turnstile，标准签到接口 |

零依赖，只用 Node 内置模块（`fetch` / `WebSocket` / `child_process`），不需要 `npm install`。

---

## Web 控制台（推荐）

不想记命令行就用这个，浏览器里点几下就行：

```bash
node server.mjs --open        # 自动打开 http://127.0.0.1:8787
```

Windows 上双击 `web.bat` 也可以。

界面能力：

- **每个站点一张卡片**：状态灯、上次结果与时间、凭据状态、启用开关
- **签到**：单站签到或「全部签到」，进度和过盾过程通过 SSE **实时推送**到日志面板
- **登录**：自动登录；没配 LinuxDO 账号时会弹出可见浏览器让你手动点一下
- **配置**：填账号密码、粘贴 token / cookie、清除凭据
- **设置**：LinuxDO 账号、代理、Webhook 通知、无头开关
- **体检**：一次性检查浏览器、各站连通性和凭据

启动参数：

| 参数 | 说明 |
|---|---|
| `--port 8787` | 端口 |
| `--host 127.0.0.1` | 监听地址，默认只本机可访问 |
| `--open` | 启动后自动打开浏览器 |

> 默认只监听 `127.0.0.1`。改成 `0.0.0.0` 等于把这个能读写凭据的接口暴露给局域网，
> 除非你清楚风险，否则不要改。

---

## 快速开始

### 1. 环境要求

- Node.js **20+**（需要原生 `WebSocket`）
- 本机安装 Chrome 或 Edge（自动探测；也可用环境变量 `CHROME_PATH` 指定）

### 2. 填账号

先把示例配置复制一份（`sites.json` 含明文凭据，已在 .gitignore 里，不会误提交）：

```bash
cp config/sites.example.json config/sites.json
```

然后编辑 `config/sites.json`，把两个 new-api 站点的 `username` / `password` 填上：

```json
{
  "id": "windhub",
  "username": "你的账号",
  "password": "你的密码"
}
```

另外两个福利站是 OAuth 登录，没有密码接口，走第 3 步。

### 3. 福利站登录（二选一）

福利站（fuli / fengwind）只能通过 LinuxDO 授权登录。

**方式 A：配 LinuxDO 账号，全自动**

在 `config/sites.json` 填：

```json
"linuxdo": { "username": "你的 LinuxDO 用户名", "password": "你的密码" }
```

之后 `node checkin.mjs run` 会自己走完：打开站点 → 跳 linux.do → 填表登录 → 授权 → 回跳 → 拿会话 → 签到。
会话过期时也会自动重新登录。

> ⚠ **linux.do 登录有人机验证（hCaptcha），而且经常是拼图挑战。**
> 工具会自动填好账号密码、自动点复选框；一旦弹出拼图，会把浏览器窗口弹到屏幕前面等你接手，
> 解完自动继续（最多等 2 分钟）。所以第一次仍然需要你手动解一次拼图。
> 之后 cookie 存在浏览器 profile 里，大约 30 天不用再登录。

> 不想把密码写进文件，可以用环境变量（优先级更高）：
> `set CHECKIN_LINUXDO_USER=xxx` 和 `set CHECKIN_LINUXDO_PASS=xxx`

**方式 A+：给 linux.do 的会话 Cookie（跳过登录和拼图）**

在控制台「设置」里填 linux.do 的 Cookie，格式：

```
_t=xxxxx; _forum_session=yyyyy
```

工具会把它注入浏览器，直接以已登录状态走 OAuth 授权，不触发账号密码和 hCaptcha。

> 两个值都是 httpOnly，在 DevTools → Application → Cookies → `https://linux.do` 里能看到。
> **必须原样粘贴，不要 URL 解码**——值里的 `%2B` / `%2F` / `%3D` 就是浏览器实际发送的内容。
> **两个都要给**：实测只给 `_t`（哪怕它是登录态的值）时，OAuth 跳转仍然经常判为未登录，
> `_forum_session` 必须一起带上才能稳定通过。

**方式 B：手动点一次**

```bash
node checkin.mjs login --site fuli
```

弹出一个**可见**的 Chrome 窗口，账号密码已自动填好，你只需要完成人机验证并点登录。
工具检测到登录成功后**自动保存凭据并关闭浏览器**。之后靠持久化 profile 维持，
过期了再点一次。

> new-api 两个站点不需要这一步，`run` 时会自动登录。

**已经有 token 的话，也可以直接写进 `data/creds.json`：**

| 站点 | 字段 | 说明 |
|---|---|---|
| `hcnsec` | `token` | new-api 的「访问令牌」（设置页生成，长期有效，不会过期） |
| `windhub` | `token` + `userId` | 访问令牌 + 用户 ID（新版 new-api 要求 `New-Api-User` 头） |
| `fuli` | `cookie` | `welfare_session=<JWT>`，JWT 有效期 30 天 |
| `fengwind` | `token` | `localStorage.welfare_token` |
| `ultrarouter` | 无需手动填 | 全自动：LinuxDO OAuth 登录 → refresh 换 token → 签到，token 15 分钟自动重取 |
| `happycoding` | 无需手动填 | 全自动：优先复用浏览器会话，失效才走 LinuxDO OAuth；签到纯 HTTP |
| `dgb` | 无需手动填 | 同上，new-api rc.46，`/sign-in` 登录页，签到纯 HTTP |
| `aapi` | 无需手动填 | 同上，但开了 Turnstile：登录要点盾，签到要 `?turnstile=<token>` |
| `llmpm` | 无需手动填 | 同上，魔改分支（版本号 `bbb-*`），标准签到接口 |

```json
{
  "hcnsec": { "token": "你的访问令牌" },
  "windhub": { "token": "你的访问令牌", "userId": 7326 },
  "fuli": { "cookie": "welfare_session=eyJhbGciOi..." }
}
```

> fuli 的 Cookie 名是 **`welfare_session`**，不是 `token` / `session` 这类常见名。
> 只传 `Authorization: Bearer` 会被完全忽略（返回「未登录」），必须走 Cookie。

### 4. 跑一次

```bash
node checkin.mjs run              # 全部站点
node checkin.mjs run --site hcnsec
```

输出示例：

```
—— Ark API (https://windhub.cc)
✔ 签到成功
────────────────────────────────────────────────────────────────
✔ 成功  Ark API                    签到成功  2.3s
↻ 已签  新疆幻城网安                今日已签到  18.4s
✘ 失败  福利站 · 今天也要 lucky 一点  登录已过期，请执行 login 手动登录一次  3.7s
────────────────────────────────────────────────────────────────
共 3 个站点，成功 2 个，失败 1 个
```

### 5. 设置每天自动跑

```powershell
.\install-task.ps1
```

注册 Windows 计划任务，每天 08:10 执行 `run.bat`。

---

## 命令

| 命令 | 说明 |
|---|---|
| `node checkin.mjs run [--site id]` | 执行签到 |
| `node checkin.mjs login --site id` | 打开可见浏览器手动登录并保存凭据 |
| `node checkin.mjs status` | 查看各站上次结果与凭据状态 |
| `node checkin.mjs doctor` | 体检：Node/浏览器、站点连通性、签到开关、Turnstile 状态 |

可选参数：

- `--headless` 强制无头（**只对没有 Turnstile 的站点有效**，见下文）
- `--visible` 让浏览器窗口显示出来（调试用，默认移到屏幕外）

---

## 过盾实现（重要）

这个工具的核心难点是 Cloudflare。以下是本机实测结论，和网上常见的说法不太一样：

### 1. 无头模式过不了 Turnstile

`--headless=new` + UA 伪装 + `navigator.webdriver` 抹除 + `--disable-blink-features=AutomationControlled`，
全部照做之后，点击 Turnstile 复选框仍然稳定返回 **「验证失败」**：

```
点一下复选框 → 变成「验证失败 / 故障排除」
```

同样的代码换成**有头浏览器**，1 秒内就拿到 token：

```
1.ww6bvyZNXVWAibfF2cTHNMeCmm7R...
```

所以默认配置是 `headless: false` + `--window-position=-2400,-2400`：
**真实的有头浏览器，只是窗口被移到屏幕外**。用户看不到，但 Cloudflare 认为它是正常浏览器。

> 这也意味着：必须在**已登录的桌面会话**里运行，不能作为 Windows 服务 / SYSTEM 账户跑。

### 2. Turnstile 复选框在 closed shadow DOM 里

`document.querySelectorAll('iframe')` 和 `querySelectorAll('input[type=checkbox]')` 都抓不到它——
组件挂在 shadow root 下，普通选择器进不去。

正确做法是走 CDP 的 DOM 域：

```
DOM.getDocument { depth: -1, pierce: true }   // 穿透 shadow DOM 拿到完整树
  → 找到 src 含 challenges.cloudflare.com 的 IFRAME 节点
DOM.getBoxModel { nodeId }                     // 拿到它的真实坐标
Input.dispatchMouseEvent                       // 在 (x+22, y+h/2) 真实点击
```

标准组件尺寸是 300×65，复选框中心在左上角约 `(22, h/2)` 的位置。

### 3. WAF 会按 UA 拦截

`fuli` 站直接用 `curl` 默认 UA 访问返回 **403 "Sorry, you have been blocked"**，
换成正常 Chrome UA 立刻 200。所以 HTTP 请求也必须带浏览器 UA（`src/util.mjs` 里的 `DEFAULT_UA`）。

### 4. 识别「硬拦截」

如果页面出现 `Sorry, you have been blocked`，那不是 Turnstile，点不出来，只能换出口 IP。
工具会直接报「IP 被 Cloudflare WAF 硬拦截」而不是傻等。

---

## 各站点实现细节

### LinuxDO 登录自动化

`linux.do` 的登录表单（实测）：

```
#login-account-name      用户名
#login-account-password  密码
#login-button            登录按钮
```

自动化要点：

- **curl 访问 linux.do 会超时，但浏览器能正常打开**。所以登录全程走浏览器上下文，不做 HTTP 登录。
- 登录成功后用 `fetch('/session/current.json')` 判定（Discourse 标准接口），比看页面元素可靠。
- 授权流程是个状态机，最多 24 步，每步处理一种情况：
  0. 在 `connect.linux.do`（LINUX DO Connect 授权页）→ 点「允许」
  1. 停在 `linux.do/login` → 填表登录
  2. 在 linux.do 但不在登录页（如 `/session/sso_provider`）且未登录 → 先登录再重走入口
  3. 站点登录页上有「使用 Linux.do 登录」按钮 → 点它（fengwind 主站就是这种）
  4. OAuth 授权确认页 → 点「授权 / Allow」
  5. 连续两步没有可操作元素 → 退出，交给上层轮询站点会话
- 开了两步验证的账号无法自动登录，会明确报错。

#### 用 Cookie 免登录（推荐，绕过 hCaptcha）

hCaptcha 经常升级成拼图挑战，无法稳定自动化。更省事的做法是直接把浏览器里的会话 cookie 交给工具：

```json
// config/sites.json
"linuxdo": {
  "username": "hualuo",
  "cookie": "_t=xxx; _forum_session=yyy"
}
```

- `_t` 和 `_forum_session` **两个都要给**，只给 `_t` 时 OAuth 跳转经常判为未登录。
- 值是 URL-encoded 的（`%2B` `%2F` `%3D` 等），**原样粘贴，不要解码**。
- 也支持裸值（只有 `_t` 的值）和 `_t=xxx` 单条形式。
- 从浏览器 F12 → Application → Cookies → `https://linux.do` 复制即可。

#### 两个踩过的坑

1. **`onLinuxDo()` 不能写成 `hostname.endsWith('linux.do')`**
   `connect.linux.do` 也是这个后缀，但它是独立的授权站点。用后缀匹配会把授权页当成 linux.do，
   在上面判断「未登录」→ 重新登录 → 无限循环。必须严格 `hostname === 'linux.do'`。

2. **`/session/sso_provider` 不能用 DOM / `current.json` 判断登录态**
   这是纯跳转端点，页面是个空壳（标题「请稍候…」，body 为空）。在它上面判断必然得到「未登录」。
   能停在这里就说明 Discourse 已经认了会话（否则会先 302 到 `/login`），所以直接视为已登录。

3. **授权按钮的 class 是 `btn-pill` 不是 `btn`**
   ```html
   <a href="/oauth2/approve/<token>" class="btn-pill btn-pill-primary">允许</a>
   ```
   用 `a.btn` 选不到，按 `a[href*="/oauth2/approve/"]` 找才稳。

### windhub.cc（Ark API，new-api）

**不需要账号密码**，用站点设置页生成的「访问令牌」即可，纯 HTTP 0.8 秒完成。

接口：
```
GET  /api/user/self      Authorization: Bearer <访问令牌> + New-Api-User: <用户ID>
POST /api/user/checkin   Authorization: Bearer <访问令牌> + New-Api-User: <用户ID>
```

#### `New-Api-User` 这个头是关键

新版 new-api 用访问令牌调 `/api/user/*` 时，**必须同时带上 `New-Api-User: <用户ID>`**，否则报 401。
错误信息能区分三种情况：

| 返回 | 含义 |
|---|---|
| `无权进行此操作，未提供 New-Api-User` | 没带这个头 |
| `无权进行此操作，New-Api-User 格式错误` | 带了但值不是数字 |
| `无权进行此操作，New-Api-User 与登录用户不匹配` | **令牌有效**，只是 ID 填错了 |

最后一条很有用：它说明服务端已经认了令牌，只差正确的 ID。旧版站点（如 `api.hcnsec.cn`）不校验这个头，
带上也无害，所以代码里统一都带。

用户 ID 怎么拿？两种方式：
- 站点控制台的个人设置页 URL / 用户信息里能看到
- 或者让工具自己跑一次 OAuth 登录读 `localStorage.user.id`（见下）

`data/creds.json` 里对应字段：

```json
{ "windhub": { "token": "<访问令牌>", "userId": 7326, "username": "hualuo" } }
```

#### OAuth 备用登录（令牌失效时自动重登）

站点开了 `linuxdo_oauth`，工具会用它兜底。流程是：

```
GET /api/oauth/state?mode=login          → { data: "<state>" }
跳 https://connect.linux.do/oauth2/authorize?client_id=<站点client_id>
     &redirect_uri=<站点>/api/oauth/linuxdo&response_type=code&scope=user&state=<state>
点「允许」 → 回调 /api/oauth/linuxdo?code=...&state=... → 下发 session cookie
```

**坑**：`GET /api/oauth/linuxdo` 直接访问会返回「无效的授权码」——它是回调端点，不是入口。
入口必须自己拼 `connect.linux.do` 的 URL，`client_id` 从 `/api/status` 的 `linuxdo_client_id` 读。

登录页默认只显示 OAuth 按钮，走账号密码需要先点「使用 邮箱或用户名 登录」展开表单（有密码时才走这条路）。

`turnstile_check = false`，所以整个流程不需要过盾。

### api.hcnsec.cn（new-api + Turnstile）

`turnstile_check = true`，sitekey `0x4AAAAAAFIovBqwE9xMkrm_`。

**登录和签到都校验 Turnstile**。签到接口直接调用会返回 `Turnstile token 为空`，所以流程是：

1. 打开 `/login`（全站同一个 sitekey）
2. 点复选框过盾，拿到 token
3. 立刻在页面上下文里 `POST /api/user/checkin?turnstile=<token>`

token 单次有效、约 300 秒过期，所以必须「拿到就立刻用」，不能缓存。

如果配置了账号密码，登录也走同一套：填表 → 勾用户协议 → 过盾 → 点登录 → 取 `localStorage.user.token`。

### fuli.lucky0625.qzz.io（福利站）

只支持 LinuxDO OAuth，没有密码接口，所以**必须手动登录一次**。

鉴权细节（实测）：
- Cookie 名是 **`welfare_session`**，值是 HS256 JWT（payload `{uid, exp, iat}`，30 天有效）
- 用 `Authorization: Bearer <JWT>` 访问会返回「未登录」——服务端完全忽略 Bearer
- `token` / `session` / `auth` 等 31 个常见 Cookie 名全部 401，只有 `welfare_session` 命中

凭据（Cookie）保存在 `data/creds.json`，之后每天用 Cookie 直接打 `POST /api/checkin`。
Cookie 过期时 `run` 会用持久化 profile 里的浏览器会话尝试刷新；
profile 也过期了才需要重新 `login`。

### api-welfalre.fengwind.com（Fengwind 福利站）

主站 SSO 登录，token 存在 `localStorage.welfare_token`，请求头 `Authorization: Bearer <token>`。
签到接口 `POST /api/checkin`（GET 是 404）。

登录链路（实测）：

```
福利站 /api/auth/login-url  →  https://api.fengwind.com/sso/continue?client_id=welfare&...
  →  主站未登录，302 到 /login
  →  点「使用 Linux.do 登录」
  →  connect.linux.do/oauth2/authorize（显示「以 @hualuo 的身份授权」）
  →  点「允许」
  →  api.fengwind.com/api/v1/auth/oauth/linuxdo/callback
  →  福利站 /auth/callback 写入 localStorage.welfare_token
```

**探测登录态必须带 Bearer**：`GET /api/me` 只认 `Authorization: Bearer <token>`，
光带 cookie 会返回 **401**（不是 404）。所以 `probeInPage()` 要先从 `localStorage.welfare_token`
取 token 再发请求，否则登录明明成功了也会被判成「未登录」。

注意：这个站有签到资格门槛（福利等级 L1 / LinuxDO TL2），账号没达标时接口会返回资格不足的提示。

### ultrarouter.org（Ultra Router 艺の公益站，新版 new-api 魔改）

这个站是 new-api 的新版前端（React + TanStack，路由是 `/sign-in` 而不是 `/login`），
而且做了不少魔改，和 windhub / hcnsec 那套差别很大。

**1. 没有 `/api/oauth/state` 这种前端取 state 的接口**

老版流程是「前端取 state → 自己拼 `connect.linux.do/oauth2/authorize`」。
这站的 `POST /api/oauth/state` 才是真实入口（注意是 **POST**，不是 GET；
GET 会返回 `未知的 OAuth 提供商`），state 由服务端生成后直接 302。
所以适配器里改成：拿不到 state 时，**直接点登录页上的「使用 LinuxDO 继续」**，让浏览器自己走。

**2. 反复点按钮会把 OAuth 打成 429**

每次点「使用 LinuxDO 继续」都会 `POST /api/oauth/state`，连点十几次之后该接口返回
**429**，此后连正常授权都进不去，只能等限流窗口过去（实测 3 分钟恢复）。
`authorize()` 里因此加了一条：已经授权过、但还停在登录页时，**绝对不再点按钮**，只等待。

**3. 登录态不在 localStorage 里**

授权成功后 `localStorage` 只有 `i18nextLng` / `status` 这类配置，没有 `user`。
真实机制是：

```
OAuth 回调 → 服务端下发 httpOnly 的 refresh cookie（session cookie）
           → 前端调 POST /api/user/auth/refresh 换 access_token（JWT，15 分钟）
           → token 只存在内存里，所以 localStorage 永远是空的
```

必须主动调 `POST /api/user/auth/refresh` 才拿得到 token，用户 ID 从 JWT 的 `sub` 里取（4341）。

**4. 签到接口是混淆路径**

```
GET  /api/user/daily-9f3k?month=YYYY-MM   查签到记录
POST /api/user/daily-9f3k                 签到
```

`POST /api/user/checkin` 是 **404**（路由不存在），`GET /api/user/checkin` 是 **403**
（那是管理员查全员记录的接口）。签到入口在 `/profile` 页（不是 `/dashboard/*`），
只认 `Authorization: Bearer`，不认 cookie。这个站的签到没有 Turnstile，也不需要看广告。

路径通过 `site.checkinPath` 配置，默认仍是 `/api/user/checkin`。

**5. 会话不能跨浏览器进程**

refresh cookie 是 session cookie，Chrome 一关就没了。
所以这个站**每次跑都会重新走一次 OAuth**（约 60~90 秒），没法像其它站那样纯 HTTP 秒签。
这是它的机制决定的，不是实现问题。

> 后来这条被打破了一半：`happycoding.xyz` 用的是同一套新版前端，但它的 refresh cookie
> **是持久化的**，能跨浏览器进程复用。适配器因此加了一步「先试着复用浏览器里已有的会话」，
> 复用成功就完全跳过 OAuth。详见下一节。

---

### happycoding.xyz（HappyCoding，new-api `v1.0.0-rc.40`）

和 ultrarouter 同一套新版前端（登录页 `/sign-in`、按钮文案「使用 LinuxDO 继续」、
`GET /api/oauth/state` 返回 `未知的 OAuth 提供商`），但有三处不同，而且更省事：

**1. 签到接口是标准的**

```
GET  /api/user/checkin?month=YYYY-MM   查记录（返回 enabled / stats / records）
POST /api/user/checkin                 签到
```

不需要 `checkinPath` 覆盖，也不需要过盾，纯 HTTP 秒签。签到一次 +2500000 额度。

**2. refresh cookie 是持久化的**

ultrarouter 的 refresh cookie 是 session cookie，关浏览器就没了；这站能活过进程重启。
所以它加了一条**会话复用**逻辑：打开站点 → `POST /api/user/auth/refresh` 换 token →
用 token 打一次 `/api/user/self` 验证 → 通了就直接签到，整轮 OAuth 完全跳过。

实测：**有会话 4.8 秒**（含启动浏览器），**会话没了 31 秒**（走完整 OAuth）。

**3. 「等登录按钮」会白等 15 秒**

复用逻辑没做之前，这里有个隐蔽的坑：会话还有效时，`/sign-in` 会自动跳到 `/dashboard`，
页面上**永远不会有 LinuxDO 按钮**，而代码在等那个按钮出现 → 硬等满 15 秒超时。
现在等待条件改成「按钮出现 **或** 已经不在登录页」，并且超时压到 8 秒。

**OAuth 入口**（万一要手工验证）：

```
client_id   I6gvqcYR2FHfSFYIbmrPnq4lUG6VotmC
redirect    https://happycoding.xyz/oauth/linuxdo
用户 ID     2278（linux_do_id 307417，hualuo）
```

门槛是 LinuxDO **TL2**，登录后 `has_password: false`（纯 OAuth 账号）。

---

### freeapi.dgbmc.top（DGB 公益站，new-api `v1.0.0-rc.46`）

和 HappyCoding 几乎一样，**不需要写任何新代码**，加一条配置就能跑：

| 项 | 值 |
|---|---|
| 版本 | `v1.0.0-rc.46`（目前见过最新） |
| 登录页 | `/sign-in`，按钮「使用 LinuxDO 继续」 |
| OAuth | `GET /api/oauth/state` → 400 `Unknown OAuth provider`（同新版，走点按钮模式） |
| client_id | `brvJ43mVybVm6j3k3NYT7gCZJsZYNDCG` |
| 门槛 | LinuxDO **TL1**（比 HappyCoding 低） |
| 签到 | `POST /api/user/checkin` 标准路径，无需过盾 |
| 用户 ID | 8392（hualuo） |

两处差异值得记一下：

1. **返回文案是英文**：`Already checked in today`（HappyCoding 是「今日已签到」），
   `classify()` 靠 `already` 关键字命中，所以照样归为「已签」。
2. **会话同样能复用**：第二次跑直接命中浏览器里的会话，约 0.9 秒；
   会话失效时走完整 OAuth 约 44 秒。

签到奖励是随机的，区间 `min_quota 15000000 ~ max_quota 25555000`（比 HappyCoding 的固定 2500000 高一个量级）。

---

### aapi.ssite.site（Supra AI，new-api `v1.0.0-rc.41` + Turnstile）

同一条新版前端，但**开了 Turnstile**（`turnstile_check: true`，sitekey `0x4AAAAAAFT1bCEwXHlkwc_J`），
所以登录和签到都要过盾。这个站踩了 4 个坑，前 2 个是「点了没反应」类问题，最难查：

**1. 协议没勾选时，点登录按钮完全没反应**

登录页底部有「我已阅读并同意 用户协议」，未勾选时点「使用 LinuxDO 继续」
**既不发请求也不报错**，就是没反应。一开始误判成选择器不对，连点了 23 次才发现。

**2. 勾选后要等一次重渲染才能点**

React 的勾选是异步 setState。同一帧里「勾选 → 点按钮」，点到的还是禁用状态的按钮。
现在 `ensureTermsChecked()` 返回 true 后会等 700ms，并等按钮 `!disabled` 再点。

**3. `POST /api/oauth/state` 也要 Turnstile token**

盾没过时点按钮同样是「没反应」（这次是有请求但服务端拒绝）。
`clickLinuxDoButton()` 里加了：点之前先看页面上有没有盾组件，有就先把盾过了。

**4. 签到要 `?turnstile=<token>`，但登录后拿不到 token**

```
POST /api/user/checkin?turnstile=<token>   ← 只有 query 参数有效
```
试过 body `{turnstile}` / `{turnstile_token}` / 请求头 `X-Turnstile-Token`，全部返回
`Turnstile token 为空`，**只有 query 参数**认。

麻烦的是：登录后访问 `/sign-in` 会跳 dashboard，页面上**没有盾组件**，取不到 token。
解法是 `renderTurnstileToken()`——sitekey 是公开的（`/api/status` 里的 `turnstile_site_key`），
直接在本站页面里用 explicit 模式渲染一个隐形组件自己取：

```js
turnstile.render('#__ts_auto', { sitekey, callback: t => window.__tsToken = t })
```

另外还修了一个**分支漏洞**：`run()` 里走 OAuth 的分支以前直接 `return checkinHttp(...)`，
跳过了「过盾后签到」的兜底，导致「能登录但签不上」。现在统一走 `checkinAfterLogin()`。

耗时：会话复用 + 过盾约 24 秒；从零 OAuth 约 60 秒。

---

### api.llm.pm（南梁 API，魔改 new-api）

版本号是 `bbb-20260825-ef4fab6`（不是官方 `v1.0.0-rc.x`），属于第三方魔改分支，
但接口层和 HappyCoding 那套完全一致，**加一条配置就跑通，没写新代码**：

| 项 | 值 |
|---|---|
| 登录页 | `/sign-in`，按钮「使用 LinuxDO 继续」 |
| OAuth state | `GET /api/oauth/state` → 400 `未知的 OAuth 提供商`（走点按钮模式） |
| client_id | `ya8hCMUpCATo2kufrfFeJW4dizDvXFy0` |
| 门槛 | LinuxDO **TL0**（最低，不设限） |
| 签到 | `POST /api/user/checkin` 标准路径，无 Turnstile |
| 用户 ID | 2752（hualuo） |
| 奖励区间 | min 250000 / max 500000 |

首跑 43 秒（完整 OAuth），之后会话复用 1.4 秒。

---

## 目录结构

```
zdqd/
├── checkin.mjs              # CLI 入口
├── run.bat                  # 计划任务调用的批处理
├── install-task.ps1         # 注册 Windows 计划任务
├── config/sites.json        # 站点配置（账号密码在这里填）
├── src/
│   ├── cdp.mjs              # Chrome 启动器 + CDP 客户端 + UA 伪装
│   ├── turnstile.mjs        # 过盾：盒模型定位 + 坐标点击 + 拦截识别
│   ├── sites.mjs            # 配置/凭据/状态读写
│   ├── util.mjs             # 日志、HTTP、结果分类
│   └── adapters/
│       ├── newapi.mjs       # new-api 系适配器
│       └── welfare.mjs      # 福利站适配器
├── data/                    # 运行时数据（已在 .gitignore）
│   ├── creds.json           # ⚠ 登录凭据，含敏感信息
│   ├── state.json           # 上次签到结果
│   ├── profiles/<站点>/      # 每站点独立 Chrome profile
│   └── logs/YYYY-MM-DD.log  # 运行日志
└── ref-cdp/                 # 参考项目 moluhualuo/headless-chrome-cdp
```

每个站点用**独立的 Chrome profile 和调试端口**（9301–9304）。
这是必须的：共用 profile 会让新窗口跑到已运行的浏览器实例里，CDP 端口就起不来。

---

## 常见问题

**Q：报「未配置账号密码」**
去 `config/sites.json` 填 `username` / `password`。

**Q：报「登录已过期，请执行 login」**
福利站的 Cookie/token 失效了，手动登录一次即可。Cookie 一般能撑 7–30 天。

**Q：报「Turnstile 未通过：Cloudflare 判定验证失败」**
检查是不是被 `--headless` 强制无头了。删掉该参数，或者确认 `config/sites.json` 里
`settings.headless` 是 `false`。

**Q：报「IP 被 Cloudflare WAF 硬拦截」**
当前出口 IP 被拉黑了，换网络/代理，或在 `config/sites.json` 里给该站点加 `"proxy": "http://127.0.0.1:7897"`。

**Q：计划任务跑了但没效果**
计划任务需要**用户已登录桌面**。有头浏览器必须有桌面会话，锁屏可以，注销/关机不行。

**Q：想看详细过程**
`set CHECKIN_DEBUG=1` 再运行，或者看 `data/logs/` 下的日志。

---

## 安全提示

- `data/creds.json` 里是明文账号凭据（token / cookie），别提交到 Git，别随便发给别人。
- `config/sites.json` 里的密码也是明文。介意的话可以用系统环境变量，或把文件权限收紧。
- 本工具只操作你自己的账号，签到行为请遵守各站点规则。
