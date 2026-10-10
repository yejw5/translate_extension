/**
 * background.js 的消息层测试：用内存 stub 替换 chrome.* 与 fetch。
 * 运行：node --test test/background.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const sync = {};
const local = {};
const store = (s) => ({
  async get(keys) {
    if (keys == null) return { ...s };
    if (typeof keys === 'string') return keys in s ? { [keys]: s[keys] } : {};
    const out = {};
    for (const k of keys) if (k in s) out[k] = s[k];
    return out;
  },
  async set(obj) {
    Object.assign(s, obj);
  },
  async remove(keys) {
    for (const k of [].concat(keys)) delete s[k];
  },
});

const listeners = [];
let fetchCalls = [];

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener: (f) => listeners.push(f) },
    openOptionsPage() {},
    lastError: null,
  },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query: async () => [], sendMessage: async () => ({ ok: true }) },
  scripting: { insertCSS: async () => {}, executeScript: async () => {} },
  storage: { sync: store(sync), local: store(local), onChanged: { addListener() {} } },
};

globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  const body = JSON.parse(opts.body);
  const n = (body.messages[1].content.match(/<item id="\d+">/g) || []).length;
  const content = Array.from({ length: n }, (_, i) => `<t id="${i + 1}">译文${i + 1}</t>`).join('\n');
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
};

const call = (msg) => new Promise((r) => listeners[0](msg, {}, r));

before(async () => {
  sync.settings = {
    apiStyle: 'openai',
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    sourceLang: 'en',
    targetLang: 'zh-Hans',
    temperature: 0.2,
    timeout: 5000,
    maxRetries: 1,
    useCache: true,
    extraPrompt: '术语：token 译为「令牌」',
  };
  local.apiKey = 'sk-test-123';
  await import('../src/background.js');
});

test('bt:translate 会补全 URL、带上鉴权头并拼好提示词', async () => {
  fetchCalls = [];
  const res = await call({ type: 'bt:translate', items: ['Hello there', 'Second line'] });
  assert.deepEqual(res.translations, ['译文1', '译文2']);

  const { url, opts } = fetchCalls[0];
  assert.equal(url, 'https://api.example.com/v1/chat/completions');
  assert.equal(opts.headers.Authorization, 'Bearer sk-test-123');
  const body = JSON.parse(opts.body);
  assert.equal(body.model, 'test-model');
  assert.match(body.messages[0].content, /令牌/);
  assert.match(body.messages[1].content, /<item id="2">Second line<\/item>/);
});

test('相同内容第二次请求命中缓存', async () => {
  fetchCalls = [];
  const res = await call({ type: 'bt:translate', items: ['Hello there', 'Second line'] });
  assert.equal(res.fromCache, 2);
  assert.equal(fetchCalls.length, 0);
});

test('HTTP 错误原样回传给页面', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid api key"}}',
  });
  const res = await call({ type: 'bt:translate', items: ['A brand new sentence'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /401/);
  globalThis.fetch = saved;
});

test('配置不完整时给出可读提示', async () => {
  sync.settings = { ...sync.settings, model: '' };
  const res = await call({ type: 'bt:translate', items: ['x'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /模型名称/);
  sync.settings = { ...sync.settings, model: 'test-model' };
});

test('bt:init 不会把 API Key 交给页面', async () => {
  const res = await call({ type: 'bt:init' });
  assert.equal('apiKey' in res.settings, false);
  assert.equal(res.settings.hasApiKey, true);
  assert.ok(res.languages.length > 10);
});

test('缓存可清空', async () => {
  await call({ type: 'bt:cacheClear' });
  const stats = await call({ type: 'bt:cacheStats' });
  assert.equal(stats.count, 0);
});
