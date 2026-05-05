# feishu-bot-social Expert Review

> 基于源码实测 2026-05-05 | 所有字段来自 openclaw dist 源码验证

---

## 1. 真实字段（以源码为准）

### inbound_claim event 字段
来源：`message-hook-mappers-P44RAWI9.js` → `toPluginInboundClaimEvent()`

```javascript
event.channel        = canonical.channelId  // 'feishu'（固定值，来自 OriginatingChannel）
event.isGroup        = Boolean(ctx.GroupSubject || ctx.GroupChannel)  // 群聊=true
event.conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From  // 群=chat_id, DM=open_id
event.senderId       = canonical.senderId   // 发送者 open_id（user）或 app_id（bot）
event.wasMentioned   = extras?.wasMentioned // Boolean，来自飞书 is_mention
event.accountId      = canonical.accountId  // 'default'
```

### before_prompt_build ctx 字段
来源：`lifecycle-hook-helpers-COK8hCdE.js` → `buildAgentHookContext()` + `hook-agent-context-BYGZVFo_.js` → `resolveAgentHookChannelId()`

```javascript
ctx.channelId     = parsed from sessionKey  // 群='oc_xxx', DM='ou_xxx', active-memory='oc_xxx:active-memory:xxx'
ctx.agentId       = 'jarvis'
ctx.sessionKey    = 'agent:jarvis:feishu:group:oc_xxx'
ctx.sessionId     = '...'
// isGroup / conversationId 字段不存在！
```

### message_sending ctx 字段
来源：outbound hook context（不同于 inbound）

```javascript
ctx.channelId = 'feishu'  // 固定！不是 oc_xxx，不是 ou_xxx
// 无法从 ctx 区分群聊和 DM
```

---

## 2. Bug 清单

### Bug A（已修）：SecretRef 未解析
`api.config.channels.feishu.accounts.default.appId = '${FEISHU_APP_ID}'`，需 `resolveRef()` 展开。✅ 已修

### Bug B（已修）：before_prompt_build ctx 字段名错误
`ctx.channelId !== 'feishu'` → 实际 channelId 是 chat_id，用 `TARGET_GROUPS.has(chatId)` 判断。✅ 已修

### Bug C（已修）：_registered 守卫阻断 group session 注册
每个 session 的 `api` 对象独立，必须各自调用 `api.on()`。✅ 已修

### Bug D（现存）：message_sending ctx.channelId 始终是 'feishu'
当前代码 `chanId.startsWith('oc_')` 永远 false → @alias 替换从未执行。
**修复**：改为 `if (ctx?.channelId !== 'feishu') return`

### Bug E（潜在）：inbound_claim sender_type 判断
bot 消息的 `senderId` 是 **app_id**（`cli_xxx`）格式，而 registry `_byOpenId` 用 open_id 查找。
当前代码先试 `isBotSender(senderId)`（openId 查），再试 `isBotByAppId(senderId)`（appId 查）。
但 `isSelfSender(senderId)` 只查 openId，不查 appId → Jarvis 自己发的消息（app_id 是 `cli_a9294cca62b85cba`）可能未被识别为 self → 不会 drop。
**验证**：看 inbound_claim 日志里是否有 Jarvis 自己的消息被处理。

### Bug F（潜在）：active-memory 触发 before_prompt_build
active-memory 子 session 的 channelId = `oc_xxx:active-memory:xxx`，split(':')[0] 得 `oc_xxx`，命中 TARGET_GROUPS → 会触发 API 拉取，浪费一次请求。
**修复**：检测 sessionKey 是否包含 `active-memory`，是则跳过。

---

## 3. register() 正确模式

参考 `jarvis-feishu-signal-detector`：
- 无 `onStartup: true`（不在 startup 提前注册）
- 每个 session 来时调用 `register(api)`，直接 `api.on()`
- 无幂等守卫（OpenClaw 每个 session 的 api 对象独立，不会真正"双注册"到同一 runner）

**当前状态**：保留了 `onStartup: true`，每次 session 来时再次注册 → 可能双注册。
**建议**：先不改，专注修 Bug D。`onStartup` 配合移除 `_registered` 守卫基本能工作。

---

## 4. openclaw.plugin.json 正确格式

```json
{
  "name": "feishu-bot-social",
  "version": "1.0.0",
  "openclaw": {
    "extensions": ["./index.js"],
    "compat": { "pluginApi": ">=2026.3.0" }
  },
  "activation": { "onStartup": true },
  "id": "feishu-bot-social",
  "configSchema": {
    "type": "object",
    "properties": { ... },
    "additionalProperties": false
  }
}
```

❌ 不能在顶层有 `extensions`、`hooks`、`hooksConfig` 字段
✅ `extensions` 必须在 `"openclaw": {}` 包装里

---

## 5. 最小修改方案（只改 index.js）

### 改动1：message_sending 检查（Bug D）
```javascript
// 当前（错误）：
if (!chanId?.startsWith('oc_')) return;

// 修复（正确）：
if (ctx?.channelId !== 'feishu') return;
```

### 改动2：跳过 active-memory 子 session（Bug F）
```javascript
// before_prompt_build 开头加：
if (ctx?.sessionKey?.includes(':active-memory:')) {
  log.debug(`[before_prompt_build] skip active-memory sub-session`);
  return;
}
```

### 改动3：inbound_claim self 判断补 appId（Bug E）
```javascript
// 当前：
if (registry.isSelfSender(senderId)) { ... }

// 修复：
if (registry.isSelfSender(senderId) || registry.isBotByAppId(senderId) && registry.findByAppId(senderId)?.isSelf) { ... }
// 简化为：
if (registry.findByOpenId(senderId)?.isSelf || registry.findByAppId(senderId)?.isSelf) {
  log.debug('[inbound_claim] self message, drop');
  return { handled: true };
}
```
