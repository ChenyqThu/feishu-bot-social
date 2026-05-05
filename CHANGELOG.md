# Changelog

> 格式：[语义化版本](https://semver.org/lang/zh-CN/)。日期为本地（PDT）。

## [1.2.0] — 2026-05-05（OpenClaw 5.x 兼容）

OpenClaw v2026.5.x 停用了通用 `inbound_claim` hook（`runInboundClaim` 函数零调用），
本插件迁移到新 hook 模型并修复两个 hidden chamber bug。详见 [docs/HANDOFF.md](docs/HANDOFF.md)。

### Changed — Breaking（行为）

- **删除 `inbound_claim` hook**，改用 `message_received`（fire-and-forget void hook）
  - 不再支持 drop 消息 / 修改 content
  - "drop bot 自身、非 AI bot、未 @ Jarvis" 职责由 OpenClaw 上层 `groupPolicy` + `requireMention` 完成
  - "注入 sender 身份前缀" 改为在 `before_prompt_build` 中追加到 system prompt（`lastBotMention` 机制）

### Fixed — OpenClaw 5.x hidden chambers

- **per-session register 时 `api.config` 被裁剪不含 channels** → 闭包内 `FEISHU_ACCOUNTS = {}` → token 永远拿不到
  - 修复：把所有跨 register 共享的状态（accounts/base/token cache/registry/stormGuard 等）提到模块级 `SHARED` 对象
  - startup register 写入；per-session register 复用
- **`ctx.conversationId` 带 `chat:` / `user:` 前缀**（`toPluginMessageContext` 不调 `stripChannelPrefix`）→ `startsWith('oc_')` 永远 false
  - 修复：新增 `normalizeConversationId()` helper，message_received / message_sending 入口都归一化

### Added

- [docs/HANDOFF.md](docs/HANDOFF.md) — OpenClaw 5.x API 调研结果 + 迁移配方（同时供 jarvis-feishu-signal-detector 等插件参考）
- [scripts/sync.sh](scripts/sync.sh) — 源码 → extension 部署脚本，含 marker 校验 + 自动重启 gateway

## [1.1.0] — 2026-05-05

源码层第二轮系统 review 修复（独立于 EXPERT_REVIEW，发现 3 个真实 bug + 6 个可维护性提升）。

### Fixed — P0 真实 bug

- **Bug G** `formatContextBlock` 输出 `[object Object] 的助理`
  - `lib/context.js`：`${b.owner}` 是对象，应取 `b.owner?.name`
  - 影响：注入 system prompt 的 bot 名单中所有 owner 都显示乱码，LLM 拿到的群上下文身份信息错乱
- **Bug H** `message_sending` 熔断计数器永远不会被调用
  - `index.js`：原代码从 `ctx.channelId` 提 chatId，但源码验证 outbound `ctx.channelId === 'feishu'` 是固定值，`TARGET_GROUPS.has('feishu')` 永远 false → `recordOutbound` 永远不触发
  - 修复：用 `ctx.conversationId`（源码验证 `deliver-BffEFXmb.js applyMessageSendingHook` 实际传入 `params.to`）
  - 影响：StormGuard L3 熔断完全失效；修复后任何目标群 outbound 都纳入熔断窗口
- **Bug I** `_byOpenId` 被 owner 反向映射污染，导致 owner 消息被误判
  - `lib/registry.js`：原代码把 `bot.owner.openId → { ...bot, _isOwnerLookup: true }` 写入 `_byOpenId`
  - 后果：Lucien（Jarvis owner）在目标群发消息时被识别为 self bot 并整条 drop，"主人在群里 @ 自己的 Bot 永远不响应"
  - 修复：新增独立 `_byOwnerOpenId` Map + `findOwnerByOpenId()` 公开接口；`_byOpenId` 严格只含真正的 bot openId

### Changed — P1 可维护性

- **P1-1** `LUCIEN_OPEN_ID` 硬编码 → `cfg.alertReceiverOpenId`，加入 `openclaw.plugin.json` configSchema；未配置时跳过 DM 通知，不再依赖单一作者 ID
- **P1-2** `lib/registry.js` 中 `agentId === 'jarvis'` 字面量删除；`isSelf` 唯一权威来源 = `wiki-bots.json` 的 `isSelf` 字段（config-discovery 不再设置 isSelf）
- **P1-3** 删除 `package.json` 顶层冗余 `openclaw` 字段；让 `openclaw.plugin.json` 单一权威
- **P1-4** `getMembers()` / `findMemberByOpenId()` 由"每次同步读盘"改为 load 时一次性缓存到 `_members` + `_memberByOpenId` 索引，O(1) 查询
- **P1-5** `getTenantToken` 加 inflight Promise 去重，并发请求复用同一 fetch
- **P1-6** `discoverFromHistory` 加 per-chatId 5 分钟节流，避免重复扫描 100 条历史

### Added — P2 测试与文档

- **P2-1** 新增 `test/integration.js`：用 fake api 注册 hook，端到端覆盖 inbound_claim/before_prompt_build/message_sending 关键路径（12 断言全绿）
- **P2-1** `test/smoke.js` 增加 11 个 G/H/I 回归断言（测试总数 35 → 46）
- **P2-3** 本 CHANGELOG.md
- **P2-4** `lib/utils.js` 日志由 `appendFileSync` 改为内存 buffer + `setImmediate` 异步 flush；注册 `process.on('beforeExit')` drain，确保不丢日志
- `package.json` `test` 脚本扩展为 `smoke && integration`，新增 `test:smoke` / `test:integration` 单独执行入口

---

## [1.0.0] — 2026-05-04 ~ 2026-05-05

来自 EXPERT_REVIEW 与 HANDOFF 文档的首轮系统修复。

### Fixed

- **Bug A** SecretRef 未解析：`api.config` 里 `${ENV_VAR}` 形式的 appId/appSecret 加 `resolveRef()` 展开
- **Bug B** `before_prompt_build` ctx 字段名错误：`ctx.channelId` 不是 'feishu' 而是 chat_id；改为 `ctx?.channelId?.split(':')?.[0]` 提取
- **Bug C** `_registered` 守卫阻断 group session 注册：删除守卫，让每个 session 独立注册
- **Bug D** `message_sending` chanId 检查错误：`chanId.startsWith('oc_')` 永远 false（ctx.channelId 固定为 'feishu'）→ 改为 `if (ctx?.channelId !== 'feishu') return`
- **Bug E** inbound_claim self 判断只查 openId：bot sender 是 app_id 格式 → 同时查 `findByAppId` + `findByOpenId`
- **Bug F** active-memory 子 session 浪费 API 拉取 → before_prompt_build 开头检测 `sessionKey.includes(':active-memory:')`
- `before_prompt_build` 返回 `systemPromptExtra` SDK 不识别 → 改为 `appendSystemContext`
- `openclaw.plugin.json` 顶层放 extensions/hooks/hooksConfig 致插件静默不加载 → 嵌套到 `openclaw: {}` 包装

### Added

- 三 Hook 骨架（inbound_claim / before_prompt_build / message_sending）
- BotRegistry：wiki + config-discovery + history-discovery 多源合并
- ContextCache：分钟级缓存，同群同分钟内复用
- StormGuard：L1 prompt 规则 + L2 30s debounce + L3 1min 熔断
- 中文 README、wiki-bots.json 真实数据快照、smoke.js 35 断言

---

## 致谢

- 三 Hook 骨架灵感：[Leochens/feishu-bot-chat-plugin](https://github.com/Leochens/feishu-bot-chat-plugin)（MIT）
- `escapeRegExp` helper 来自上游 R1
- 平台：[OpenClaw](https://github.com/openclaw/openclaw) `pluginApi >= 2026.3.0`
