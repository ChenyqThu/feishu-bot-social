'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * escapeRegExp — 来自 [R1] feishu-bot-chat-plugin index.js，MIT 许可
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 格式化 Unix 秒级时间戳为 HH:MM
 */
function formatTime(unixSec) {
  const ms = typeof unixSec === 'string' ? parseInt(unixSec, 10) * 1000 : Number(unixSec) * 1000;
  const d  = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/**
 * 安全 JSON 解析，失败返回 null
 */
function safeParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch (_) { return null; }
}

/**
 * 截断字符串：超出 maxLen 时追加 …
 */
function truncate(str, maxLen) {
  if (!str) return '';
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * Logger 工厂
 * debugLogEnabled=false 时所有写盘静默，仍返回有效 logger 对象
 *
 * 异步 buffer：write() 只入队，flush() 由 setImmediate 在下一 tick 批量写盘
 * beforeExit 钩子保证退出前 drain pending，避免丢日志
 */
function makeLogger(debugLogEnabled, logDir) {
  const getLogPath = () => {
    const d    = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return path.join(logDir, `fbs-debug-${date}.log`);
  };

  const pending = [];
  let scheduled = false;
  let dirEnsured = false;

  const flush = () => {
    scheduled = false;
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length).join('');
    try {
      if (!dirEnsured) {
        fs.mkdirSync(logDir, { recursive: true });
        dirEnsured = true;
      }
      fs.appendFileSync(getLogPath(), batch);
    } catch (_) { /* ignore */ }
  };

  const write = (level, msg) => {
    if (!debugLogEnabled) return;
    pending.push(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  };

  // 退出前 drain，避免丢失尾部日志
  if (debugLogEnabled) {
    process.once('beforeExit', flush);
  }

  return {
    debug : (msg) => write('DEBUG', msg),
    info  : (msg) => write('INFO',  msg),
    warn  : (msg) => write('WARN',  msg),
    error : (msg) => write('ERROR', msg),
    flush,                     // 暴露 flush 给测试和外部紧急刷新场景
  };
}

module.exports = { escapeRegExp, formatTime, safeParseJson, truncate, makeLogger };
