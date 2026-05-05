'use strict';

/**
 * feishu-bot-social — Plugin 主入口
 *
 * 三个 OpenClaw Plugin Hook：
 *   1. inbound_claim       — 消息守卫（过滤 bot 消息 + 注入发送者身份）
 *   2. before_prompt_build — 上下文增强（群历史 + bot 名单注入 system prompt）
 *   3. message_sending     — 格式修正（@alias → <at user_id="..."> 标签）
 *
 * 关键：before_prompt_build 返回 { appendSystemContext: string }
 *   — SDK mergeBeforePromptBuild 会将多 plugin 的 appendSystemContext 自动 concat
 *   — 不要用 systemPromptExtra（SDK 不识别）
 *
 * 架构参考：[R1] feishu-bot-chat-plugin v0.2.0 三 Hook 骨架
 * 核心逻辑（上下文注入、防风暴）：本插件原创
 */

const path = require('path');
const os   = require('os');

const { BotRegistry }                                        = require('./lib/registry');
const { fetchGroupContext, formatContextBlock, ContextCache } = require('./lib/context');
const { StormGuard }                                         = require('./lib/storm-guard');
const { escapeRegExp, makeLogger }                           = require('./lib/utils');

// ── Plugin 定义 ───────────────────────────────────────────────────────────────

const plugin = {
  id         : 'feishu-bot-social',
  name       : 'Feishu Bot Social',
  description: '飞书群聊 Bot 社交感知：群上下文注入 / Bot@Bot 接收 / @alias 格式转换 / 防风暴',

  register(api) {
    const cfg  = api.pluginConfig ?? {};
    const glog = api.logger; // gateway 日志
    const log  = makeLogger(cfg.debugLog !== false, path.join(__dirname, 'logs'));

    log.info('=== feishu-bot-social registering ===');

    // ── 配置 ─────────────────────────────────────────────────────────────────

    const TARGET_GROUPS   = new Set(cfg.contextGroups || []);
    const CONTEXT_COUNT   = Math.min(Math.max(Number(cfg.contextMessageCount) || 20, 5), 100);
    const FEISHU_CHANNEL  = api.config?.channels?.feishu || {};
    const FEISHU_DOMAIN   = FEISHU_CHANNEL.domain || 'feishu';
    const FEISHU_BASE     = FEISHU_DOMAIN === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // SecretRef 解析器：api.config 里 ${ENV_VAR} 模板需手动展开
    function resolveRef(val) {
      if (typeof val !== 'string') return val;
      return val.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
    }

    // 从 api.config 读账户，解析 SecretRef 后得到实际 appId/appSecret
    const rawAccounts = FEISHU_CHANNEL.accounts || {};
    const FEISHU_ACCOUNTS = {};
    for (const [id, acct] of Object.entries(rawAccounts)) {
      FEISHU_ACCOUNTS[id] = {
        ...acct,
        appId    : resolveRef(acct.appId),
        appSecret: resolveRef(acct.appSecret),
      };
    }
    log.info(`[init] accounts: ${Object.keys(FEISHU_ACCOUNTS).join(', ')} | first appId: ${Object.values(FEISHU_ACCOUNTS)[0]?.appId?.slice(0,8)}...`);

    // Lucien 的 open_id（防风暴 DM 通知用）
    const LUCIEN_OPEN_ID = 'ou_8d1ce0fa1d435070ed695baeabe25adc';

    log.info(`target groups: ${[...TARGET_GROUPS].join(', ') || '(none)'}`);
    log.info(`context count: ${CONTEXT_COUNT}`);

    // ── 模块 ─────────────────────────────────────────────────────────────────

    const registry     = new BotRegistry(log);
    const contextCache = new ContextCache(Number(cfg.contextCacheTtlMs) || 60_000);

    const stormGuard = new StormGuard({
      stormThreshold            : Number(cfg.stormThreshold)            || 2,
      circuitBreakerMaxOutbound : Number(cfg.circuitBreakerMaxOutbound) || 5,
      circuitBreakerSilenceMs   : Number(cfg.circuitBreakerSilenceMs)   || 300_000,
      logger                    : log,
      onStormDetected           : async (chatId) => {
        try {
          const token = await getTenantToken();
          if (!token) return;
          await fetch(`${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`, {
            method : 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body   : JSON.stringify({
              receive_id: LUCIEN_OPEN_ID,
              msg_type  : 'text',
              content   : JSON.stringify({
                text: `⚠️ [fbs] Bot 消息循环风险，已暂停响应 bot @mention\n群：${chatId}`,
              }),
            }),
          });
          log.info(`[storm-guard] DM sent to Lucien for ${chatId}`);
        } catch (e) {
          log.warn(`[storm-guard] DM failed: ${e.message}`);
        }
      },
    });

    // ── Tenant Token 管理（带过期缓存）──────────────────────────────────────

    const tokenCache = new Map(); // accountId → { token, expiresAt }

    async function getTenantToken(accountId = 'default') {
      const cached = tokenCache.get(accountId);
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

      // 找第一个可用账户
      const acctId = accountId === 'default'
        ? Object.keys(FEISHU_ACCOUNTS)[0]
        : accountId;
      const acct = FEISHU_ACCOUNTS[acctId];
      if (!acct?.appId || !acct?.appSecret) {
        log.warn(`[token] no credentials for ${acctId}`);
        return null;
      }

      try {
        const res  = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({ app_id: acct.appId, app_secret: acct.appSecret }),
        });
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.msg);
        tokenCache.set(accountId, {
          token    : json.tenant_access_token,
          expiresAt: Date.now() + json.expire * 1000,
        });
        log.info(`[token] obtained for ${acctId}, expires in ${json.expire}s`);
        return json.tenant_access_token;
      } catch (e) {
        log.error(`[token] failed: ${e.message}`);
        return null;
      }
    }

    // ── 异步初始化：加载 registry ─────────────────────────────────────────────

    registry.load(cfg, api.config || {})
      .then(() => {
        glog?.info('[feishu-bot-social] registry loaded');
        log.info('[registry] load complete');
      })
      .catch(e => {
        glog?.warn(`[feishu-bot-social] registry load failed: ${e.message}`);
        log.error(`[registry] load failed: ${e.message}`);
      });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 1: inbound_claim
    // 消息守卫：过滤不相关的 bot 消息，为 @Jarvis 的 bot 消息注入发送者身份
    //
    // 机制：first-claim-wins（第一个返回 {handled:true} 的 plugin 获胜）
    // 参考：[R1] inbound_claim hook，去掉 A2A 语义，增加非 AI bot 过滤
    // ════════════════════════════════════════════════════════════════════════
    api.on('inbound_claim', (event, ctx) => {
      log.debug(`[inbound_claim] ch=${event.channel} group=${event.isGroup} ` +
                `sender=${event.senderId} mentioned=${event.wasMentioned} chat=${event.conversationId}`);

      // ① 非飞书渠道 → 透传
      if (event.channel !== 'feishu') return;

      // ② 非群聊（DM）→ 透传
      if (!event.isGroup) return;

      // ③ 非目标群 → 透传
      const chatId = event.conversationId;
      if (!chatId || !TARGET_GROUPS.has(chatId)) return;

      const senderId   = event.senderId;
      const senderIsBot = registry.isBotSender(senderId) || registry.isBotByAppId(senderId);

      // ④ 人类消息 → 透传
      if (!senderIsBot) {
        log.debug(`[inbound_claim] human ${senderId}, pass`);
        return;
      }

      // ⑤ 自己（Jarvis）发的消息 → DROP（sender 可能是 open_id 或 app_id 格式）
      const selfByOpenId = registry.findByOpenId(senderId)?.isSelf;
      const selfByAppId  = registry.findByAppId(senderId)?.isSelf;
      if (selfByOpenId || selfByAppId) {
        log.debug('[inbound_claim] self message, drop');
        return { handled: true };
      }

      // ⑥ 非 AI bot（CRS告警等）→ DROP
      if (registry.isNonAIBot(senderId)) {
        log.debug(`[inbound_claim] non-AI bot ${senderId}, drop`);
        return { handled: true };
      }

      // ⑦ AI bot 未 @Jarvis → DROP
      if (!event.wasMentioned) {
        log.debug(`[inbound_claim] bot ${senderId} no mention, drop`);
        glog?.info(`[feishu-bot-social] swallowed bot msg (no mention) from ${senderId}`);
        return { handled: true };
      }

      // ⑧ AI bot @Jarvis → 防风暴检查
      const sr = stormGuard.recordBotInbound(chatId);
      if (sr.drop) {
        log.warn(`[inbound_claim] storm drop: reason=${sr.reason} chat=${chatId}`);
        return { handled: true };
      }

      // ⑨ 通过：注入发送者身份前缀
      const senderBot  = registry.findByOpenId(senderId) || registry.findByAppId(senderId);
      const senderName = senderBot
        ? `${senderBot.name}${senderBot.emoji ? ' ' + senderBot.emoji : ''}`
        : `Bot(${senderId})`;
      const senderAtTag = senderBot?.openId
        ? `<at user_id="${senderBot.openId}">${senderBot.name}</at>`
        : senderName;
      const prefix = `[来自 ${senderName}，如需 @ 回对方请使用：${senderAtTag}]\n\n`;

      log.info(`[inbound_claim] bot @Jarvis from ${senderName}, pass with prefix`);
      glog?.info(`[feishu-bot-social] bot @Jarvis from ${senderName}`);
      return { content: prefix + (event.content || '') };
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 2: before_prompt_build
    // 上下文增强：拉取群近期消息（含 bot 消息）注入 system prompt
    //
    // 机制：accumulating merge（所有 plugin 的 appendSystemContext 自动 concat）
    // 返回字段：{ appendSystemContext: string }（不是 systemPromptExtra！）
    // ════════════════════════════════════════════════════════════════════════
    api.on('before_prompt_build', async (event, ctx) => {
      // ctx.channelId: 群=oc_xxx, DM=ou_xxx, active-memory子session=oc_xxx:active-memory:xxx
      // active-memory 子 session 不需要群上下文，直接跳过（节省一次 API 请求）
      if (ctx?.sessionKey?.includes(':active-memory:')) return;

      const chatId = ctx?.channelId?.split(':')?.[0];
      log.debug(`[before_prompt_build] channelId=${ctx?.channelId} chatId=${chatId}`);

      if (!chatId || !TARGET_GROUPS.has(chatId)) return;

      // ④ 命中缓存（同群同分钟内复用）
      const cached = contextCache.get(chatId);
      if (cached) {
        log.debug(`[before_prompt_build] cache hit for ${chatId}`);
        return { appendSystemContext: cached };
      }

      // ⑤ 拉取群消息上下文
      let contextBlock;
      try {
        const token = await getTenantToken();
        if (!token) {
          log.warn('[before_prompt_build] no token, skip context');
          return;
        }

        const messages = await fetchGroupContext(chatId, CONTEXT_COUNT, token, FEISHU_BASE);
        log.info(`[before_prompt_build] fetched ${messages.length} msgs from ${chatId}`);

        // 异步触发历史 bot 发现，不阻塞本次响应
        registry.discoverFromHistory(chatId, token, FEISHU_BASE).catch(() => {});

        contextBlock = formatContextBlock({ messages, registry, chatId });
      } catch (e) {
        // 降级：API 失败时跳过注入，不阻塞响应
        log.warn(`[before_prompt_build] fetch failed: ${e.message}, degrading`);
        glog?.warn(`[feishu-bot-social] context fetch failed for ${chatId}: ${e.message}`);
        return;
      }

      // ⑥ 写缓存并返回
      contextCache.set(chatId, contextBlock);
      return { appendSystemContext: contextBlock };
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 3: message_sending
    // 格式修正：@alias → 飞书原生 <at user_id="..."> 标签
    //
    // 机制：sequential modifying，返回修改后的 { content }
    // 仅替换有 openId 的非自身 bot 的 aliases
    // escapeRegExp 来自 [R1]
    // ════════════════════════════════════════════════════════════════════════
    api.on('message_sending', (event, ctx) => {
      // message_sending ctx.channelId 始终是 'feishu'（路向层固定），不是 oc_xxx 或 ou_xxx
      // 源码验证：message-hook-mappers outbound context channelId = messageProvider = 'feishu'
      log.debug(`[message_sending] channelId=${ctx?.channelId} len=${event.content?.length}`);
      if (ctx?.channelId !== 'feishu') return;

      let content  = event.content || '';
      let modified = false;

      // ② 遍历所有可 @ 的 bot（AI + 非自身 + 有 openId）
      for (const bot of registry.getAtTargets()) {
        for (const alias of (bot.aliases || [])) {
          // 精确 word boundary：@alias 后跟非中文非字母数字（或字符串末尾）
          const pattern = new RegExp(
            `@${escapeRegExp(alias)}(?=[^a-zA-Z0-9\u4e00-\u9fff]|$)`,
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

      if (modified) {
        // 记录 outbound（熔断计数）
        const chatId = ctx?.channelId?.split(':')?.[0];
        if (chatId && TARGET_GROUPS.has(chatId)) {
          stormGuard.recordOutbound(chatId);
        }
        return { content };
      }
    });

    log.info('=== feishu-bot-social all hooks registered ===');
    glog?.info('[feishu-bot-social] registered: inbound_claim + before_prompt_build + message_sending');
  },
};

module.exports = plugin;
module.exports.default = plugin;
