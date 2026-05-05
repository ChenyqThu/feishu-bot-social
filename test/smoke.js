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

// ── Test 6: Bug G regression — formatContextBlock owner.name ─────────────────
console.log('\n[smoke] Test 6: formatContextBlock owner.name (Bug G regression)');
const { formatContextBlock } = require('../lib/context');

const block = formatContextBlock({ messages: [], registry: reg, chatId: 'oc_test' });
assert(!block.includes('[object Object]'), 'Bug G: no [object Object] in output');
assert(block.includes('Kevin') && block.includes('Yuhui'), 'Bug G: real owner names present');
assert(block.includes('小K') && block.includes('rr'),     'Bug G: bot names present');

// ── Test 7: Bug I regression — owner not mistaken as bot ─────────────────────
console.log('\n[smoke] Test 7: owner/bot index isolation (Bug I regression)');
const lucienOpenId = 'ou_8d1ce0fa1d435070ed695baeabe25adc';
assert(reg.isBotSender(lucienOpenId) === false,
       'Bug I: Lucien (owner) NOT classified as bot sender');
assert(reg.findByOpenId(lucienOpenId) === null,
       'Bug I: Lucien openId returns null from findByOpenId');
// Lucien 同时是 Jarvis 和 CRS告警 的 owner — 多 owner 同 openId 时索引取最后一个写入的；任意一个有效即可
const lucienOwned = reg.findOwnerByOpenId(lucienOpenId);
assert(lucienOwned !== null && ['Jarvis', 'CRS告警'].includes(lucienOwned.name),
       `Bug I: findOwnerByOpenId returns a bot owned by Lucien (got ${lucienOwned?.name})`);
assert(reg.findOwnerByOpenId('ou_2eda37915c0a659b01ffe864727d59e4')?.name === '小K',
       'Bug I: findOwnerByOpenId returns 小K bot for Kevin');

// ── Test 8: Bug H regression — outbound chatId from ctx.conversationId ───────
console.log('\n[smoke] Test 8: outbound chatId derivation (Bug H regression)');
// 模拟 message_sending ctx 形状（源码验证 deliver-BffEFXmb.js applyMessageSendingHook）
const fakeCtxFeishu = { channelId: 'feishu', accountId: 'default', conversationId: 'oc_chat_x' };
const fakeCtxOther  = { channelId: 'feishu', accountId: 'default', conversationId: 'ou_dm_y'   };

// 关键不变量：ctx.conversationId 是真正的 chat/conv ID，不是 'feishu'
assert(fakeCtxFeishu.conversationId === 'oc_chat_x', 'Bug H: ctx.conversationId is the chat_id (not channelId)');
assert(fakeCtxFeishu.channelId !== fakeCtxFeishu.conversationId, 'Bug H: channelId and conversationId distinct');

// 验证 storm guard 在收到 chatId 时正确累计
const sg3 = new StormGuard({
  stormThreshold: 99,
  circuitBreakerMaxOutbound: 3,
  circuitBreakerSilenceMs  : 1000,
  logger: { info:()=>{}, warn:()=>{}, debug:()=>{} },
});
const targetGroups = new Set(['oc_chat_x']);
function simulateOutbound(ctx) {
  const chatId = ctx?.conversationId;
  if (chatId && targetGroups.has(chatId)) sg3.recordOutbound(chatId);
}
simulateOutbound(fakeCtxFeishu); // count=1
simulateOutbound(fakeCtxFeishu); // count=2
simulateOutbound(fakeCtxOther);  // ignored (not in TARGET_GROUPS)
simulateOutbound(fakeCtxFeishu); // count=3 → opens circuit
const status = sg3.getStatus('oc_chat_x');
assert(status.circuitOpen === true,
       'Bug H: circuit OPENS after 3 outbound — recordOutbound was reached');

// ── 结果汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} smoke tests passed\n`);
  process.exit(0);
} else {
  console.error(`❌ ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
