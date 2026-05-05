'use strict';

/**
 * context.js — 群消息上下文拉取与格式化
 *
 * buildExcerpt   : 移植自 [R2] read-actions patch §3.2.2，增加 post @mention 解析
 * fetchGroupContext : 直接调飞书 API（不依赖 read-actions patch 内部实现）
 * formatContextBlock : 生成注入 system prompt 的 appendSystemContext 字符串
 * ContextCache   : 分钟级 key，同一群同一分钟内复用，避免重复拉取
 */

const { formatTime, safeParseJson, truncate } = require('./utils');

const EXCERPT_MAX_LEN = 150;

// ── buildExcerpt ──────────────────────────────────────────────────────────────

/**
 * 归一化消息内容为可读摘要
 * 移植自 [R2] §3.2.2，覆盖 8 种 msg_type
 * 本版本增加：post 中 at 标签的 user_name 解析
 *
 * @param {Object} item  - 飞书 message list API 返回的单条消息对象
 * @param {number} maxLen - 最大字符数（超出截断 + …）
 * @returns {string}
 */
function buildExcerpt(item, maxLen = EXCERPT_MAX_LEN) {
  const msgType = item?.msg_type || 'text';
  const obj     = safeParseJson(item?.body?.content) || {};
  let out = '';

  switch (msgType) {
    case 'text': {
      out = String(obj.text ?? '');
      break;
    }
    case 'post': {
      // post 格式：{ title: '', content: [[{tag, text?, user_name?}]] }
      const blocks = obj?.content || obj?.zh_cn?.content || [];
      const lines  = [];
      for (const block of blocks) {
        const parts = [];
        for (const seg of (Array.isArray(block) ? block : [])) {
          if (seg.tag === 'text' && seg.text)           parts.push(seg.text);
          else if (seg.tag === 'at' && seg.user_name)   parts.push(`@${seg.user_name}`);
          else if (seg.tag === 'a'  && seg.text)        parts.push(seg.text);
        }
        if (parts.length) lines.push(parts.join(''));
      }
      out = lines.join(' / ');
      break;
    }
    case 'interactive':
    case 'card': {
      // 提取 header.title 和第一行 body 文字
      const header = obj?.header?.title?.content ||
                     obj?.header?.title?.text?.content || '';
      const elements = obj?.elements || obj?.body?.elements || [];
      let bodyText = '';
      for (const el of elements) {
        const t = el?.text?.content || el?.text?.text?.content || el?.content || '';
        if (t) { bodyText = String(t); break; }
      }
      out = `[卡片]${header ? ' ' + header : ''}${bodyText ? ' — ' + bodyText : ''}`;
      break;
    }
    case 'image':   out = '[图片]'; break;
    case 'file':    out = `[文件 ${obj.file_name || ''}]`.trim(); break;
    case 'audio':   out = '[语音]'; break;
    case 'sticker': out = '[表情包]'; break;
    case 'media':
    case 'video':   out = '[视频]'; break;
    default:        out = `[${msgType}]`; break;
  }

  return truncate(out, maxLen);
}

// ── fetchGroupContext ─────────────────────────────────────────────────────────

/**
 * 拉取群近期消息（直接调飞书 API，不依赖 read-actions patch 内部实现）
 *
 * 返回时间升序（最新在后），方便格式化为时间轴
 *
 * @param {string} chatId
 * @param {number} limit        - 返回条数
 * @param {string} tenantToken
 * @param {string} baseUrl      - https://open.feishu.cn 或 https://open.larksuite.com
 * @returns {Promise<Array>}
 */
async function fetchGroupContext(chatId, limit, tenantToken, baseUrl) {
  const scan   = Math.max(limit * 2, 30);
  const params = new URLSearchParams({
    container_id_type: 'chat',
    container_id     : chatId,
    sort_type        : 'ByCreateTimeDesc',
    page_size        : String(Math.min(scan, 50)),
  });

  const res = await fetch(`${baseUrl}/open-apis/im/v1/messages?${params}`, {
    headers: { Authorization: `Bearer ${tenantToken}` },
    signal : AbortSignal.timeout(6000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Feishu API ${json.code}: ${json.msg}`);

  // API 返回降序（最新在前），翻转为升序
  const items = (json.data?.items || []).slice(0, limit);
  return items.reverse();
}

// ── formatContextBlock ────────────────────────────────────────────────────────

/**
 * 将消息列表格式化为时间轴字符串（供 formatContextBlock 使用）
 */
function formatMessageTimeline(messages, registry) {
  if (!messages || !messages.length) return '（暂无近期消息记录）';

  return messages.map(item => {
    const timeStr  = formatTime(item.create_time || item.createTime || '0');
    const sender   = item.sender || {};
    const senderId = sender.id || '';
    const senderType = sender.sender_type || 'user';

    let senderName;
    if (senderType === 'app') {
      // sender.id 是 app_id（不是 open_id），先试 openId 再试 appId
      const bot  = registry.findByOpenId(senderId) || registry.findByAppId(senderId);
      senderName = bot
        ? `${bot.name}${bot.emoji ? ' ' + bot.emoji : ''}`
        : `Bot(${senderId.slice(-8)})`;
    } else {
      // 用户：从 mentions 列表里找名字兜底
      const mentions = item.mentions || [];
      const m = mentions.find(x => (x.id?.open_id || x.id) === senderId);
      senderName = m?.name || `用户(${senderId.slice(-8)})`;
    }

    return `${timeStr} | ${senderName} | ${buildExcerpt(item)}`;
  }).join('\n');
}

/**
 * 构建完整的群聊感知上下文注入字符串
 * 返回值用于 before_prompt_build hook 的 appendSystemContext 字段
 *
 * @param {Object} opts
 * @param {Array}       opts.messages  - fetchGroupContext 的结果
 * @param {BotRegistry} opts.registry
 * @param {string}      opts.chatId
 * @returns {string}
 */
function formatContextBlock({ messages, registry, chatId }) {
  const displayBots = registry.getDisplayBots();
  const now         = new Date();
  const timeStr     = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  // 注入 bot 名字 + open_id + app_id，让 Jarvis 知道如何正确 @ 各 bot
  // 参考 [R1] feishu-bot-chat-plugin 的做法：注入 at 标签模板
  const botListStr = displayBots.length > 0
    ? displayBots.map(b => {
        const atTag = b.openId
          ? `<at user_id="${b.openId}">${b.name}</at>`
          : `@${b.name}`;
        const idInfo = [
          b.openId  ? `open_id: ${b.openId}`  : '',
          b.appId   ? `app_id: ${b.appId}`    : '',
        ].filter(Boolean).join(', ');
        const ownerName = b.owner?.name || '未知';
        return `  ${b.emoji || '🤖'} ${b.name}（${ownerName} 的助理）\n` +
               `     @ 方式: ${atTag}\n` +
               `     ID: ${idInfo}`;
      }).join('\n')
    : '  （未发现其他 AI Bot）';

  const timelineStr = formatMessageTimeline(messages, registry);

  // 人员 @ 映射表
  const members = registry.getMembers ? registry.getMembers() : [];
  const memberMapStr = members.length > 0
    ? members.map(m => {
        const atTag = m.openId ? `<at user_id="${m.openId}">${m.name}</at>` : `@${m.name}`;
        const aliases = (m.aliases || []).filter(a => a !== m.name).join('/');
        return `  ${m.name}${aliases ? '（' + aliases + '）' : ''}：${atTag}`;
      }).join('\n')
    : '  （无）';

  return `
[群聊感知上下文 · ${timeStr}]

本群活跃 AI Bot（${displayBots.length} 个）：
${botListStr}

本群人员 @ 映射（用于在回复中正确 @ 人）：
${memberMapStr}

近期消息（最近 ${messages.length} 条，含 Bot 发言）：
${timelineStr}

交互规则：
① 上方是群内近期真实消息记录，包括其他 Bot 的发言，可基于此回复
② 回复中可以自然提及名字，但「提到」≠「@通知」；需要通知对方才用上方的 <at> 标签
③ 只有 Lucien 明确要求与某 Bot 互动时，才用 @名字（系统自动转 at 标签）
④ 不要主动发起 Bot 间来回对话，防止循环响应
[/群聊感知上下文]
`.trim();
}

// ── ContextCache ──────────────────────────────────────────────────────────────

/**
 * 分钟级缓存：同一群同一分钟内，无论触发多少次，只拉一次 API
 */
class ContextCache {
  constructor(ttlMs = 60000) {
    this._cache = new Map();
    this._ttlMs = ttlMs;
  }

  _key(chatId) {
    return `${chatId}:${Math.floor(Date.now() / this._ttlMs)}`;
  }

  get(chatId) {
    return this._cache.get(this._key(chatId)) || null;
  }

  set(chatId, value) {
    // 清理过期 key
    for (const k of this._cache.keys()) {
      const ts = parseInt(k.split(':').pop(), 10);
      if (Math.floor(Date.now() / this._ttlMs) - ts > 2) this._cache.delete(k);
    }
    this._cache.set(this._key(chatId), value);
  }
}

module.exports = { buildExcerpt, fetchGroupContext, formatContextBlock, ContextCache };
