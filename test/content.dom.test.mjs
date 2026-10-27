/**
 * content.js 的端到端 DOM 测试，需要 jsdom：
 *   npm i -D jsdom && node --test test/content.dom.test.mjs
 * 没装 jsdom 时自动跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  /* 未安装 */
}

const ROOT = path.join(import.meta.dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
const SAMPLE = fs.readFileSync(path.join(ROOT, 'demo/sample.html'), 'utf8');

const BASE_SETTINGS = {
  sourceLang: 'en',
  targetLang: 'zh-Hans',
  displayStyle: 'border',
  showButton: true,
  buttonPosition: 'bottom-right',
  preserveInline: true,
  concurrency: 2,
  batchChars: 1500,
  batchSize: 4,
  minTextLength: 2,
  autoTranslateNew: false,
  autoTranslateHosts: [],
};

/** 在 jsdom 里装载 content.js，并用假的 chrome.runtime 替换消息通道 */
function boot(html, settings, url = 'https://example.com/a') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  const ctx = { requests: [], listeners: [] };
  w.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        let res = { ok: true };
        if (msg.type === 'bt:init') {
          res = {
            ok: true,
            settings: { ...BASE_SETTINGS, ...settings },
            languages: [
              { code: 'auto', name: '自动检测' },
              { code: 'en', name: '英语' },
              { code: 'zh-Hans', name: '简体中文' },
            ],
          };
        } else if (msg.type === 'bt:translate') {
          ctx.requests.push(msg.items);
          res = { ok: true, translations: msg.items.map((t) => '【译】' + t) };
        }
        Promise.resolve().then(() => cb && cb(res));
      },
      onMessage: { addListener: (f) => ctx.listeners.push(f) },
    },
    storage: { onChanged: { addListener() {} } },
  };
  w.eval(CONTENT);
  ctx.window = w;
  ctx.send = (msg) => new Promise((r) => ctx.listeners[0](msg, {}, r));
  ctx.count = () => w.document.querySelectorAll('.bt-translation').length;
  return ctx;
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<\/?k\d+>/g, '');

test('对照翻译：逐段插入译文、跳过代码块与非英文段落', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(SAMPLE, {});
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(300);

  const doc = ctx.window.document;
  const spans = [...doc.querySelectorAll('.bt-translation')];
  assert.ok(spans.length >= 15, '应翻译十几个段落，实际 ' + spans.length);

  // 译文紧跟在原文元素内部，形成上下对照
  const h1 = doc.querySelector('h1');
  assert.equal(h1.lastElementChild.className, 'bt-translation');
  assert.equal(h1.lastElementChild.textContent, '【译】A Short Note on Reading Machines');

  // 代码块不翻译
  assert.equal(doc.querySelectorAll('pre .bt-translation').length, 0);

  // 纯数字段落与中文段落不翻译
  const texts = ctx.requests.flat().map(strip);
  assert.ok(!texts.some((t) => t.includes('12345')));
  assert.ok(!texts.some((t) => t.includes('这一段本来就是中文')));

  // 含行内 <code> 的段落应作为一个整体送翻，而不是被切成两半
  const whole = texts.find((t) => t.startsWith('This page exists only'));
  assert.ok(whole && whole.includes('code_identifiers'), '行内代码应保留在同一段里');

  // 分批：每批不超过 batchSize
  assert.ok(ctx.requests.every((b) => b.length <= 4));

  // 悬浮按钮存在，并挂在 Shadow DOM 里
  const host = doc.getElementById('bilingual-translate-root');
  assert.ok(host && host.shadowRoot.querySelector('.fab'));
  assert.equal(doc.documentElement.className, 'bt-style-border');
});

test('<br> 分隔的多行段落：原文有几行，译文就有几行', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(SAMPLE, {});
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(300);

  const notice = ctx.window.document.querySelector('p.notice');
  const item = ctx.requests.flat().find((t) => t.startsWith('Discussions:'));
  assert.ok(item, '多行注解段落应被提取');
  assert.equal(item.split('\n').length, 3, '<br> 应转成换行：' + JSON.stringify(item));
  assert.ok(strip(item).includes('Translations: Arabic, French, Japanese'));

  const span = notice.querySelector('.bt-translation');
  assert.equal(span.querySelectorAll('br').length, 2, '译文应渲染出对应的 <br>');
  assert.equal(span.textContent.includes('【译】Discussions:'), true);
});

test('模型吐回 <item> 包裹标签时页面上不显示标签', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot('<body><p>Wrapped output should be cleaned up.</p></body>', {});
  await tick();
  const w = ctx.window;
  const orig = w.chrome.runtime.sendMessage;
  w.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'bt:translate') {
      return void Promise.resolve().then(() =>
        cb({ ok: true, translations: ['<item id="3">包裹标签应被清掉</item>'] })
      );
    }
    return orig(msg, cb);
  };
  await ctx.send({ type: 'bt:translate' });
  await tick(200);
  assert.equal(w.document.querySelector('.bt-translation').textContent, '包裹标签应被清掉');
});

test('译文里的超链接会还原成真正的 <a>（保留 href 与 class）', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const html =
    '<body><p>See the <a href="https://example.com/doc" class="hn-link" target="_blank" id="l1">official guide</a> and <code>npm test</code> for details.</p></body>';
  const ctx = boot(html, {});
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(200);

  // 送给模型的文本里带编号标记
  const sent = ctx.requests.flat()[0];
  assert.match(sent, /<k0>official guide<\/k0>/);
  assert.match(sent, /<k1>npm test<\/k1>/);

  const span = ctx.window.document.querySelector('.bt-translation');
  const a = span.querySelector('a');
  assert.ok(a, '译文中应有真正的超链接');
  assert.equal(a.getAttribute('href'), 'https://example.com/doc');
  assert.equal(a.className, 'hn-link', '原有 class 保留，高亮样式才一致');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.hasAttribute('id'), false, '克隆元素不应复制 id');
  assert.equal(a.textContent, 'official guide');
  assert.ok(span.querySelector('code'), '行内代码同样还原');
  assert.ok(!span.textContent.includes('<k'), '页面上不应出现标记：' + span.textContent);
});

test('模型丢掉标记时退化为纯文本，不残留 <kN>', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot('<body><p>Read the <a href="https://example.com">manual</a> first.</p></body>', {});
  await tick();
  const w = ctx.window;
  const orig = w.chrome.runtime.sendMessage;
  w.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'bt:translate') {
      // 模型只还回一半标记
      return void Promise.resolve().then(() => cb({ ok: true, translations: ['先读<k0>手册</k0 。'] }));
    }
    return orig(msg, cb);
  };
  await ctx.send({ type: 'bt:translate' });
  await tick(200);
  const span = w.document.querySelector('.bt-translation');
  assert.equal(span.querySelector('a'), null);
  assert.equal(span.textContent, '先读手册 。');
});

test('MathJax 公式作为整体保留在段落里，译文里原样克隆', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  // MathJax 3 CHTML：字形由 CSS ::before 生成，只有 assistive MML 里有文本
  const mjx = (ch, display = '') =>
    `<mjx-container class="MathJax" jax="CHTML"${display}><mjx-math class="MJX-TEX"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D443 TEX-I"></mjx-c></mjx-mi></mjx-math>` +
    `<mjx-assistive-mml unselectable="on"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>${ch}</mi></math></mjx-assistive-mml></mjx-container>`;
  const html =
    `<body><ul><li>${mjx('P')} is the number of parameters in the transformer model</li></ul>` +
    `<p>The basic equation is:</p><p>${mjx('C', ' display="true"')}</p></body>`;
  const ctx = boot(html, {});
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(200);

  const sent = ctx.requests.flat();
  assert.ok(sent.includes('<k0>P</k0> is the number of parameters in the transformer model'), JSON.stringify(sent));
  const doc = ctx.window.document;
  const li = doc.querySelector('li');
  assert.equal(li.querySelector('[data-bt-run]'), null, '公式不应把段落拆开');
  const span = li.querySelector('.bt-translation');
  const clone = span.querySelector('mjx-container');
  assert.ok(clone && clone.querySelector('mjx-c.mjx-c1D443'), '译文里应有完整的公式克隆');
  // 独立成行的公式不翻译
  assert.equal(doc.querySelectorAll('p .bt-translation').length, 1);
});

test('模型把 <kN> 改写成自造标签名时，按未用编号还原超链接', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(
    '<body><p>Training uses <strong>mixed-precision</strong>, see <a href="https://nb.org/x">this notebook by tunib-ai</a>. Use <b>&lt;div&gt;</b> or the <span>&lt;em&gt;</span> tag.</p></body>',
    {}
  );
  await tick();
  const w = ctx.window;
  const orig = w.chrome.runtime.sendMessage;
  w.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'bt:translate') {
      const out = '训练使用<k0>混合精度</k0>，参见<tunib-ai>tunib-ai 的这个 notebook</tunib-ai>。用 <k2><div></k2> 或 <em> 标签。<foo>多余</foo>';
      return void Promise.resolve().then(() => cb({ ok: true, translations: [out] }));
    }
    return orig(msg, cb);
  };
  await ctx.send({ type: 'bt:translate' });
  await tick(200);
  const span = w.document.querySelector('.bt-translation');
  const a = span.querySelector('a');
  assert.ok(a, '应还原成超链接');
  assert.equal(a.getAttribute('href'), 'https://nb.org/x');
  assert.equal(a.textContent, 'tunib-ai 的这个 notebook');
  assert.equal(span.textContent, '训练使用混合精度，参见tunib-ai 的这个 notebook。用 <div> 或 <em> 标签。多余');
});

test('关闭 preserveInline 后不再发送标记', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(
    '<body><p>See the <a href="https://example.com/doc">official guide</a> for details.</p></body>',
    { preserveInline: false }
  );
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(200);
  assert.equal(ctx.requests.flat()[0], 'See the official guide for details.');
  assert.equal(ctx.window.document.querySelector('.bt-translation a'), null);
});

test('译文字体风格跟随原文（小字注释不会被渲染成正文）', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const html =
    '<body><p id="note" style="font-size:16px">' +
    '<span style="font-size:12px;color:rgb(102,102,102);opacity:0.7">Discussions: ' +
    '<a href="https://example.com" style="color:rgb(0,0,255)">Hacker News</a> and more</span></p>' +
    '<p id="body" style="font-size:16px">An ordinary body paragraph that needs no style fixing.</p></body>';
  const ctx = boot(html, {});
  await tick();
  await ctx.send({ type: 'bt:translate' });
  await tick(200);

  const note = ctx.window.document.querySelector('#note .bt-translation');
  assert.equal(parseFloat(note.style.fontSize), 0.75, '应按比例继承注释的字号');
  assert.match(note.style.fontSize, /em$/, '用 em 保持响应式');
  assert.equal(note.style.color, 'rgb(102, 102, 102)', '应继承注释的颜色而不是正文黑色');
  assert.equal(note.style.opacity, '0.7');

  // 链接自身的颜色不应被当成整段的风格来源
  assert.notEqual(note.style.color, 'rgb(0, 0, 255)');

  // 普通正文段落不加任何内联样式，继续由页面 CSS 决定
  const body = ctx.window.document.querySelector('#body .bt-translation');
  assert.equal(body.getAttribute('style'), null);
});

test('恢复原文后 DOM 与原始页面完全一致', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(SAMPLE, {});
  await tick();
  const original = new JSDOM(SAMPLE).window.document.body.innerHTML.trim();

  await ctx.send({ type: 'bt:translate' });
  await tick(300);
  assert.ok(ctx.count() > 0);

  await ctx.send({ type: 'bt:restore' });
  await tick(60);
  assert.equal(ctx.count(), 0);
  assert.equal(ctx.window.document.querySelectorAll('[data-bt-done]').length, 0);
  assert.equal(ctx.window.document.body.innerHTML.trim(), original);
});

test('域名自动翻译 + 动态内容自动翻译 + 隐藏悬浮按钮', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot(
    '<body><div id="feed"><p>The quick brown fox jumps over the lazy dog.</p></div></body>',
    { showButton: false, autoTranslateNew: true, autoTranslateHosts: ['news.example.com'], displayStyle: 'card' },
    'https://news.example.com/x'
  );
  await tick(200);
  assert.equal(ctx.count(), 1, '命中自动翻译域名时应自动开始翻译');
  assert.equal(ctx.window.document.getElementById('bilingual-translate-root'), null);
  assert.equal(ctx.window.document.documentElement.className, 'bt-style-card');

  const p = ctx.window.document.createElement('p');
  p.textContent = 'A second sentence arrives later via infinite scroll loading.';
  ctx.window.document.getElementById('feed').appendChild(p);
  await tick(1400);
  assert.equal(p.querySelector('.bt-translation').textContent, '【译】' + p.firstChild.textContent);
  assert.equal(ctx.count(), 2);
});

test('toggle 在翻译与原文之间切换', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot('<body><p>Toggle me back and forth, please.</p></body>', {});
  await tick();
  await ctx.send({ type: 'bt:toggle' });
  await tick(200);
  assert.equal(ctx.count(), 1);

  const status = await ctx.send({ type: 'bt:status' });
  assert.equal(status.phase, 'done');
  assert.equal(status.done, 1);

  await ctx.send({ type: 'bt:toggle' });
  await tick(60);
  assert.equal(ctx.count(), 0);
});

test('后端报错时在段落下方显示错误', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const ctx = boot('<body><p>This request is going to fail.</p></body>', {});
  await tick();
  // 让 bt:translate 返回失败
  const w = ctx.window;
  const orig = w.chrome.runtime.sendMessage;
  w.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'bt:translate') return void Promise.resolve().then(() => cb({ ok: false, error: 'HTTP 401' }));
    return orig(msg, cb);
  };
  await ctx.send({ type: 'bt:translate' });
  await tick(200);
  const span = w.document.querySelector('.bt-translation');
  assert.equal(span.getAttribute('data-bt-state'), 'error');
  assert.match(span.textContent, /401/);
});
