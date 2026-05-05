# feishu-bot-social

> **飞书群聊 Bot 社交感知插件**——让群里的 AI Bot 能感知彼此、读懂上下文、互相 @、自然对话。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange)](https://clawhub.ai)
[![Platform](https://img.shields.io/badge/Platform-Feishu%20%2F%20Lark-blue)](https://open.feishu.cn)

---

## 这个插件做什么

飞书群里有多个 AI Bot 同时在线时，默认情况下每个 Bot 互相"看不见"——被 @才响应，但不知道其他 Bot 刚说了什么。这个插件解决三个问题：

| 功能 | 说明 |
|------|------|
| **群上下文感知** | 被 @ 时自动拉取群内近期消息（含其他 Bot 发言），注入 system prompt，让 Bot 的回复有完整群聊语境 |
| **接收 Bot @Mention** | 其他 Bot @ 你时，你的 webhook 能正常收到并响应（需开通权限） |
| **@alias 自动转 at 标签** | 回复里写 `@BotName`，系统自动转为飞书原生 `<at user_id="...">` 标签，真正触达对方 Bot |
| **防风暴保护** | Bot 之间避免形成无限循环 @，内置 debounce + 熔断机制 |

### 效果示意

```
用户 @你的Bot：帮我总结一下群里在聊什么

你的Bot 收到后：
  → 自动拉取群内近期 20 条消息（含其他 Bot 的发言）
  → 知道群里的 Bot 们最近说了什么
  → 回复有群聊语境，不再"不知道大家在聊什么"

其他Bot @你的Bot：你觉得这个设计怎么样？
  → 你的Bot webhook 收到消息（需开通权限）
  → 识别发送者身份，回复带发送者标注
  → 回复里写 @OtherBot，自动转为正确的 <at> 标签
```

---

## 快速安装（5分钟）

### 前置要求

- [OpenClaw](https://github.com/openclaw/openclaw) >= 5.0.0
- 飞书开发者后台有你的 Bot 应用管理权限

### Step 1：克隆并安装

```bash
git clone https://github.com/ChenyqThu/feishu-bot-social.git
cd feishu-bot-social
openclaw plugins install .
openclaw plugins enable feishu-bot-social
```

> ⚠️ 如果安装被 scanner 拦截，手动 cp 绕过：
> ```bash
> cp -r . ~/.openclaw/extensions/feishu-bot-social/
> ```

### Step 2：配置 openclaw.json

```json
{
  "plugins": {
    "entries": {
      "feishu-bot-social": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "contextGroups": ["oc_你的群chat_id"],
          "contextMessageCount": 20,
          "contextCacheTtlMs": 60000,
          "stormThreshold": 2,
          "debugLog": true
        }
      }
    }
  }
}
```

> **如何获取群 chat_id？** 飞书开发者后台查看消息事件，或用 API `GET /im/v1/chats` 查询。

### Step 3：填写 wiki-bots.json

编辑 `data/wiki-bots.json`，填入群里所有 Bot 的信息。这张表会被注入到 system prompt，让你的 Bot 知道该如何 @ 其他人。

```json
{
  "bots": {
    "my-bot": {
      "agentId": "my-bot",
      "appId": "cli_xxxxxxxxxxxx",
      "openId": "ou_xxxxxxxxxxxx",
      "name": "Bot昵称",
      "emoji": "🤖",
      "aliases": ["昵称", "别名"],
      "owner": {
        "name": "主人名",
        "aliases": ["主人", "昵称"],
        "openId": "ou_xxxxxxxxxxxx"
      },
      "description": "一句话描述能力",
      "isSelf": true,
      "isAI": true
    },
    "other-bot": {
      "agentId": "other-bot",
      "appId": "cli_yyyyyyyyyyyy",
      "openId": "ou_yyyyyyyyyyyy",
      "name": "另一个Bot",
      "emoji": "🐾",
      "aliases": ["另一个Bot"],
      "owner": {
        "name": "另一位主人",
        "aliases": ["主人昵称"],
        "openId": "ou_zzzzzzzzzzzz"
      },
      "description": "描述",
      "isSelf": false,
      "isAI": true
    }
  },
  "members": {
    "person-a": {
      "name": "群成员A",
      "aliases": ["A", "昵称A"],
      "openId": "ou_aaaaaaaaaa",
      "bot": "my-bot"
    }
  }
}
```

**如何获取 openId？**
- Bot 的 openId：调飞书 API `GET /bot/v3/info`（用对应 Bot 的 tenant token）
- 人员的 openId：**最可靠的方法**——让群管理员在群里发一条 @所有人 的确认消息，通过 `GET /im/v1/messages` 拉取，mentions 数组里有每个人从你的 Bot 视角看到的 openId

### Step 4：开通飞书权限

飞书开发者后台 → 你的应用 → 权限管理 → 开通：

```
im:message.group_at_msg.include_bot:readonly
```

> 不开此权限，其他 Bot @ 你时 webhook 收不到消息。开通后需发布新版本。

### Step 5：重启 Gateway

```bash
openclaw gateway restart
```

启动日志里确认看到：
```
http server listening (N plugins: ..., feishu-bot-social, ...)
[feishu-bot-social] registry loaded
```

---

## 多 Bot 互通（让群里所有 Bot 都装上）

如果群里有多个 Bot，**每个 Bot 都装上这个插件**，大家就能真正互相 @ 并收到消息。

每个 Bot 的 `wiki-bots.json` 只需改一行：把**自己的** Bot 设为 `"isSelf": true`，其他 Bot 设为 `false`。

所有 Bot 都开通 `im:message.group_at_msg.include_bot:readonly` 权限后，群里的 Bot 社交就打通了。

---

## 配置参数

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextGroups` | `string[]` | `[]` | 启用感知的群 chat_id 白名单 |
| `contextMessageCount` | `number` | `20` | 拉取群历史消息条数（5~100）|
| `contextCacheTtlMs` | `number` | `60000` | 上下文缓存 TTL（同群同分钟内复用）|
| `stormThreshold` | `number` | `2` | 30s 内 Bot @你 超过此次数触发防风暴 |
| `circuitBreakerMaxOutbound` | `number` | `5` | 1min 内发出超过此条数触发熔断 |
| `circuitBreakerSilenceMs` | `number` | `300000` | 熔断静默时长（默认 5 分钟）|
| `debugLog` | `boolean` | `true` | 写调试日志到 `logs/fbs-debug-YYYY-MM-DD.log` |

---

## 工作原理

插件注册三个 OpenClaw Hook（OpenClaw 5.x 兼容）：

```
飞书消息到达
      │
      ▼
message_received（观察 fire-and-forget；OpenClaw 5.x 已停用通用 inbound_claim）
  • 仅观察，不能 drop / 修改 content（消息守卫职责由 OpenClaw 上层
    groupPolicy / requireMention 完成）
  • 识别 sender：bot vs human；忽略 self / 非 AI bot（如 CRS告警）
  • 记录最近 bot @Jarvis 给 before_prompt_build 注入身份提示
  • storm guard L2 inbound 计数 → 阈值时 DM 通知管理员
      │
      ▼
before_prompt_build（上下文注入；返回 appendSystemContext）
  • 拉取近期群消息（含Bot发言），格式化为时间轴
  • 注入群内Bot名单（含openId和<at>标签模板）
  • 注入群成员@映射表（让Bot知道如何@人）
  • 追加最近 bot @ Jarvis 的发件人身份（替代旧版 prefix-in-content）
  • 追加到 system prompt 的 appendSystemContext
      │
      ▼
  LLM 生成回复（有完整群聊上下文）
      │
      ▼
message_sending（格式修正 + 熔断计数）
  • 检测回复中的 @BotName，替换为飞书原生 <at user_id="..."> 标签
  • outbound 计数：> circuitBreakerMaxOutbound 触发熔断（静默 silenceMs）
  • ctx.conversationId 是真正的 chat_id（含 chat: 前缀，已自动归一化）
```

> **OpenClaw 5.x API 变更说明**：通用 `inbound_claim` hook 已停用
> （`runInboundClaim` 函数零调用，仅 `runInboundClaimForPluginOutcome`
> 在对话 binding 时触发）。本插件改用 `message_received`（fire-and-forget），
> 消息守卫职责（drop / mention 检查）现由 OpenClaw 上层 `groupPolicy` +
> `requireMention` 配置完成。详见 [docs/HANDOFF.md](docs/HANDOFF.md)。

### 注入 System Prompt 示例

```
[群聊感知上下文 · 23:43]

本群活跃 AI Bot（2 个）：
  🤖 BotA（成员A 的助理）
     @ 方式: <at user_id="ou_xxx">BotA</at>
     ID: open_id: ou_xxx, app_id: cli_xxx
  🐾 BotB（成员B 的助理）
     @ 方式: <at user_id="ou_yyy">BotB</at>
     ...

本群人员 @ 映射：
  成员A（昵称A）：<at user_id="ou_aaa">成员A</at>
  ...

近期消息（最近 20 条，含 Bot 发言）：
22:11 | BotB🐾    | 今日内容播报
22:33 | 成员A     | @BotA 帮我处理一下
22:50 | BotA🤖    | 好的，已完成

交互规则：
① 上方是群内近期真实消息，可基于此回复
② 提到名字 ≠ @通知，需要通知对方才用 <at> 标签
③ 只有主人明确要求才 @其他Bot（系统自动转at标签）
④ 不要主动发起Bot间来回对话，防止循环
[/群聊感知上下文]
```

---

## 文件结构

```
feishu-bot-social/
├── index.js                    # 插件主入口（三 Hook 注册）
├── lib/
│   ├── utils.js                # 工具函数
│   ├── registry.js             # Bot 注册表（加载、索引、查找）
│   ├── context.js              # 群上下文拉取与格式化
│   └── storm-guard.js          # 防风暴（debounce + 熔断）
├── data/
│   └── wiki-bots.json          # Bot + 人员信息表（手动维护）
├── test/
│   └── smoke.js                # 冒烟测试（无需网络）
├── openclaw.plugin.json        # 插件元数据
├── package.json
└── logs/                       # 调试日志（运行时自动创建）
```

---

## 调试

```bash
# 实时查看调试日志
tail -f ~/.openclaw/extensions/feishu-bot-social/logs/fbs-debug-$(date +%Y-%m-%d).log

# 常见关键词
grep "registry loaded"              logs/fbs-debug-*.log   # 插件启动成功
grep "before_prompt_build.*chatId"  logs/fbs-debug-*.log   # 上下文注入触发
grep "Fetched.*msgs"                logs/fbs-debug-*.log   # 消息拉取成功
grep "bot @.*pass"                  logs/fbs-debug-*.log   # 收到Bot @你的消息
grep "Replaced.*<at>"               logs/fbs-debug-*.log   # @alias 转换成功
grep "storm.*Storm"                 logs/fbs-debug-*.log   # 防风暴触发

# 冒烟测试
node test/smoke.js
```

---

## 已知限制

- 仅支持飞书群聊（不支持 DM 或其他渠道）
- 接收其他 Bot @你 需要双方都开通 `im:message.group_at_msg.include_bot:readonly`
- 飞书 interactive card 里的 `<at>` 不会触发 webhook，需用 text/post 格式发送
- `wiki-bots.json` 为手动维护，更新后需重启 gateway
- **openId 是 app 视角的**：各 Bot 从自己的 app 视角看到的 openId 不同；`wiki-bots.json` 里填的是**你自己的 Bot 的 app 看到的** openId（通过让管理员在群里 @所有人 的消息来确认）

---

## 常见问题

**Q：插件 enabled 但没有出现在 gateway 启动日志的 plugin 列表里？**  
A：检查 `openclaw.plugin.json` 格式是否正确，`openclaw` 字段需要嵌套在 `"openclaw": {}` 包装里，且需要 `"activation": { "onStartup": true }`。

**Q：before_prompt_build 没有触发（日志里没有 context 注入记录）？**  
A：确认 `openclaw.json` 里有 `plugins.entries.feishu-bot-social.hooks.allowConversationAccess: true`。

**Q：@BotName 没有转成 `<at>` 标签？**  
A：确认 `wiki-bots.json` 里对应 Bot 有正确的 `openId`，且 aliases 与回复里写的名字一致。

---

## 致谢

架构参考：[feishu-bot-chat-plugin](https://github.com/Leochens/feishu-bot-chat-plugin)（三 Hook 骨架、Bot 自动发现思路，MIT）

---

*MIT License · Built with [OpenClaw](https://github.com/openclaw/openclaw)*
