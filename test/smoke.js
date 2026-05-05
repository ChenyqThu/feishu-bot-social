'use strict';

/**
 * 冒烟测试：核心模块离线验证（无需真实 API / gateway）
 * 运行：node test/smoke.js
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ── Test 1: utils ─────────────────────────────────────────────────────────────
console.log('\n[smoke] Test 1: utils');
const { escapeRegExp, formatTime, safeParseJson, truncate } = require('../lib/utils');

assert(escapeRegExp('小K.+?') === '小K\\.\\+\\?',     'escapeRegExp: special chars');
assert(safeParseJson('{"a":1}')?.a === 1,              'safeParseJson: valid JSON');
assert(safeParseJson('not json') === null,              'safeParseJson: invalid → null');
assert(truncate('hello world', 5) === 'hello…',        'truncate: over limit');
assert(truncate('hi', 10) === 'hi',                    'truncate: under limit');
assert(typeof formatTime('1714900000') === 'string',   'formatTime: returns string');

// ── Test 2: buildExcerpt ──────────────────────────────────────────────────────
console.log('\n[smoke] Test 2: buildExcerpt');
const { buildExcerpt } = require('../lib/context');

const textMsg = { msg_type: 'text', body: { content: '{"text":"hello world"}' } };
assert(buildExcerpt(textMsg) === 'hello world', 'text: plain text');

const longText = { msg_type: 'text', body: { content: JSON.stringify({ text: 'a'.repeat(200) }) } };
assert(buildExcerpt(longText).endsWith('…'), 'text: long text truncated');

const postMsg = {
  msg_type: 'post',
  body: { content: JSON.stringify({
    content: [[ { tag: 'text', text: '你好' }, { tag: 'at', user_name: '小K' } ]],
  }) },
};
const postEx = buildExcerpt(postMsg);
assert(postEx.includes('你好'), 'post: text segment');
assert(postEx.includes('@小K'), 'post: at mention');

const cardMsg = {
  msg_type: 'interactive',
  body: { content: JSON.stringify({
    header  : { title: { content: '天气播报' } },
    elements: [{ text: { content: '今天晴' } }],
  }) },
};
const cardEx = buildExcerpt(cardMsg);
assert(cardEx.includes('[卡片]'),   'interactive: card prefix');
assert(cardEx.includes('天气播报'), 'interactive: header');

assert(buildExcerpt({ msg_type: 'image', body: { content: '{}' } }) === '[图片]',   'image');
assert(buildExcerpt({ msg_type: 'audio', body: { content: '{}' } }) === '[语音]',   'audio');
assert(buildExcerpt({ msg_type: 'sticker', body: { content: '{}' } }) === '[表情包]', 'sticker');

// ── Test 3: registry (offline, wiki-bots.json) ────────────────────────────────
console.log('\n[smoke] Test 3: registry (offline)');
const { BotRegistry } = require('../lib/registry');
const { makeLogger }  = require('../lib/utils');
const reg = new BotRegistry(makeLogger(false, '/tmp'));

const wikiBots = reg._loadWikiBots();
assert(Object.keys(wikiBots).length >= 7,                     `wiki bots >= 7 (got ${Object.keys(wikiBots).length})`);

reg._buildLookups(wikiBots);

assert(reg.findByOpenId('ou_a2c019095b2cb92317d70fe00ce88153')?.name === '小K', 'findByOpenId: 小K');
assert(reg.findByAppId('cli_a944488992b8dcdb')?.name === 'rr',                   'findByAppId: rr');
assert(reg.findByAlias('小k')?.name === '小K',                                   'findByAlias: 小k → 小K');
assert(reg.findByAlias('minigg')?.name === 'miniGG',                              'findByAlias: minigg');
assert(reg.getSelfOpenId() === 'ou_ad91b8a9d73f076c5502fe4f7842625c',            'selfOpenId: Jarvis');
assert(reg.isSelfSender('ou_ad91b8a9d73f076c5502fe4f7842625c') === true,         'isSelfSender: Jarvis');
assert(reg.isBotSender('ou_a2c019095b2cb92317d70fe00ce88153') === true,          'isBotSender: 小K');
assert(reg.isNonAIBot('ou_eb59766df9a9221df47a132052d8946d') === true,           'isNonAIBot: CRS告警');
assert(reg.isNonAIBot('ou_a2c019095b2cb92317d70fe00ce88153') === false,          'isNonAIBot=false: 小K');
assert(reg.getAtTargets().every(b => !b.isSelf && !!b.openId),                   'getAtTargets: no self, all have openId');
assert(reg.getDisplayBots().every(b => !b.isSelf && !b.external && b.isAI),      'getDisplayBots: no self/external');
assert(reg.getDisplayBots().find(b => b.name === 'CRS告警') === undefined,       'getDisplayBots: no CRS alert');

// ── Test 4: storm-guard ───────────────────────────────────────────────────────
console.log('\n[smoke] Test 4: storm-guard');
const { StormGuard } = require('../lib/storm-guard');
const sg = new StormGuard({ stormThreshold: 2, logger: { info:()=>{}, warn:()=>{}, debug:()=>{} } });

const r1 = sg.recordBotInbound('chat_test');
assert(!r1.drop,                              'inbound 1: no drop');
const r2 = sg.recordBotInbound('chat_test');
assert(r2.drop && r2.reason === 'storm_debounce', 'inbound 2: storm triggered');
const r3 = sg.recordBotInbound('chat_test');
assert(!r3.drop,                              'inbound 3: counter reset after storm');

// 熔断测试
const sg2 = new StormGuard({
  stormThreshold: 99,
  circuitBreakerMaxOutbound: 3,
  circuitBreakerSilenceMs  : 1000,
  logger: { info:()=>{}, warn:()=>{}, debug:()=>{} },
});
sg2.recordOutbound('c'); sg2.recordOutbound('c'); sg2.recordOutbound('c');
const rb = sg2.recordBotInbound('c');
assert(rb.drop && rb.reason === 'circuit_open', 'circuit breaker: opens after maxOutbound');

// ── Test 5: @ 替换逻辑（模拟 message_sending）────────────────────────────────
console.log('\n[smoke] Test 5: @ replacement logic');
const { escapeRegExp: esc } = require('../lib/utils');

function testReplace(content, alias, openId, name) {
  const pattern = new RegExp(`@${esc(alias)}(?=[^a-zA-Z0-9\u4e00-\u9fff]|$)`, 'g');
  return content.replace(pattern, `<at user_id="${openId}">${name}</at>`);
}

const r5a = testReplace('@小K 你觉得呢？', '小K', 'ou_TEST', '小K');
assert(r5a.includes('<at user_id="ou_TEST">小K</at>'), '@ replace: match with trailing 你');

const r5b = testReplace('小K之前说过', '小K', 'ou_TEST', '小K');
assert(!r5b.includes('<at'), '@ replace: no match without @');

const r5c = testReplace('@rr 你好', 'rr', 'ou_RR', 'rr');
assert(r5c.includes('<at user_id="ou_RR">rr</at>'), '@ replace: rr');

const r5d = testReplace('@小K2 错误的', '小K', 'ou_TEST', '小K');
assert(!r5d.includes('<at'), '@ replace: no match for @小K2 (boundary check)');

// ── 结果汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} smoke tests passed\n`);
  process.exit(0);
} else {
  console.error(`❌ ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
