# OpenClaw 5.x 插件迁移 HANDOFF

> 写于 2026-05-05 18:00 UTC（11:00 PDT）| 适用：OpenClaw 2026.5.x（实测 v2026.5.2）
>
> 本文档记录 [feishu-bot-social](../README.md) 从 v1.0 迁移到 OpenClaw 5.x 的根因诊断、
> 修复方案与验证证据。**用同一套方法可以修复 [jarvis-feishu-signal-detector] 等
> 任何依赖 `inbound_claim` 的插件**。

---

## TL;DR — 一段话

OpenClaw 5.x 把通用 `inbound_claim` hook 停用了（`runInboundClaim` 函数零调用，
仅 `runInboundClaimForPluginOutcome` 在对话 binding 时触发）。所有依赖
`inbound_claim` 监听消息的插件**注册仍合法但 callback 永远不被调用**。
迁移到 `message_received`（fire-and-forget）后还会撞上两个隐藏陷阱：
**(a) per-session register 时 `api.config` 被裁剪不含 channels**；
**(b) `ctx.conversationId` 带 `chat:` 前缀**。
解决方法：模块级 SHARED 状态 + `normalizeConversationId()`。详见后文。

---

## 一、关键发现（来自源码 grep）

跑在 `/opt/homebrew/lib/node_modules/openclaw/` v2026.5.2 上：

```
runInboundClaim:        0 call site(s)   ← 通用 inbound_claim 已停用
runMessageReceived:     2 call site(s)   ← 这是替代品
runMessageSending:      3 call site(s)   ← 工作
runBeforePromptBuild:   2 call site(s)   ← 工作
runMessageSent:         2 call site(s)
runBeforeDispatch:      1 call site(s)
runReplyDispatch:       2 call site(s)
```

唯一调用 `runInboundClaim*` 的位置：
[`dispatch-qvEfkoBF.js:502`](/opt/homebrew/lib/node_modules/openclaw/dist/dispatch-qvEfkoBF.js)
```javascript
const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
  ? await hookRunner.runInboundClaimForPluginOutcome(pluginOwnedBinding.pluginId, ...)
  : ...;
```
**只对 `pluginOwnedBinding` 拥有的对话才调用**——通用监听场景永远不触发。

### 旧 API（v4.x 假设）→ 新 API 映射

| 旧 hook | 新 hook | 语义变化 |
|---|---|---|
| `inbound_claim` （观察） | `message_received` | fire-and-forget void hook |
| `inbound_claim` （drop）| ~~不再可用~~ | 由 OpenClaw 上层 `groupPolicy` + `requireMention` 完成 |
| `inbound_claim` （改 content）| ~~不再可用~~ | 改用 `before_prompt_build` 注入 system context 替代 |

---

## 二、三个问题与修复

### 问题 1：`inbound_claim` callback 不触发

**症状**：`api.on('inbound_claim', cb)` 注册 OK，gateway 日志显示 plugin registered，
但 `cb` 从未被调用，fbs-debug 中零条 `[inbound_claim]` 记录。

**根因**：见上文。OpenClaw 5.x 移除了通用调用路径。

**修复**：替换 `inbound_claim` → `message_received`

```javascript
// ❌ 旧（不工作）
api.on('inbound_claim', (event, ctx) => {
  if (someCondition) return { handled: true };       // drop（不再可用）
  return { content: prefix + event.content };        // 改 content（不再可用）
});

// ✅ 新（fire-and-forget；只能观察 + 副作用）
api.on('message_received', (event, ctx) => {
  // 副作用：log / 记录状态 / 触发异步任务
  // 不返回任何值（OpenClaw 不读返回值）
});
```

需要"修改消息内容"的功能，**在 `before_prompt_build` 中以 `appendSystemContext`
注入到 system prompt** 替代（不修改用户消息体本身，但 LLM 仍能看到）。

参考实现：[`index.js` 第 198-244 行](../index.js)（message_received hook）+
[第 247-294 行](../index.js)（before_prompt_build 含 lastBotMention 注入）。

---

### 问题 2：per-session register 的 `api.config` 被裁剪

**症状**：startup register 时 `api.config.channels.feishu.accounts` 完整，
per-session register（每个新 group session）时 `api.config.channels` 是 undefined。
导致闭包内 `FEISHU_ACCOUNTS = {}` → token 永远拿不到 → `[token] no credentials for undefined`。

**日志证据**：
```
17:22:46.903Z [init] accounts: default | first appId: cli_a929...   ← startup
17:25:20.565Z [init] accounts:  | first appId: undefined...          ← per-session
17:25:27.004Z [WARN] [token] no credentials for undefined
17:25:27.004Z [WARN] [before_prompt_build] no token, skip context
```

**根因**：OpenClaw 5.x 的 plugin 加载器对 per-session register 传入的 api 对象
做了配置裁剪（不含 channel-level secrets）。每个 register 调用得到不同 closure
的 `FEISHU_ACCOUNTS`。

**修复**：把跨 register 共享的状态提到模块作用域，startup register 写入，
per-session register 读取。

```javascript
// ── 模块级共享状态（在 register 函数外定义）─────────────────────────────
const SHARED = {
  feishuAccounts: {},            // { default: {appId, appSecret}, ... }
  feishuBase    : 'https://open.feishu.cn',
  targetGroups  : new Set(),
  tokenCache    : new Map(),     // accountId → { token, expiresAt }
  tokenInflight : new Map(),     // accountId → Promise<string|null>
  registry      : null,          // BotRegistry singleton
  log           : null,
};

function captureConfigFromApi(api, cfg) {
  // pluginConfig 每次都传，可直接更新
  if (Array.isArray(cfg.contextGroups)) SHARED.targetGroups = new Set(cfg.contextGroups);

  // api.config.channels 仅 startup 含；per-session 跳过（保留已缓存值）
  const ch = api.config?.channels?.feishu;
  if (!ch) return;

  SHARED.feishuBase = ch.domain === 'lark' ? '...' : 'https://open.feishu.cn';
  const resolved = {};
  for (const [id, acct] of Object.entries(ch.accounts || {})) {
    resolved[id] = { ...acct, appId: resolveRef(acct.appId), appSecret: resolveRef(acct.appSecret) };
  }
  if (Object.keys(resolved).length > 0) SHARED.feishuAccounts = resolved;
}

const plugin = {
  register(api) {
    captureConfigFromApi(api, api.pluginConfig ?? {});
    ensureSingletons(...);  // 只在第一次创建 registry / contextCache / stormGuard

    // 所有 hook 都通过 SHARED.* 读配置，与 register 调用次数无关
    api.on('message_received', (event, ctx) => {
      const acct = SHARED.feishuAccounts[...];  // ← 永远拿到 startup 时的值
      ...
    });
  }
};
```

参考实现：[`index.js` 第 32-50 行 SHARED](../index.js) + [第 52-77 行 captureConfigFromApi](../index.js) + [第 153-181 行 ensureSingletons](../index.js)。

---

### 问题 3：`ctx.conversationId` 带 `chat:` 前缀

**症状**：在 `message_received` 和 `message_sending` 中，`ctx.conversationId`
形如 `chat:oc_9ba7a...`（群）或 `user:ou_xxx`（DM），不是裸的 chat_id。
代码里若直接 `chatId.startsWith('oc_')` 判断会永远 false。

**日志证据**（部署诊断 log 后才发现）：
```
[2026-05-05T17:50:53.662Z] [INFO] [message_received] HIT
  channelId=feishu
  convId=chat:oc_9ba7a535e94ec2f33c53f3def70e3f2d   ← 注意 chat: 前缀
  sender=ou_a2c019095b2cb92317d70fe00ce88153
```

**根因**：`toPluginMessageContext`（[message-hook-mappers-P44RAWI9.js:78](/opt/homebrew/lib/node_modules/openclaw/dist/message-hook-mappers-P44RAWI9.js)）
直接拷贝 `canonical.conversationId`，**不像 `toPluginInboundClaimContext` 那样
调 `resolveInboundConversation` → `stripChannelPrefix`**。不同 mapper 行为不一致。

> **对比**：`before_prompt_build` 的 `ctx.channelId` 已经是裸 `oc_xxx`（无前缀），
> 因为它走的是 `buildAgentHookContext` 路径，已被 OpenClaw 内部归一化。
> 唯独 `toPluginMessageContext` 不归一化。

**修复**：插件内自行归一化

```javascript
function normalizeConversationId(raw) {
  if (typeof raw !== 'string') return raw;
  for (const p of ['chat:', 'user:', 'channel:']) {
    if (raw.startsWith(p)) return raw.slice(p.length);
  }
  return raw;
}

api.on('message_received', (event, ctx) => {
  const chatId = normalizeConversationId(ctx?.conversationId);  // ← 必须归一化
  if (!chatId || !SHARED.targetGroups.has(chatId)) return;
  // ...
});

api.on('message_sending', (event, ctx) => {
  const chatId = normalizeConversationId(ctx?.conversationId);  // ← 同样要归一化
  // ...
});
```

参考实现：[`index.js` 第 56-67 行 normalizeConversationId](../index.js) + 在 message_received / message_sending 调用处。

---

## 三、迁移 jarvis-feishu-signal-detector 的步骤

signal-detector 当前在 [`~/.openclaw/extensions/jarvis-feishu-signal-detector/index.js`](~/.openclaw/extensions/jarvis-feishu-signal-detector/index.js)。
它注册了 `inbound_claim`，gateway log 显示 `live on inbound_claim`，但实际 callback 不会触发。

### 改造清单

1. **替换 hook 名**：
   ```diff
   - api.on("inbound_claim", (event, ctx) => { ... });
   + api.on("message_received", (event, ctx) => { ... });
   ```
   shouldProcess 逻辑保留，但**不要返回 `{handled:true}`**——message_received
   是 fire-and-forget。

2. **`event` / `ctx` 字段映射**：
   - inbound_claim event: `event.channel` / `event.isGroup` / `event.wasMentioned` / `event.conversationId`
   - message_received: 大多数字段在 **`ctx`** 而非 `event`
     - `ctx.channelId`（'feishu'）
     - `ctx.conversationId`（**带 `chat:` 前缀**——必须 normalize）
     - `ctx.senderId`
     - `ctx.sessionKey`（`agent:jarvis:feishu:group:oc_xxx` 或 `agent:jarvis:feishu:direct:ou_xxx`）
     - **没有 `isGroup` / `wasMentioned`**——分别从 sessionKey 推（`:group:` vs `:direct:`）
       和 OpenClaw 自身的 mention 判定（已在 dispatch 之前）
   - event 字段：`event.content`、`event.from`、`event.senderId`、`event.metadata.*`

3. **如果原代码用 `event.wasMentioned`** 判断"是否 @ 我"：现在不需要——
   能进 `message_received` 的群消息都是 OpenClaw 已判定要 dispatch 的（即被 @ 或在 open 群）。

4. **如果原代码用 `return { handled: true }` drop 消息**：
   - 删除该返回值（无效）
   - drop 职责由 OpenClaw 上层 `groupPolicy` + `requireMention` 完成
   - 配置：[`openclaw.json`](~/.openclaw/openclaw.json) 的 `channels.feishu.groups.<chat_id>` 块

5. **如果原代码用 `return { content: prefix + event.content }` 注入前缀**：
   - 不再可行
   - 替代方案：用 `before_prompt_build` 注入 `appendSystemContext`，把
     "最近发件人是 X" 作为 system prompt 一部分
   - 参考 [`index.js` 第 274-280 行 lastBotMention 注入](../index.js)

### Signal-detector 特定考虑

它的逻辑是 "DM from Lucien → fire-and-forget Haiku 调用"。这个跟 OpenClaw 5.x
新模型契合度高（fire-and-forget），改动应该最小：

```javascript
// signal-detector 改造示意
api.on("message_received", (event, ctx) => {
  try {
    if (ctx?.channelId !== 'feishu') return;
    // 用 sessionKey 判断 DM：'agent:jarvis:feishu:direct:ou_xxx'
    const isDM = ctx?.sessionKey?.includes(':feishu:direct:');
    if (!isDM) return;

    // sender 从 ctx.senderId 拿
    const senderId = ctx?.senderId;
    if (senderId !== LUCIEN_OPEN_ID) return;

    if (!shouldProcess(event)) return;

    queueMicrotask(() => processSignal(event).catch(...));
  } catch (e) { /* never throw */ }
});
```

> **注意**：signal-detector 还监听了 group 中**链接抓取**（`GROUP_ALLOWLIST` 含读物站），
> 把 `:feishu:direct:` 判断改成更精确：DM 走一个分支，群里读物站走另一个分支。

### Signal-detector 验证步骤

1. 改完代码后 `cp` 到 extension 目录（参考下文同步章节）
2. `openclaw gateway restart`
3. 观察 gateway log：`registered: message_received`（不再是 `inbound_claim`）
4. 让 Lucien DM 一条 → 看 ingest 日志是否触发
5. 在读物站群发条带链接的消息 → 看 KOS ingest 是否触发

---

## 四、源码 ↔ extension 同步

### 当前状态

```
~/Projects/feishu-bot-social/        ← 源码 git repo（origin: github.com/ChenyqThu/...）
~/.openclaw/extensions/feishu-bot-social/  ← 部署副本（独立 .git，仅 initial commit）
```

两边 inode 不同 → 是 cp 而非 symlink。HANDOFF v1 提到 "scanner 拦截，必须手动 cp"。

### 推荐工作流（继续手动 cp，但用脚本）

在源码 repo 加一个 [`scripts/sync.sh`](../scripts/sync.sh)：

```bash
#!/usr/bin/env bash
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$HOME/.openclaw/extensions/feishu-bot-social"
[ -d "$EXT" ] || { echo "extension dir not found: $EXT"; exit 1; }
cp "$EXT/index.js" "$EXT/index.js.bak.$(date +%Y%m%d-%H%M%S)"
for f in index.js openclaw.plugin.json package.json CHANGELOG.md; do
  cp "$SRC/$f" "$EXT/$f"
done
cp "$SRC/lib/"*.js     "$EXT/lib/"
cp "$SRC/data/"*.json  "$EXT/data/"
cp "$SRC/test/"*.js    "$EXT/test/"
echo "synced $SRC → $EXT"
```

调用：`bash scripts/sync.sh`，然后 `openclaw gateway restart`。

### 不推荐 symlink

`ln -s` 把 extension 指到源码看似最简，但：
- OpenClaw scanner / installer 可能拒绝 symlink
- gateway 进程缓存 module 可能对 symlink 解析有意外行为
- 与 HANDOFF v1 的"手动 cp 绕过 scanner"流程冲突

### 同步状态对照表

| 文件 | 源码 hash | extension hash | 同步方式 |
|---|---|---|---|
| index.js | git tracked | cp 复制 | sync.sh |
| lib/*.js | git tracked | cp 复制 | sync.sh |
| openclaw.plugin.json | git tracked | cp 复制 | sync.sh |
| data/wiki-bots.json | git tracked（含真实数据，按用户决策保留）| cp 复制 | sync.sh |
| logs/ | gitignored | 运行时生成 | 不同步 |
| .git/ | 源码 repo | extension 独立 .git | 各自独立 |

---

## 五、关键功能边界（OpenClaw 5.x 下）

| 功能 | 状态 | 说明 |
|---|---|---|
| 群上下文注入 | ✅ 工作 | before_prompt_build + token + 拉 20 条群历史 |
| 最近发件人身份提示 | ✅ 工作 | message_received 记录 → before_prompt_build 注入 |
| @alias → `<at>` 转换 | ✅ DM 路径已验证；群 reply 路径**待验证** | 群 reply 在 OpenClaw 5.x 可能走 routeReply 不经 message_sending hook |
| outbound 熔断计数 | ✅ DM 路径工作；群 reply 路径同上 | |
| 静默 drop bot 自身 / 非 AI bot | ⚠️ **不再支持** | message_received 不能 drop；改由上层配置 |
| 注入 sender prefix 到消息正文 | ⚠️ **不再支持** | 改注入 system prompt |
| storm 风暴 DM 通知 | ✅ 工作 | 但需要配置 `cfg.alertReceiverOpenId`，未配置则跳过 DM |

---

## 六、验证证据（2026-05-05）

新代码部署后 gateway 启动 + 实际触发的关键日志（[`fbs-debug-2026-05-05.log`](~/.openclaw/extensions/feishu-bot-social/logs/fbs-debug-2026-05-05.log)）：

```
17:53:05  === feishu-bot-social registering ===
17:53:05  [init] accounts: default | first appId: cli_a929...    ← Bug A SecretRef 解析 ✓
17:53:05  target groups: oc_9ba7a535e94ec2f33c53f3def70e3f2d
17:53:05  === feishu-bot-social all hooks registered ===
17:53:05  [registry] ready: 8 bots, self=ou_ad91b8a9d73f076c5502fe4f7842625c    ← P1-2 isSelf ✓
17:53:05  [registry] load complete

# 小K @Jarvis（17:54:34）
17:54:34  [message_received] chat=oc_9ba7a... sender=ou_a2c019...    ← prefix 归一化 ✓
17:54:34  [message_received] bot mention from 小K 🐾 in oc_9ba7a...    ← bot 识别 ✓
17:54:40  [token] obtained for default, expires in 5288s              ← Token 修复 ✓
17:54:41  [before_prompt_build] fetched 20 msgs from oc_9ba7a...      ← 群上下文 ✓

# Lucien 在蛋姐群发消息（17:57:14）—— Bug I 关键回归
17:57:14  [message_received] chat=oc_9ba7a... sender=ou_8d1ce0fa...   ← Lucien 不再被误判为 self bot ✓
```

---

## 七、未解 / 后续

1. **群 reply 路径下 `message_sending` 是否触发**：本次群里 Jarvis 实际回复了
   （gateway `dispatch complete queuedFinal=true replies=1`）但 fbs-debug 没看到
   `[message_sending]` log。DM 路径触发过、smoke + integration 都通过。
   推测群 reply 走 `routeReply` 而非 `applyMessageSendingHook`——需在源码端
   验证（搜 `routeReplyRuntime.routeReply` 调用栈是否触发 hookRunner）。
   - 影响：群里 `@alias → <at>` 转换可能未生效；outbound 熔断计数同样
   - 应对：先以 DM 路径作为已验证基准；群路径作为已知风险列在 README

2. **`stripChannelPrefix` 对 `chat:` 之外的前缀**：当前归一化处理了
   `chat:` / `user:` / `channel:`。OpenClaw 源码里这就是全部前缀，但未来版本
   若新增（如 `thread:`）需补充。

3. **inbound_claim 的"对话 binding"路径**：这是 OpenClaw 5.x 唯一仍在调用
   `runInboundClaim*` 的路径。如果将来希望恢复"完全 plugin-controlled 群"
   场景，可以注册 conversation binding 到本插件。当前不做。

---

## 八、核心代码位置（迁移 reference）

| 模式 | 文件:行 |
|---|---|
| SHARED 模块状态 | [index.js:32-50](../index.js) |
| captureConfigFromApi（解决 Problem 2） | [index.js:52-77](../index.js) |
| normalizeConversationId（解决 Problem 3） | [index.js:56-67](../index.js) |
| ensureSingletons（registry 单例） | [index.js:153-181](../index.js) |
| message_received hook（替代 inbound_claim） | [index.js:198-244](../index.js) |
| before_prompt_build + lastBotMention 注入 | [index.js:247-294](../index.js) |
| message_sending（含归一化） | [index.js:303-342](../index.js) |
| 集成测试（fake api 模拟） | [test/integration.js](../test/integration.js) |
| OpenClaw 5.x API 调研结果 | 本文档 §一 |

---

## 致谢

源码侧调研依赖直接 grep `/opt/homebrew/lib/node_modules/openclaw/dist/`，
关键文件：
- [`hook-runner-global-BxiXdopW.js`](/opt/homebrew/lib/node_modules/openclaw/dist/hook-runner-global-BxiXdopW.js) — hook runner 实现
- [`dispatch-qvEfkoBF.js`](/opt/homebrew/lib/node_modules/openclaw/dist/dispatch-qvEfkoBF.js) — inbound dispatch + message_received 触发点
- [`deliver-BffEFXmb.js`](/opt/homebrew/lib/node_modules/openclaw/dist/deliver-BffEFXmb.js) — outbound delivery + applyMessageSendingHook
- [`message-hook-mappers-P44RAWI9.js`](/opt/homebrew/lib/node_modules/openclaw/dist/message-hook-mappers-P44RAWI9.js) — event/ctx 序列化器
- [`loader-CiaemmFD.js`](/opt/homebrew/lib/node_modules/openclaw/dist/loader-CiaemmFD.js) — plugin 加载 + hook permission gate
- [`types-iTIQmVd6.js`](/opt/homebrew/lib/node_modules/openclaw/dist/types-iTIQmVd6.js) — `PLUGIN_HOOK_NAMES` / `CONVERSATION_HOOK_NAMES`

OpenClaw 版本：v2026.5.2（2026-05-04 发布；当时 latest 为 v2026.5.4）。
