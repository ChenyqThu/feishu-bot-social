'use strict';

/**
 * feishu-bot-social — Plugin 主入口（OpenClaw 5.x compatible）
 *
 * Hook 注册：
 *   1. message_received    — 观察入站消息（storm 计数 + 记录最近 bot @Jarvis）
 *   2. before_prompt_build — 群上下文注入 system prompt（含最近 bot mention 提示）
 *   3. message_sending     — @alias → <at user_id="..."> + outbound 熔断计数
 *
 * 重要：OpenClaw 5.x 已停用通用 inbound_claim hook（runInboundClaim 函数零调用，
 *   仅 runInboundClaimForPluginOutcome 在对话 binding 时触发）。本插件改用
 *   message_received（fire-and-forget），不再尝试丢弃消息或修改 content。
 *   消息守卫职责由 OpenClaw 上层 groupPolicy/requireMention 配置完成。
 *
 * register() 设计：OpenClaw 5.x 在 startup 和每个 session 都会 register；
 *   只有 startup register 的 api.config 含 channels.accounts。所有共享状态
 *   提到模块级 SHARED 对象，register() 仅在配置可用时更新它。
 */

const path = require('path');

const { BotRegistry }                                        = require('./lib/registry');
const { fetchGroupContext, formatContextBlock, ContextCache } = require('./lib/context');
const { StormGuard }                                         = require('./lib/storm-guard');
const { escapeRegExp, makeLogger }                           = require('./lib/utils');

// ── 模块级共享状态 ──────────────────────────────────────────────────────────
// startup register（含 api.config.channels）写入；后续 per-session register
// 复用，避免每 session 重新初始化。

const SHARED = {
  // 配置
  feishuAccounts     : {},                                // {accountId: {appId, appSecret}}
  feishuBase         : 'https://open.feishu.cn',
  targetGroups       : new Set(),
  alertReceiverOpenId: null,
  contextCount       : 20,

  // 运行时单例（首次 register 创建一次）
  registry    : null,
  contextCache: null,
  stormGuard  : null,
  log         : null,

  // tenant token 缓存与 inflight 去重
  tokenCache   : new Map(),
  tokenInflight: new Map(),

  // 最近一次 bot @Jarvis 的发件人（用于在 before_prompt_build 中注入身份提示）
  // chatId → { senderName, senderAtTag, ts }
  lastBotMention: new Map(),

  // hook 是否已挂到当前 api 的标记（不同 api 对象需各自挂）
  // 因 hooks 是 per-api 的（OpenClaw harness 行为），SHARED 不跟踪
};

const LAST_MENTION_TTL_MS = 5 * 60 * 1000; // 5 分钟内最近 bot 提及可注入

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveRef(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
}

/**
 * 归一化对话 ID：去掉 OpenClaw `toPluginMessageContext` 在 message_received /
 * message_sending ctx 中保留的 `chat:` / `user:` / `channel:` 前缀。
 * 源码：dist/message-hook-mappers stripChannelPrefix
 */
function normalizeConversationId(raw) {
  if (typeof raw !== 'string') return raw;
  for (const p of ['chat:', 'user:', 'channel:']) {
    if (raw.startsWith(p)) return raw.slice(p.length);
  }
  return raw;
}

function captureConfigFromApi(api, cfg) {
  // pluginConfig 在每次 register 都传，可直接取
  if (Array.isArray(cfg.contextGroups)) SHARED.targetGroups = new Set(cfg.contextGroups);
  if (cfg.contextMessageCount) {
    SHARED.contextCount = Math.min(Math.max(Number(cfg.contextMessageCount), 5), 100);
  }
  if (cfg.alertReceiverOpenId !== undefined) {
    SHARED.alertReceiverOpenId = cfg.alertReceiverOpenId || null;
  }

  // api.config 仅在 startup register 含 channels；per-session register 此处为空，跳过
  const ch = api.config?.channels?.feishu;
  if (!ch) return;

  SHARED.feishuBase = ch.domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';

  const rawAccounts = ch.accounts || {};
  const resolved = {};
  for (const [id, acct] of Object.entries(rawAccounts)) {
    resolved[id] = {
      ...acct,
      appId    : resolveRef(acct.appId),
      appSecret: resolveRef(acct.appSecret),
    };
  }
  if (Object.keys(resolved).length > 0) SHARED.feishuAccounts = resolved;
}

async function getTenantToken(accountId = 'default') {
  const cached = SHARED.tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const inflight = SHARED.tokenInflight.get(accountId);
  if (inflight) return inflight;

  const promise = (async () => {
    const acctId = accountId === 'default'
      ? Object.keys(SHARED.feishuAccounts)[0]
      : accountId;
    const acct = SHARED.feishuAccounts[acctId];
    if (!acct?.appId || !acct?.appSecret) {
      SHARED.log?.warn(`[token] no credentials for ${acctId}`);
      return null;
    }

    try {
      const res  = await fetch(`${SHARED.feishuBase}/open-apis/auth/v3/tenant_access_token/internal`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ app_id: acct.appId, app_secret: acct.appSecret }),
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.msg);
      SHARED.tokenCache.set(accountId, {
        token    : json.tenant_access_token,
        expiresAt: Date.now() + json.expire * 1000,
      });
      SHARED.log?.info(`[token] obtained for ${acctId}, expires in ${json.expire}s`);
      return json.tenant_access_token;
    } catch (e) {
      SHARED.log?.error(`[token] failed: ${e.message}`);
      return null;
    }
  })();

  SHARED.tokenInflight.set(accountId, promise);
  try {
    return await promise;
  } finally {
    SHARED.tokenInflight.delete(accountId);
  }
}

function ensureSingletons(cfg, api, glog) {
  if (!SHARED.log) {
    SHARED.log = makeLogger(cfg.debugLog !== false, path.join(__dirname, 'logs'));
  }
  if (!SHARED.contextCache) {
    SHARED.contextCache = new ContextCache(Number(cfg.contextCacheTtlMs) || 60_000);
  }
  if (!SHARED.stormGuard) {
    SHARED.stormGuard = new StormGuard({
      stormThreshold            : Number(cfg.stormThreshold)            || 2,
      circuitBreakerMaxOutbound : Number(cfg.circuitBreakerMaxOutbound) || 5,
      circuitBreakerSilenceMs   : Number(cfg.circuitBreakerSilenceMs)   || 300_000,
      logger                    : SHARED.log,
      onStormDetected           : sendStormDM,
    });
  }
  if (!SHARED.registry) {
    SHARED.registry = new BotRegistry(SHARED.log);
    SHARED.registry.load(cfg, api.config || {})
      .then(() => {
        glog?.info('[feishu-bot-social] registry loaded');
        SHARED.log.info('[registry] load complete');
      })
      .catch(e => {
        glog?.warn(`[feishu-bot-social] registry load failed: ${e.message}`);
        SHARED.log.error(`[registry] load failed: ${e.message}`);
      });
  }
}

async function sendStormDM(chatId) {
  if (!SHARED.alertReceiverOpenId) {
    SHARED.log?.info(`[storm-guard] storm in ${chatId} but alertReceiverOpenId not configured, skip DM`);
    return;
  }
  try {
    const token = await getTenantToken();
    if (!token) return;
    await fetch(`${SHARED.feishuBase}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        receive_id: SHARED.alertReceiverOpenId,
        msg_type  : 'text',
        content   : JSON.stringify({
          text: `⚠️ [fbs] Bot 消息循环风险，已暂停响应 bot @mention\n群：${chatId}`,
        }),
      }),
    });
    SHARED.log?.info(`[storm-guard] DM sent to ${SHARED.alertReceiverOpenId} for ${chatId}`);
  } catch (e) {
    SHARED.log?.warn(`[storm-guard] DM failed: ${e.message}`);
  }
}

// ── Plugin 定义 ─────────────────────────────────────────────────────────────

const plugin = {
  id         : 'feishu-bot-social',
  name       : 'Feishu Bot Social',
  description: '飞书群聊 Bot 社交感知：群上下文注入 / @alias 格式转换 / 防风暴',

  register(api) {
    const cfg  = api.pluginConfig ?? {};
    const glog = api.logger;

    captureConfigFromApi(api, cfg);
    ensureSingletons(cfg, api, glog);

    const log = SHARED.log;
    log.info('=== feishu-bot-social registering ===');
    log.info(`[init] accounts: ${Object.keys(SHARED.feishuAccounts).join(', ') || '(none)'} | first appId: ${Object.values(SHARED.feishuAccounts)[0]?.appId?.slice(0,8) || 'undefined'}...`);
    log.info(`target groups: ${[...SHARED.targetGroups].join(', ') || '(none)'}`);
    log.info(`context count: ${SHARED.contextCount}`);
    log.info(`alert receiver: ${SHARED.alertReceiverOpenId || '(not configured, DM disabled)'}`);

    // ════════════════════════════════════════════════════════════════════════
    // Hook 1: message_received（替代已停用的 inbound_claim）
    //
    // 触发时机：OpenClaw 上层 groupPolicy/requireMention 已判定要 dispatch 后触发
    // 语义：fire-and-forget void hook — 不能 drop 消息、不能修改 content
    // 用途：
    //   1. 识别 sender 是否 bot；记录最近一次 bot @Jarvis 用于 system prompt 注入
    //   2. storm guard L2 inbound 计数（触发阈值后通过 DM 通知管理员）
    //   3. 异步触发 history-discovery
    //
    // ctx 字段（源码验证 message-hook-mappers toPluginMessageContext）：
    //   ctx.channelId      = 'feishu'
    //   ctx.conversationId = 群=oc_xxx, DM=ou_xxx
    //   ctx.senderId       = sender open_id 或 app_id
    //   ctx.sessionKey     = 'agent:jarvis:feishu:group:oc_xxx'
    // ════════════════════════════════════════════════════════════════════════
    api.on('message_received', (event, ctx) => {
      if (ctx?.channelId !== 'feishu') return;
      // ctx.conversationId 实际格式：'chat:oc_xxx' (group) / 'user:ou_xxx' (DM) — 需归一化
      const chatId = normalizeConversationId(ctx?.conversationId);
      if (!chatId || !SHARED.targetGroups.has(chatId)) return;
      // 仅群消息有意义（chat_id 以 oc_ 起头；DM 是 ou_，不在 targetGroups 内但加保险）
      if (!chatId.startsWith('oc_')) return;

      const senderId = ctx?.senderId;
      if (!senderId) return;

      log.debug(`[message_received] chat=${chatId} sender=${senderId}`);

      const reg     = SHARED.registry;
      const senderBot = reg.findByOpenId(senderId) || reg.findByAppId(senderId);

      if (!senderBot) {
        // 人类发件人：不需要记录身份（before_prompt_build 用群历史本身已能呈现）
        return;
      }
      if (senderBot.isSelf || !senderBot.isAI) {
        // 自己 / 非 AI bot（如 CRS告警）：忽略
        return;
      }

      // storm guard：bot @Jarvis 计数（已 dispatch 来到这里，意味着 OpenClaw 判定要触发）
      const sr = SHARED.stormGuard.recordBotInbound(chatId);
      if (sr.drop) {
        // 注意：v5 message_received 是 fire-and-forget，无法真正 drop；
        // storm 状态会通过 DM 通知管理员，并阻断后续 outbound（熔断在 message_sending 侧生效）
        log.warn(`[message_received] storm condition reached: reason=${sr.reason} chat=${chatId} (cannot drop here; outbound circuit will block replies)`);
      }

      // 记录最近 bot 提及，用于 before_prompt_build 注入身份提示
      const senderName  = `${senderBot.name}${senderBot.emoji ? ' ' + senderBot.emoji : ''}`;
      const senderAtTag = senderBot.openId
        ? `<at user_id="${senderBot.openId}">${senderBot.name}</at>`
        : senderName;
      SHARED.lastBotMention.set(chatId, {
        senderName,
        senderAtTag,
        senderId,
        ts: Date.now(),
      });
      log.info(`[message_received] bot mention from ${senderName} in ${chatId}`);
      glog?.info(`[feishu-bot-social] bot @Jarvis from ${senderName}`);
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 2: before_prompt_build
    // 上下文增强：拉取群近期消息（含 bot 消息）注入 system prompt
    //
    // 机制：accumulating merge（所有 plugin 的 appendSystemContext 自动 concat）
    // 返回字段：{ appendSystemContext: string }（不是 systemPromptExtra！）
    // ════════════════════════════════════════════════════════════════════════
    api.on('before_prompt_build', async (event, ctx) => {
      // active-memory 子 session 不需要群上下文
      if (ctx?.sessionKey?.includes(':active-memory:')) return;

      const chatId = ctx?.channelId?.split(':')?.[0];
      log.debug(`[before_prompt_build] channelId=${ctx?.channelId} chatId=${chatId}`);

      if (!chatId || !SHARED.targetGroups.has(chatId)) return;

      // 缓存命中（同群同分钟内复用）
      const cached = SHARED.contextCache.get(chatId);
      let baseBlock;
      if (cached) {
        log.debug(`[before_prompt_build] cache hit for ${chatId}`);
        baseBlock = cached;
      } else {
        try {
          const token = await getTenantToken();
          if (!token) {
            log.warn('[before_prompt_build] no token, skip context');
            return;
          }
          const messages = await fetchGroupContext(chatId, SHARED.contextCount, token, SHARED.feishuBase);
          log.info(`[before_prompt_build] fetched ${messages.length} msgs from ${chatId}`);
          SHARED.registry.discoverFromHistory(chatId, token, SHARED.feishuBase).catch(() => {});
          baseBlock = formatContextBlock({ messages, registry: SHARED.registry, chatId });
          SHARED.contextCache.set(chatId, baseBlock);
        } catch (e) {
          log.warn(`[before_prompt_build] fetch failed: ${e.message}, degrading`);
          glog?.warn(`[feishu-bot-social] context fetch failed for ${chatId}: ${e.message}`);
          return;
        }
      }

      // 追加最近 bot 提及身份信息（替代旧版 inbound_claim 的 prefix 注入）
      const mention = SHARED.lastBotMention.get(chatId);
      const mentionBlock = (mention && Date.now() - mention.ts < LAST_MENTION_TTL_MS)
        ? `\n\n[最近触发本次响应的发件人]\n  ${mention.senderName}\n  如需 @ 回对方：${mention.senderAtTag}`
        : '';

      return { appendSystemContext: baseBlock + mentionBlock };
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 3: message_sending
    // 格式修正：@alias → 飞书原生 <at user_id="..."> 标签
    //
    // ctx 字段（源码验证 deliver.js applyMessageSendingHook）：
    //   ctx.channelId      = 'feishu'   始终固定（路由通道名）
    //   ctx.accountId      = '...'
    //   ctx.conversationId = params.to  群=oc_xxx, DM=ou_xxx — 真正的对话 ID
    // ════════════════════════════════════════════════════════════════════════
    api.on('message_sending', (event, ctx) => {
      log.debug(`[message_sending] channelId=${ctx?.channelId} convId=${ctx?.conversationId} len=${event.content?.length}`);
      if (ctx?.channelId !== 'feishu') return;

      let content  = event.content || '';
      let modified = false;

      for (const bot of SHARED.registry.getAtTargets()) {
        for (const alias of (bot.aliases || [])) {
          const pattern = new RegExp(
            `@${escapeRegExp(alias)}(?=[^a-zA-Z0-9一-鿿]|$)`,
            'g'
          );
          const replaced = content.replace(pattern, `<at user_id="${bot.openId}">${bot.name}</at>`);
          if (replaced !== content) {
            log.info(`[message_sending] @${alias} → <at> for ${bot.name}`);
            content  = replaced;
            modified = true;
          }
        }
      }

      // 熔断计数：用 ctx.conversationId 取群 chatId（channelId 在 outbound 固定为 'feishu'）
      // 同样归一化 'chat:oc_xxx' 前缀
      const chatId = normalizeConversationId(ctx?.conversationId);
      if (chatId && SHARED.targetGroups.has(chatId)) {
        SHARED.stormGuard.recordOutbound(chatId);
      }

      if (modified) return { content };
    });

    log.info('=== feishu-bot-social all hooks registered ===');
    glog?.info('[feishu-bot-social] registered: message_received + before_prompt_build + message_sending');
  },
};

module.exports = plugin;
module.exports.default = plugin;
