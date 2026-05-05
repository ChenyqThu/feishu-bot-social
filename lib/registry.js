'use strict';

/**
 * registry.js — Bot 注册表
 *
 * 数据来源优先级（高→低）：
 *   1. pluginConfig.botOverrides（用户手动配置）
 *   2. data/wiki-bots.json（wiki 静态快照，离线可用）
 *   3. discoverFromConfig()（运行时从 openclaw.json bindings + /bot/v3/info 发现）
 *   4. discoverFromHistory()（运行时从群消息历史发现 external bot）
 *
 * 参考：[R1] feishu-bot-chat-plugin discoverBots() / buildLookups() 架构思路，重写实现
 * 关键差异：放弃 members API（实测不可靠），改用 wiki + history 两路兜底
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { makeLogger } = require('./utils');

const REGISTRY_DIR  = path.join(os.homedir(), '.openclaw', 'fbs-registry');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');
const WIKI_BOTS_PATH = path.join(__dirname, '..', 'data', 'wiki-bots.json');
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24h

class BotRegistry {
  constructor(logger) {
    this.log      = logger || makeLogger(false, '/tmp');
    this._bots    = new Map(); // agentId      → bot
    this._byOpenId = new Map(); // bot.openId   → bot
    this._byAppId  = new Map(); // bot.appId    → bot
    this._byAlias  = new Map(); // alias.toLowerCase() → bot
    this._byOwnerOpenId = new Map(); // owner.openId → bot（独立索引，不与 _byOpenId 混用）
    this._members = []; // wiki-bots.json members 数组（load 时缓存，避免每次 read+parse）
    this._memberByOpenId = new Map();
    this._lastDiscoverAt = new Map(); // chatId → 上次 discoverFromHistory 时间戳，节流用
    this._selfOpenId = null;
  }

  static DISCOVER_THROTTLE_MS = 5 * 60 * 1000; // 5 分钟内同群最多发起一次 history discovery

  // ── 公共：加载注册表 ──────────────────────────────────────────────────────

  async load(pluginConfig = {}, openclawConfig = {}) {
    const overrides = pluginConfig.botOverrides || {};

    // 1. wiki 静态快照（基础）
    const wikiBots = this._loadWikiBots();
    this.log.info(`[registry] wiki snapshot: ${Object.keys(wikiBots).length} bots`);

    // 2. 运行时发现（补充 accountId）
    let configBots = {};
    try {
      configBots = await this._discoverFromConfig(openclawConfig);
      this.log.info(`[registry] config discovery: ${Object.keys(configBots).length} bots`);
    } catch (e) {
      this.log.warn(`[registry] config discovery failed: ${e.message}`);
    }

    // 3. 合并：wiki 为主，config 补充 accountId
    const merged = { ...wikiBots };
    for (const [agentId, configBot] of Object.entries(configBots)) {
      if (merged[agentId]) {
        merged[agentId] = { ...merged[agentId], accountId: configBot.accountId };
      } else {
        merged[agentId] = { ...configBot, source: 'config' };
        this.log.info(`[registry] new bot from config: ${agentId}`);
      }
    }

    // 4. 用户 overrides（最高优先级）
    for (const [agentId, override] of Object.entries(overrides)) {
      if (merged[agentId]) {
        merged[agentId] = { ...merged[agentId], ...override };
      }
    }

    // 5. 建立内存索引
    this._buildLookups(merged);
    this.log.info(`[registry] ready: ${this._bots.size} bots, self=${this._selfOpenId}`);
  }

  // ── 公共：历史消息发现 external bot ──────────────────────────────────────

  async discoverFromHistory(chatId, tenantToken, baseUrl) {
    // 节流：5 分钟内同群只允许一次扫描，防止每条入站消息都打一次 100 条历史
    const lastAt = this._lastDiscoverAt.get(chatId) || 0;
    const now    = Date.now();
    if (now - lastAt < BotRegistry.DISCOVER_THROTTLE_MS) {
      this.log.debug(`[registry] history discovery throttled for ${chatId} (last ${Math.round((now-lastAt)/1000)}s ago)`);
      return;
    }
    this._lastDiscoverAt.set(chatId, now);

    const url = `${baseUrl}/open-apis/im/v1/messages?container_id_type=chat` +
                `&container_id=${encodeURIComponent(chatId)}&sort_type=ByCreateTimeDesc&page_size=100`;
    try {
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${tenantToken}` } });
      const json = await res.json();
      if (json.code !== 0) return;

      let newFound = 0;
      for (const item of (json.data?.items || [])) {
        const sender = item.sender || {};
        if (sender.sender_type !== 'app') continue;
        const appId = sender.id;
        if (!appId || this._byAppId.has(appId)) continue;

        const extId  = `__ext_${appId}`;
        const extBot = {
          agentId : extId,
          appId,
          openId  : null,
          name    : `未知Bot(${appId.slice(-8)})`,
          aliases : [],
          isSelf  : false,
          isAI    : true,
          external: true,
          source  : 'history',
        };
        this._bots.set(extId, extBot);
        this._byAppId.set(appId, extBot);
        newFound++;
        this.log.info(`[registry] external bot discovered: ${appId}`);
      }
      if (newFound > 0) {
        this.log.info(`[registry] history discovery: ${newFound} new bots in ${chatId}`);
      }
    } catch (e) {
      this.log.warn(`[registry] historyDiscovery error: ${e.message}`);
    }
  }

  // ── 查找接口 ──────────────────────────────────────────────────────────────

  findByOpenId(openId) { return this._byOpenId.get(openId) || null; }
  findByAppId(appId)   { return this._byAppId.get(appId)   || null; }
  findByAlias(alias)   { return this._byAlias.get((alias || '').toLowerCase()) || null; }
  findById(agentId)    { return this._bots.get(agentId)    || null; }

  /** 通过 owner 的 openId 找到他/她管理的 bot（owner 是人类，不是 bot 本身） */
  findOwnerByOpenId(openId) { return this._byOwnerOpenId.get(openId) || null; }

  getAllBots()      { return [...this._bots.values()]; }
  getAIBots()      { return this.getAllBots().filter(b => b.isAI); }
  getSelfOpenId()  { return this._selfOpenId; }

  /** 可被 @ 的 bot：AI + 非自身 + 有 openId */
  getAtTargets() {
    return this.getAIBots().filter(b => !b.isSelf && b.openId);
  }

  /** 对外展示的 bot 名单（AI + 非自身 + 非 external） */
  getDisplayBots() {
    return this.getAIBots().filter(b => !b.isSelf && !b.external);
  }

  isSelfSender(openId) { return openId === this._selfOpenId; }
  isBotSender(openId)  { return this._byOpenId.has(openId) || false; }
  isBotByAppId(appId)  { return this._byAppId.has(appId) || false; }

  isNonAIBot(openId) {
    const bot = this._byOpenId.get(openId);
    return bot ? !bot.isAI : false;
  }

  // ── 内部：wiki 快照加载 ───────────────────────────────────────────────────

  _loadWikiBots() {
    try {
      const raw  = fs.readFileSync(WIKI_BOTS_PATH, 'utf8');
      const data = JSON.parse(raw);
      // 同时缓存 members（之前每次 getMembers 都重读盘）
      this._members = Object.values(data.members || {});
      this._memberByOpenId.clear();
      for (const m of this._members) {
        if (m.openId) this._memberByOpenId.set(m.openId, m);
      }
      return data.bots || {};
    } catch (e) {
      this.log.warn(`[registry] wiki-bots.json load failed: ${e.message}`);
      this._members = [];
      this._memberByOpenId.clear();
      return {};
    }
  }

  // ── 内部：config discovery（参考 [R1] discoverBots()，去掉 A2A 字段）────

  async _discoverFromConfig(openclawConfig) {
    // 检查文件缓存（24h TTL）
    const cached = this._readCache();
    if (cached) {
      this.log.info('[registry] using cached config discovery');
      return cached;
    }

    const bindings     = openclawConfig.bindings || [];
    const feishuChannel = openclawConfig.channels?.feishu || {};
    const accounts     = feishuChannel.accounts || {};
    const domain       = feishuChannel.domain || 'feishu';
    const baseUrl      = domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // 找出所有绑定了飞书 accountId 的 agent
    const agentAccountMap = new Map();
    for (const b of bindings) {
      if (b.match?.channel === 'feishu' && b.match?.accountId) {
        agentAccountMap.set(b.agentId, b.match.accountId);
      }
    }

    if (agentAccountMap.size === 0) return {};

    const result     = {};
    const tokenCache = new Map();

    for (const [agentId, accountId] of agentAccountMap) {
      const acct = accounts[accountId];
      if (!acct?.appId || !acct?.appSecret) continue;
      try {
        let token = tokenCache.get(accountId);
        if (!token) {
          token = await this._getTenantToken(acct.appId, acct.appSecret, baseUrl);
          tokenCache.set(accountId, token);
        }
        const info = await this._getBotInfo(token, baseUrl);
        result[agentId] = {
          agentId,
          accountId,
          appId : acct.appId,
          openId: info.openId,
          name  : info.name,
          // isSelf 不在此处设置：唯一权威来源是 wiki-bots.json 的 isSelf 字段
          // load() 中 merge 时 wiki 字段优先，确保 self 仅由 wiki 决定
          isAI  : true,
          external: false,
          source: 'config',
        };
        this.log.info(`[registry] discovered: ${agentId} → ${info.name} (${info.openId})`);
      } catch (e) {
        this.log.warn(`[registry] discovery failed for ${agentId}: ${e.message}`);
      }
    }

    if (Object.keys(result).length > 0) this._writeCache(result);
    return result;
  }

  // ── 内部：建立内存索引（参考 [R1] buildLookups()）─────────────────────────

  _buildLookups(bots) {
    this._bots.clear();
    this._byOpenId.clear();
    this._byAppId.clear();
    this._byAlias.clear();
    this._byOwnerOpenId.clear();
    this._selfOpenId = null;

    for (const [agentId, bot] of Object.entries(bots)) {
      this._bots.set(agentId, bot);
      if (bot.openId) this._byOpenId.set(bot.openId, bot);
      if (bot.appId)  this._byAppId.set(bot.appId, bot);
      for (const alias of (bot.aliases || [])) {
        this._byAlias.set(alias.toLowerCase(), bot);
      }
      // owner 是人类——单独索引，不污染 _byOpenId（否则 owner 会被 isBotSender 误判）
      if (bot.owner?.openId) {
        this._byOwnerOpenId.set(bot.owner.openId, bot);
      }
      if (bot.isSelf && bot.openId) {
        this._selfOpenId = bot.openId;
      }
    }
  }

  // 获取所有人员信息（从 members 表，load() 时已缓存）
  getMembers() {
    return this._members;
  }

  // 通过 openId 查询人员名字（O(1)，使用 load() 时建立的索引）
  findMemberByOpenId(openId) {
    return this._memberByOpenId.get(openId) || null;
  }

  // ── 内部：文件缓存 ───────────────────────────────────────────────────────

  _readCache() {
    try {
      const raw  = fs.readFileSync(REGISTRY_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (!data.discoveredAt) return null;
      if (Date.now() - new Date(data.discoveredAt).getTime() > CACHE_TTL_MS) return null;
      return data.configBots || null;
    } catch (_) { return null; }
  }

  _writeCache(configBots) {
    try {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify({
        version     : 2,
        discoveredAt: new Date().toISOString(),
        configBots,
      }, null, 2));
    } catch (e) {
      this.log.warn(`[registry] cache write failed: ${e.message}`);
    }
  }

  // ── 内部：飞书 API helpers ─────────────────────────────────────────────────

  async _getTenantToken(appId, appSecret, baseUrl) {
    const res  = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`tenant_token: ${json.msg}`);
    return json.tenant_access_token;
  }

  async _getBotInfo(token, baseUrl) {
    const res  = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`bot/v3/info: ${json.msg}`);
    const bot  = json.bot || {};
    return { openId: bot.open_id, name: bot.app_name || bot.bot_name || 'Unknown' };
  }
}

module.exports = { BotRegistry };
