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
| **@alias 自动转 at 标签** | 回复里写 `@小K`，系统自动转为飞书原生 `<at user_id="...">` 标签，真正触达对方 Bot |
| **防风暴保护** | Bot 之间避免形成无限循环 @，内置 debounce + 熔断机制 |

### 效果示意

```
用户 @Jarvis：帮我总结一下群里在聊什么

Jarvis 收到消息后：
  → 自动拉取群内近期 20 条消息（含小K、rr 的发言）
  → 知道小K 5分钟前发了晨报、rr 刚出了一批插画
  → 回复有群聊语境，不再"不知道大家在聊什么"

小K @Jarvis：你觉得这个设计怎么样？
  → Jarvis webhook 收到消息（需开通权限）
  → 识别发送者是小K，回复带发送者标注
  → Jarvis 回复里写 @小K，自动转为正确的 <at> 标签
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

### Step 2：配置 openclaw.json

在你的 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "feishu-bot-social": {
        "enabled": true,
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

> **如何获取群 chat_id？** 飞书开发者后台 → 事件与回调 → 查看群消息事件，或用 API `/im/v1/chats` 查询。

### Step 3：更新 wiki-bots.json

编辑 `data/wiki-bots.json`，填入你的群里所有 Bot 的信息：

```json
{
  "bots": {
    "your-bot": {
      "agentId": "your-bot",
      "appId": "cli_xxxxxxxxxxxx",
      "openId": "ou_xxxxxxxxxxxx",
      "name": "你的Bot名",
      "emoji": "🤖",
      "aliases": ["bot名", "别名"],
      "owner": {
        "name": "主人名",
        "aliases": ["主人", "昵称"],
        "openId": "ou_xxxxxxxxxxxx"
      },
      "description": "一句话描述",
      "isSelf": true,
      "isAI": true
    }
  },
  "members": {
    "member-key": {
      "name": "群成员名",
      "aliases": ["昵称1", "昵称2"],
      "openId": "ou_xxxxxxxxxxxx",
      "bot": "该成员拥有的bot名（无则null）"
    }
  }
}
```

**如何获取 openId？**
- Bot 的 openId：调用飞书 API `/bot/v3/info`（用对应 Bot 的 tenant token）
- 人员的 openId：在群里发一条 @所有人 的消息，通过 API `/im/v1/messages` 拉取，mentions 数组里有每个人的 openId
- 最可靠的方式：让 Lucien/群管理员在群里发一条 @全员 的确认消息，读 mentions 字段

### Step 4：开通飞书权限（接收其他 Bot @你）

飞书开发者后台 → 你的应用 → 权限管理 → 搜索并开通：

```
im:message.group_at_msg.include_bot:readonly
```

> **说明**：不开此权限，其他 Bot @ 你时你的 webhook 收不到消息。开通后需发布新版本。

### Step 5：重启 Gateway

```bash
openclaw gateway restart
```

---

## 给小K / rr / 其他 Bot 安装

如果你是群里其他 Bot 的维护者（比如小K 的老王、rr 的 Yuhui），安装步骤完全一样。

**关键差异**：`wiki-bots.json` 里你的 Bot 要设 `"isSelf": true`，其他 Bot 设 `false`。

```bash
# 小K 的安装示例
git clone https://github.com/ChenyqThu/feishu-bot-social.git
cd feishu-bot-social

# 修改 data/wiki-bots.json：
# - 把 xiaok 的 isSelf 改为 true
# - 把其他 bot 的 isSelf 改为 false
# - 填入你自己群的 chat_id

openclaw plugins install .
openclaw plugins enable feishu-bot-social
```

所有 Bot 都装好、都开通 `im:message.group_at_msg.include_bot:readonly` 后，群里的 Bot 就能真正互相 @ 并收到消息了。

---

## 配置说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextGroups` | `string[]` | `[]` | 启用上下文感知的群 chat_id 白名单 |
| `contextMessageCount` | `number` | `20` | 每次拉取的群历史消息条数（5~100） |
| `contextCacheTtlMs` | `number` | `60000` | 上下文缓存 TTL（同一群同分钟内复用） |
| `stormThreshold` | `number` | `2` | 30s 内 Bot @你 超过此次数触发防风暴 |
| `circuitBreakerMaxOutbound` | `number` | `5` | 1min 内你发出超过此条数触发熔断 |
| `circuitBreakerSilenceMs` | `number` | `300000` | 熔断静默时长（默认 5 分钟） |
| `debugLog` | `boolean` | `true` | 是否写调试日志到 `logs/fbs-debug-YYYY-MM-DD.log` |

---

## 工作原理

插件注册三个 OpenClaw Hook：

```
飞书消息到达
      │
      ▼
inbound_claim（消息守卫）
  • 非目标群 → 透传
  • 人类消息 → 透传
  • CRS告警等非AI Bot → 丢弃
  • 其他Bot 未@你 → 丢弃
  • 其他Bot @你 → 通过，并在消息前注入「来自 小K」标注
      │
      ▼
before_prompt_build（上下文注入）
  • 调飞书 API 拉取近期群消息（含Bot发言）
  • 格式化为时间轴：「22:11 | 小K🐾 | [卡片] 今日晨报...」
  • 注入群内Bot名单（含openId和at标签模板）
  • 注入群成员@映射表
  • 追加到 system prompt 的 appendSystemContext
      │
      ▼
  LLM 生成回复（有完整群聊上下文）
      │
      ▼
message_sending（格式修正）
  • 检测回复中的 @botName
  • 替换为飞书原生 <at user_id="..."> 标签
  • 真正触发对方Bot的webhook
```

---

## 注入 System Prompt 示例

```
[群聊感知上下文 · 23:43]

本群活跃 AI Bot（6 个）：
  🐾 小K（Kevin 的助理）
     @ 方式: <at user_id="ou_a2c019095b2cb92317d70fe00ce88153">小K</at>
     ID: open_id: ou_a2c019095b2cb92317d70fe00ce88153, app_id: cli_a92d7a5bb57a1bc4
  😼 rr（Yuhui 的助理）
     @ 方式: <at user_id="ou_9dc35fe422a1afd389b2e5f7ec132577">rr</at>
     ...

本群人员 @ 映射（用于在回复中正确 @ 人）：
  Kevin（老王/王俊/王叔）：<at user_id="ou_2eda37915c0a659b01ffe864727d59e4">Kevin</at>
  Yuhui（雨慧/Raina）：<at user_id="ou_47a7c2e70616e78a4832c0e7753c4f22">Yuhui</at>
  ...

近期消息（最近 20 条，含 Bot 发言）：
22:11 | 小K🐾      | [卡片] 今日晨报
22:33 | Kevin      | @小K 沉淀到wiki人物card
22:50 | 小K🐾      | wiki 沉淀完事 🐾
23:22 | Lucien     | @小K 发消息 单独 at 一下 Jarvis
23:27 | 小K🐾      | @Jarvis 这次 @ 对人了——bot-to-bot 测试...

交互规则：
① 上方是群内近期真实消息，包括其他Bot的发言，可基于此回复
② 提到名字 ≠ @通知，需要通知对方才用上方的 <at> 标签
③ 只有 Lucien 明确要求与某Bot互动，才写 @名字（系统自动转at标签）
④ 不要主动发起Bot间来回对话，防止循环响应
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
│   └── smoke.js                # 冒烟测试（36个，无需网络）
├── openclaw.plugin.json        # 插件元数据
└── logs/                       # 调试日志（运行时自动创建）
```

---

## 调试

```bash
# 实时查看调试日志
tail -f ~/.openclaw/extensions/feishu-bot-social/logs/fbs-debug-$(date +%Y-%m-%d).log

# 常见日志关键词
grep "before_prompt_build.*Fetched" logs/fbs-debug-*.log   # 上下文注入成功
grep "inbound_claim.*bot @"         logs/fbs-debug-*.log   # 收到Bot @你的消息
grep "message_sending.*Replaced"    logs/fbs-debug-*.log   # @alias 转换成功
grep "storm-guard.*Storm"           logs/fbs-debug-*.log   # 防风暴触发

# 运行冒烟测试
node test/smoke.js
```

---

## 已知限制

- 仅支持飞书群聊（不支持 DM、不支持其他渠道）
- 接收其他 Bot @你 需要双方都开通 `im:message.group_at_msg.include_bot:readonly`
- 飞书 interactive card 里的 `<at>` 标签不会触发 webhook，需用 text/post 格式发送
- `wiki-bots.json` 为手动维护，更新后需重启 gateway

---

## 贡献

欢迎 PR！尤其是：
- 自动同步 wiki-bots.json 与 OpenClaw wiki entities
- 支持 Lark（国际版飞书）
- 更多 msg_type 的 buildExcerpt 归一化

---

## 致谢

- 架构参考：[feishu-bot-chat-plugin](https://github.com/Leochens/feishu-bot-chat-plugin)（三 Hook 骨架、Bot 自动发现思路，MIT）
- 实现于蛋姐群 AI 伙伴军团实战场景（Jarvis / 小K / rr / Zero / miniGG / 暴躁蛋小黄 / Lyra）

---

*MIT License · Built with [OpenClaw](https://github.com/openclaw/openclaw)*
