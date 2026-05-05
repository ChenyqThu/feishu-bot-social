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
 */
function makeLogger(debugLogEnabled, logDir) {
  const getLogPath = () => {
    const d    = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return path.join(logDir, `fbs-debug-${date}.log`);
  };

  const write = (level, msg) => {
    if (!debugLogEnabled) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(getLogPath(), `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch (_) { /* ignore */ }
  };

  return {
    debug : (msg) => write('DEBUG', msg),
    info  : (msg) => write('INFO',  msg),
    warn  : (msg) => write('WARN',  msg),
    error : (msg) => write('ERROR', msg),
  };
}

module.exports = { escapeRegExp, formatTime, safeParseJson, truncate, makeLogger };
