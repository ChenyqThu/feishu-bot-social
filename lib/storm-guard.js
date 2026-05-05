'use strict';

/**
 * storm-guard.js — Bot 消息循环防护
 *
 * 防护层级：
 *   L1（规则层）：system prompt 规则④ 禁止 Jarvis 主动发起循环
 *   L2（Debounce）：30s 内 bot @Jarvis ≥ threshold → STORM_DETECTED，暂停 + DM Lucien
 *   L3（熔断）   ：1min 内 outbound ≥ maxOutbound → CIRCUIT_OPEN（静默 silenceMs）
 *   L4（人工豁免）：人类消息永远不受 L2/L3 影响（由 inbound_claim 在判断 isBotSender 后决定）
 */

const STORM_WINDOW_MS   = 30  * 1000;  // 30s debounce 窗口
const CIRCUIT_WINDOW_MS = 60  * 1000;  // 1min 熔断计数窗口

class StormGuard {
  /**
   * @param {Object} opts
   * @param {number}   opts.stormThreshold
   * @param {number}   opts.circuitBreakerMaxOutbound
   * @param {number}   opts.circuitBreakerSilenceMs
   * @param {Function} opts.onStormDetected - async (chatId) => void
   * @param {Object}   opts.logger
   */
  constructor(opts = {}) {
    this.stormThreshold  = opts.stormThreshold              || 2;
    this.maxOutbound     = opts.circuitBreakerMaxOutbound   || 5;
    this.silenceMs       = opts.circuitBreakerSilenceMs     || 300_000;
    this.onStormDetected = opts.onStormDetected             || (() => {});
    this.log             = opts.logger || { info: ()=>{}, warn: ()=>{}, debug: ()=>{} };

    // chatId → { botInboundTs: number[], outboundTs: number[], circuitOpenAt: number|null }
    this._state = new Map();
  }

  _state_(chatId) {
    if (!this._state.has(chatId)) {
      this._state.set(chatId, { botInboundTs: [], outboundTs: [], circuitOpenAt: null });
    }
    return this._state.get(chatId);
  }

  /**
   * 记录一次 bot 发来的 @Jarvis 消息
   * @returns {{ drop: boolean, reason: string|null }}
   */
  recordBotInbound(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();

    // 检查熔断状态
    if (s.circuitOpenAt !== null) {
      if (now - s.circuitOpenAt < this.silenceMs) {
        this.log.info(`[storm-guard] circuit OPEN for ${chatId}, dropping`);
        return { drop: true, reason: 'circuit_open' };
      }
      // 熔断已过期，重置
      s.circuitOpenAt  = null;
      s.botInboundTs   = [];
      this.log.info(`[storm-guard] circuit reset for ${chatId}`);
    }

    // 清理窗口外记录
    s.botInboundTs = s.botInboundTs.filter(ts => now - ts < STORM_WINDOW_MS);
    s.botInboundTs.push(now);

    if (s.botInboundTs.length >= this.stormThreshold) {
      this.log.warn(`[storm-guard] storm detected in ${chatId}: ${s.botInboundTs.length} msgs in 30s`);
      s.botInboundTs = []; // 重置计数，进入冷却期
      // 异步通知，不阻塞 hook 返回
      Promise.resolve().then(() => this.onStormDetected(chatId)).catch(() => {});
      return { drop: true, reason: 'storm_debounce' };
    }

    return { drop: false, reason: null };
  }

  /**
   * 记录一次 Jarvis outbound 消息（用于熔断计数）
   */
  recordOutbound(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();
    s.outboundTs = s.outboundTs.filter(ts => now - ts < CIRCUIT_WINDOW_MS);
    s.outboundTs.push(now);

    if (s.outboundTs.length >= this.maxOutbound) {
      s.circuitOpenAt = now;
      s.outboundTs    = [];
      this.log.warn(`[storm-guard] circuit OPENED for ${chatId}: silence ${this.silenceMs/1000}s`);
    }
  }

  /** 手动重置（如 Lucien 发指令解除静默） */
  reset(chatId) {
    this._state.delete(chatId);
    this.log.info(`[storm-guard] manual reset for ${chatId}`);
  }

  getStatus(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();
    const open = s.circuitOpenAt !== null && now - s.circuitOpenAt < this.silenceMs;
    return {
      chatId,
      circuitOpen       : open,
      circuitRemainingMs: open ? this.silenceMs - (now - s.circuitOpenAt) : 0,
      recentBotInbound  : s.botInboundTs.length,
      recentOutbound    : s.outboundTs.length,
    };
  }
}

module.exports = { StormGuard };
