/**
 * 纯逻辑单元测试（不依赖 Chrome API）
 * 运行：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, parseTranslations, cleanTranslation } from '../src/lib/translator.js';

test('buildUrl: openai 风格自动补全路径', () => {
  assert.equal(
    buildUrl({ apiStyle: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions' }),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    buildUrl({ apiStyle: 'openai', endpoint: 'https://api.deepseek.com/v1' }),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    buildUrl({ apiStyle: 'openai', endpoint: 'https://api.deepseek.com/' }),
    'https://api.deepseek.com/v1/chat/completions'
  );
});

test('buildUrl: anthropic / gemini', () => {
  assert.equal(
    buildUrl({ apiStyle: 'anthropic', endpoint: 'https://api.anthropic.com' }),
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    buildUrl({ apiStyle: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' }),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
  );
});

test('buildUrl: 空地址报错', () => {
  assert.throws(() => buildUrl({ apiStyle: 'openai', endpoint: '  ' }));
});

test('parseTranslations: 正常标签', () => {
  const out = parseTranslations('<t id="1">你好</t>\n<t id="2">世界</t>', 2);
  assert.deepEqual(out, ['你好', '世界']);
});

test('parseTranslations: 模型把输入的 <item> 标签一起吐回来', () => {
  const out = parseTranslations('<item id="1">第一段</item>\n<item id="2">第二段</item>', 2);
  assert.deepEqual(out, ['第一段', '第二段']);
});

test('parseTranslations: <t> 里套了 <item> 标签', () => {
  const out = parseTranslations('<t id="1"><item id="1">第一段</item></t>', 1);
  assert.deepEqual(out, ['第一段']);
});

test('parseTranslations: 缺少闭合标签也能对齐', () => {
  const out = parseTranslations('<t id="1">第一段\n<t id="2">第二段', 2);
  assert.deepEqual(out, ['第一段', '第二段']);
});

test('parseTranslations: 保留段内换行', () => {
  const out = parseTranslations('<t id="1">第一行\n第二行\n第三行</t>', 1);
  assert.deepEqual(out, ['第一行\n第二行\n第三行']);
});

test('cleanTranslation: 去掉代码围栏与包裹标签但保留换行', () => {
  assert.equal(cleanTranslation('```\n<item id="7">甲\n乙</item>\n```'), '甲\n乙');
  assert.equal(cleanTranslation('  行首空格   与   多余空白  '), '行首空格 与 多余空白');
});

test('parseTranslations: 乱序与多行内容', () => {
  const out = parseTranslations('<t id="2">第二段\n换行</t><t id="1">第一段</t>', 2);
  assert.deepEqual(out, ['第一段', '第二段\n换行']);
});

test('parseTranslations: 模型漏了标签时单条回退', () => {
  assert.deepEqual(parseTranslations('```\n你好世界\n```', 1), ['你好世界']);
});

test('parseTranslations: 按行回退', () => {
  assert.deepEqual(parseTranslations('第一\n第二\n第三', 3), ['第一', '第二', '第三']);
});

test('parseTranslations: 无法对齐时返回空位', () => {
  assert.deepEqual(parseTranslations('只有一行', 3), ['', '', '']);
});
