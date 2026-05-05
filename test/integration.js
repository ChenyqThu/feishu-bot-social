'use strict';

/**
 * 集成测试：用 fake `api` 对象 register() 插件，验证三个 hook 的关键路径
 *   - 不连真实飞书 API（stub global.fetch）
 *   - 覆盖 message_received / before_prompt_build / message_sending 关键路径
 *
 * OpenClaw 5.x 已停用通用 inbound_claim hook，本插件改用 message_received。
 *
 * 运行：node test/integration.js
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else            { console.error(`  ❌ ${label}`); failed++; }
}

// ── 通用：构造 fake api ───────────────────────────────────────────────────────

function makeFakeApi(pluginConfig = {}) {
  const handlers = new Map();
  return {
    pluginConfig,
    config: {
      // 提供 channels.feishu.accounts 模拟 startup register 阶段
      channels: {
        feishu: {
          domain: 'feishu',
          accounts: {
            default: { appId: 'cli_test', appSecret: 'secret_test' },
          },
        },
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on(name, cb) { handlers.set(name, cb); },
    _trigger(name, ...args) {
      const cb = handlers.get(name);
      if (!cb) throw new Error(`hook ${name} not registered`);
      return cb(...args);
    },
    _has(name) { return handlers.has(name); },
  };
}

const realFetch = global.fetch;
global.fetch = async () => { throw new Error('fetch blocked in integration test'); };

// 重要：require 一次后是缓存的，SHARED 模块状态会跨多次 register 复用
delete require.cache[require.resolve('../index.js')];
const plugin = require('../index.js');
const fakeApi = makeFakeApi({
  contextGroups: ['oc_test_group'],
  contextMessageCount: 20,
  stormThreshold: 99,
  circuitBreakerMaxOutbound: 99,
  alertReceiverOpenId: 'ou_admin_test',
  debugLog: false,
});
plugin.register(fakeApi);

async function main() {
  // 等待异步 registry.load 完成
  await new Promise(r => setTimeout(r, 100));

  // ── Test 1: 三个 hook 全部注册 ───────────────────────────────────────────
  console.log('\n[integration] Test 1: hooks registered');
  assert(fakeApi._has('message_received'),    'message_received registered');
  assert(fakeApi._has('before_prompt_build'), 'before_prompt_build registered');
  assert(fakeApi._has('message_sending'),     'message_sending registered');
  assert(!fakeApi._has('inbound_claim'),      'inbound_claim NOT registered (deprecated in OpenClaw 5.x)');

  // ── Test 2a: message_received — chat: 前缀（实际 OpenClaw 形态）─────────
  // 源码验证：toPluginMessageContext 不 strip 前缀，conversationId 形如 'chat:oc_xxx'
  console.log('\n[integration] Test 2a: message_received with chat: prefix → ok');
  const r2a = fakeApi._trigger('message_received', { content: '@Jarvis hi' }, {
    channelId: 'feishu',
    conversationId: 'chat:oc_test_group', // ← 实际 OpenClaw 传入的形态
    senderId: 'ou_a2c019095b2cb92317d70fe00ce88153', // 小K openId
    sessionKey: 'agent:jarvis:feishu:group:oc_test_group',
  });
  assert(r2a === undefined, 'chat: prefix path → undefined (fire-and-forget)');

  // ── Test 2b: message_received — 无前缀（向后兼容）──────────────────────
  console.log('\n[integration] Test 2b: message_received no prefix → ok');
  const r2 = fakeApi._trigger('message_received', { content: '@Jarvis hi' }, {
    channelId: 'feishu',
    conversationId: 'oc_test_group',
    senderId: 'cli_a92d7a5bb57a1bc4',
    sessionKey: 'agent:jarvis:feishu:group:oc_test_group',
  });
  assert(r2 === undefined, 'no prefix → undefined (fire-and-forget)');

  // ── Test 3: message_received — 人类 sender → 不抛错 ────────────────────
  console.log('\n[integration] Test 3: message_received human sender → ok');
  const r3 = fakeApi._trigger('message_received', { content: '在群里发消息' }, {
    channelId: 'feishu',
    conversationId: 'oc_test_group',
    senderId: 'ou_8d1ce0fa1d435070ed695baeabe25adc', // Lucien (human/owner)
  });
  assert(r3 === undefined, 'human sender → undefined (no-op)');

  // ── Test 4: message_received — 非目标群 → 不处理 ───────────────────────
  console.log('\n[integration] Test 4: message_received non-target group → ok');
  const r4 = fakeApi._trigger('message_received', { content: 'x' }, {
    channelId: 'feishu',
    conversationId: 'oc_other_group',
    senderId: 'cli_a92d7a5bb57a1bc4',
  });
  assert(r4 === undefined, 'non-target group → undefined');

  // ── Test 5: message_received — DM (ou_xxx) → 不处理 ────────────────────
  console.log('\n[integration] Test 5: message_received DM → ok');
  const r5 = fakeApi._trigger('message_received', { content: 'dm' }, {
    channelId: 'feishu',
    conversationId: 'ou_dm_y',
    senderId: 'ou_8d1ce0fa1d435070ed695baeabe25adc',
  });
  assert(r5 === undefined, 'DM (ou_*) → undefined');

  // ── Test 6: message_received — 非 feishu → 不处理 ─────────────────────
  console.log('\n[integration] Test 6: message_received non-feishu → ok');
  const r6 = fakeApi._trigger('message_received', { content: 'x' }, {
    channelId: 'wechat',
    conversationId: 'oc_test_group',
    senderId: 'x',
  });
  assert(r6 === undefined, 'non-feishu channel → undefined');

  // ── Test 7: before_prompt_build — active-memory sub-session → skip ─────
  console.log('\n[integration] Test 7: active-memory sub-session skipped');
  const r7 = await fakeApi._trigger('before_prompt_build', {}, {
    channelId: 'oc_test_group:active-memory:sub1',
    sessionKey: 'agent:jarvis:feishu:group:oc_test_group:active-memory:sub1',
  });
  assert(r7 === undefined, 'active-memory sub-session → skip');

  // ── Test 8: before_prompt_build — non-target → undefined ───────────────
  console.log('\n[integration] Test 8: before_prompt_build non-target → undefined');
  const r8 = await fakeApi._trigger('before_prompt_build', {}, {
    channelId: 'oc_other_group',
    sessionKey: 'agent:jarvis:feishu:group:oc_other_group',
  });
  assert(r8 === undefined, 'non-target group → undefined');

  // ── Test 9: message_sending — 含 @小K + chat: 前缀 → 转 <at> ────────────
  console.log('\n[integration] Test 9: @alias → <at> with chat: prefix (Bug H path)');
  const r9 = fakeApi._trigger('message_sending', { content: '@小K 你好啊' }, {
    channelId: 'feishu',
    accountId: 'default',
    conversationId: 'chat:oc_test_group', // 实际 OpenClaw 形态
  });
  assert(r9?.content?.includes('<at user_id="ou_a2c019095b2cb92317d70fe00ce88153">小K</at>'),
         '@小K replaced with <at>');

  // ── Test 10: message_sending — 非 feishu channel → undefined ──────────
  console.log('\n[integration] Test 10: message_sending non-feishu → undefined');
  const r10 = fakeApi._trigger('message_sending', { content: '@小K hi' }, {
    channelId: 'wechat',
    conversationId: 'oc_test_group',
  });
  assert(r10 === undefined, 'non-feishu channel → undefined');

  // ── Test 11: message_sending — 无 @alias → undefined ─────────────────
  console.log('\n[integration] Test 11: message_sending no alias → undefined');
  const r11 = fakeApi._trigger('message_sending', { content: '普通消息无 alias' }, {
    channelId: 'feishu',
    conversationId: 'oc_test_group',
  });
  assert(r11 === undefined, 'no @alias → undefined (no modification)');

  // ── 结果汇总 ────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  if (failed === 0) {
    console.log(`✅ All ${passed} integration tests passed\n`);
    global.fetch = realFetch;
    process.exit(0);
  } else {
    console.error(`❌ ${failed} failed, ${passed} passed\n`);
    global.fetch = realFetch;
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
