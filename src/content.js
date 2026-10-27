/**
 * Content Script：页面常驻入口 + 段落提取 + 对照渲染
 * 不直接接触 API Key，所有模型请求都通过 background 代理。
 */
(() => {
  if (window.__BT_LOADED__) return;
  window.__BT_LOADED__ = true;

  const ROOT_ID = 'bilingual-translate-root';
  const DONE_ATTR = 'data-bt-done';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
    'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'VIDEO',
    'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'MATH', 'MAP',
  ]);

  // 行内元素：保留在段落文本里一起翻译（代码片段由提示词要求模型原样保留）
  const INLINE_TAGS = new Set([
    'A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'SMALL', 'BIG',
    'SUB', 'SUP', 'MARK', 'ABBR', 'ACRONYM', 'CITE', 'Q', 'TIME', 'BR', 'WBR',
    'IMG', 'LABEL', 'FONT', 'BDI', 'BDO', 'DFN', 'RUBY', 'RT', 'RP', 'NOBR',
    'CODE', 'KBD', 'SAMP', 'VAR', 'TT',
  ]);

  // 译文里需要还原成真正元素的行内标签（主要是超链接，保证对照阅读时高亮一致）
  const KEEP_TAGS = new Set(['A', 'CODE', 'STRONG', 'B', 'EM', 'I', 'MARK', 'KBD', 'ABBR']);
  const MAX_KEEPS = 32;

  const LETTER_RE = /\p{L}/u;
  const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const LATIN_RE = /[A-Za-z\u00c0-\u024f]/u;
  const HTML_NS = 'http://www.w3.org/1999/xhtml';

  const state = {
    settings: null,
    phase: 'idle', // idle | running | done
    total: 0,
    done: 0,
    failed: 0,
    abort: null,
    runWrappers: [],
    observer: null,
    lastError: '',
  };

  /* ---------------------------------------------------------------- 工具 */

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { ok: false, error: err.message } : res || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });

  function ratio(text, re) {
    let letters = 0;
    let hit = 0;
    for (const ch of text) {
      if (!LETTER_RE.test(ch)) continue;
      letters++;
      if (re.test(ch)) hit++;
    }
    return letters ? hit / letters : 0;
  }

  function shouldTranslateText(text) {
    const t = text.trim();
    const { minTextLength, sourceLang, targetLang } = state.settings;
    if (t.length < Math.max(1, minTextLength)) return false;
    if (!LETTER_RE.test(t)) return false;
    if (/^[\s\p{P}\p{S}\d]+$/u.test(t)) return false;
    // 已经是目标语言则跳过（简繁互转除外）
    const zh2zh = sourceLang.startsWith('zh') && targetLang.startsWith('zh');
    if (targetLang.startsWith('zh') && !zh2zh && ratio(t, HAN_RE) > 0.6) return false;
    if (sourceLang === 'en' && ratio(t, LATIN_RE) < 0.5) return false;
    return true;
  }

  function isHidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function isOurs(el) {
    return (
      el.id === ROOT_ID ||
      (el.classList && el.classList.contains('bt-translation')) ||
      el.hasAttribute('data-bt-el')
    );
  }

  /**
   * 数学公式的根元素（MathJax 3 的 <mjx-container>、MathJax 2、KaTeX、原生 MathML）。
   * 这类元素的字形多由 CSS 生成，文本拿不到；整体当作一个不可拆的行内元素，
   * 译文里原样克隆过去。
   */
  function isMathRoot(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'MJX-CONTAINER' || tag === 'MATH') return true;
    const cl = el.classList;
    return !!cl && (cl.contains('katex') || cl.contains('MathJax') ||
      cl.contains('MathJax_CHTML') || cl.contains('MathJax_SVG'));
  }

  /** 独占一行的公式（$$…$$），不并入段落 */
  function isBlockMath(el) {
    if (el.classList && (el.classList.contains('katex-display') || el.classList.contains('MathJax_Display'))) return true;
    if (!isMathRoot(el)) return false;
    const d = el.getAttribute('display');
    return d === 'true' || d === 'block';
  }

  /** 公式的可读文本，只用来给模型提供上下文；渲染时直接克隆原元素 */
  function mathText(el) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]');
    const mml = el.tagName.toUpperCase() === 'MATH' ? el : el.querySelector('math');
    const raw = (tex || mml || el).textContent || '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  function isInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (isBlockMath(node)) return false;
    if (isMathRoot(node)) return true;
    return INLINE_TAGS.has(node.tagName.toUpperCase());
  }

  /* -------------------------------------------------------- 段落收集 */

  function collectTargets(root) {
    const out = [];
    visit(root);
    return out;

    function visit(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (isMathRoot(el) || isBlockMath(el)) return;
      if (el.namespaceURI && el.namespaceURI !== HTML_NS) return; // SVG / MathML 等
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || isOurs(el)) return;
      if (el.hasAttribute(DONE_ATTR)) return;
      if (el.isContentEditable) return;
      if (isHidden(el)) return;

      const children = Array.from(el.childNodes);
      const hasBlockChild = children.some(
        (n) => n.nodeType === Node.ELEMENT_NODE && !isInline(n)
      );
      if (!hasBlockChild) {
        const { text, keeps } = buildText(children);
        if (shouldTranslateText(stripMarkers(text))) out.push({ el, text, keeps });
        return;
      }

      // 混合节点：先把夹在块级子元素之间的行内片段打包
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const { text, keeps } = buildText(run);
        if (text.length >= 12 && shouldTranslateText(stripMarkers(text))) {
          const wrapper = document.createElement('span');
          wrapper.setAttribute('data-bt-run', '1');
          run[0].parentNode.insertBefore(wrapper, run[0]);
          run.forEach((n) => wrapper.appendChild(n));
          state.runWrappers.push(wrapper);
          out.push({ el: wrapper, text, keeps });
        }
        run = [];
      };
      for (const node of children) {
        if (isInline(node)) {
          if (node.nodeType !== Node.ELEMENT_NODE || !isOurs(node)) run.push(node);
        } else {
          flush();
          if (node.nodeType === Node.ELEMENT_NODE) visit(node);
        }
      }
      flush();
    }
  }

  /**
   * 提取待翻译文本：
   * - <br> 变成真正的换行（文本节点内部的换行只是 HTML 排版，折叠成空格）
   * - 超链接等行内元素包成 <kN>…</kN> 标记，译文里按标记还原成真正的元素
   * - 被跳过的标签（script/pre 等）内容丢弃
   * 返回 { text, keeps }，keeps[N] 是第 N 个标记对应的原始元素。
   */
  function buildText(nodes) {
    const keeps = [];
    const preserve = state.settings.preserveInline !== false;
    let s = '';
    for (const n of nodes) s += walk(n, false);
    return { text: normalize(s), keeps };

    function walk(node, insideKeep) {
      if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toUpperCase();
      if (tag === 'BR') return '\n';
      if (isMathRoot(node)) {
        const tex = mathText(node) || '*';
        if (!preserve || insideKeep || keeps.length >= MAX_KEEPS) return tex;
        const idx = keeps.length;
        keeps.push(node);
        return `<k${idx}>${tex}</k${idx}>`;
      }
      if (SKIP_TAGS.has(tag) || isOurs(node)) return '';

      const isKeep =
        preserve && !insideKeep && KEEP_TAGS.has(tag) && keeps.length < MAX_KEEPS;
      let inner = '';
      for (const child of node.childNodes) inner += walk(child, insideKeep || isKeep);
      if (isKeep && inner.trim()) {
        const idx = keeps.length;
        keeps.push(node);
        return `<k${idx}>${inner}</k${idx}>`;
      }
      return inner;
    }
  }

  /** 去掉 <kN> 标记；容忍模型写成 <k0 或 </k0 这类缺角的形式 */
  function stripMarkers(text) {
    return text.replace(/<\/?k\d+>?/g, '');
  }

  /** 折叠行内空白，保留换行结构 */
  function normalize(text) {
    return text
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ------------------------------------------------------------ 渲染 */

  /**
   * 找出原文字体风格的来源元素：按字符数统计每个文本容器（忽略 <a>/<code> 等
   * 行内标记元素），取占比最大的那个。用于让译文和原文字号/颜色保持一致。
   */
  function styleSourceFor(el) {
    const counts = new Map();
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const len = (child.nodeValue || '').trim().length;
          if (!len) continue;
          let p = child.parentElement;
          while (p && p !== el && KEEP_TAGS.has(p.tagName.toUpperCase())) p = p.parentElement;
          if (!p) p = el;
          counts.set(p, (counts.get(p) || 0) + len);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toUpperCase();
          if (isOurs(child) || SKIP_TAGS.has(tag) || isMathRoot(child)) continue;
          walk(child);
        }
      }
    })(el);

    let best = el;
    let bestLen = 0;
    for (const [node, len] of counts) {
      if (len > bestLen) {
        best = node;
        bestLen = len;
      }
    }
    return best;
  }

  /** 把原文的字号、颜色、透明度等照搬到译文上（注释类小字不会被渲染成正文） */
  function matchStyle(span, el) {
    const src = styleSourceFor(el);
    if (!src || src === el) return;
    let base;
    let from;
    try {
      base = getComputedStyle(el);
      from = getComputedStyle(src);
    } catch {
      return;
    }
    // 计算值在浏览器里一定是 px；拿不到 px 就不动字号
    const px = (v) => (/px\s*$/.test(v || '') ? parseFloat(v) : NaN);
    const baseSize = px(base.fontSize);
    const srcSize = px(from.fontSize);
    if (baseSize > 0 && srcSize > 0) {
      const ratio = srcSize / baseSize;
      if (Math.abs(ratio - 1) > 0.02) span.style.fontSize = ratio.toFixed(3) + 'em';
    }
    if (from.color && from.color !== base.color) span.style.color = from.color;
    if (from.fontWeight !== base.fontWeight) span.style.fontWeight = from.fontWeight;
    if (from.fontStyle !== base.fontStyle) span.style.fontStyle = from.fontStyle;
    if (from.fontFamily !== base.fontFamily) span.style.fontFamily = from.fontFamily;
    const op = parseFloat(from.opacity);
    if (op >= 0.1 && op < 1) span.style.opacity = from.opacity;
  }

  function placeholder(el) {
    const span = document.createElement('span');
    span.className = 'bt-translation';
    span.setAttribute('data-bt-el', '1');
    span.setAttribute('data-bt-state', 'loading');
    span.setAttribute('dir', 'auto');
    span.textContent = '翻译中…';
    matchStyle(span, el);
    el.setAttribute(DONE_ATTR, '1');
    el.appendChild(span);
    return span;
  }

  function fill(span, text, keeps, source) {
    span.setAttribute('data-bt-state', 'ok');
    span.textContent = '';
    keeps = keeps || [];
    // 模型偶尔会把 <k2> 改写成 <tunib-ai> 这种自造标签名；记下没出现过的编号，按顺序补位
    const used = new Set();
    for (const m of text.matchAll(/<k(\d+)>[\s\S]*?<\/k\1>/g)) used.add(Number(m[1]));
    const ctx = {
      keeps,
      spare: keeps.map((_, i) => i).filter((i) => !used.has(i)),
      source: source || '',
    };
    text.split('\n').forEach((line, i) => {
      if (i) span.appendChild(document.createElement('br'));
      appendRich(span, line, ctx);
    });
  }

  /** 原文里本来就有的尖括号文本（比如讲 HTML 的文章里的 "<div>"）不当成标记 */
  function inSource(ctx, name) {
    return ctx.source.includes('<' + name + '>') || ctx.source.includes('</' + name + '>');
  }

  /** 去掉所有标记：<kN> 以及原文里没有的、模型自造的标签 */
  function stripTags(s, ctx) {
    return stripMarkers(
      s.replace(/<\/?([A-Za-z][\w.-]*)>/g, (all, name) => (inSource(ctx, name) ? all : ''))
    );
  }

  /** 把 <kN>…</kN> 还原成克隆的原始元素（保留 href/class，因此高亮与原文一致） */
  function appendRich(parent, line, ctx) {
    const re = /<([A-Za-z][\w.-]*)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let m;
    const plain = (s) => {
      const t = stripTags(s, ctx);
      if (t) parent.appendChild(document.createTextNode(t));
    };
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      let idx = -1;
      if (/^k\d+$/.test(name)) {
        idx = Number(name.slice(1));
      } else if (inSource(ctx, name)) {
        // 原文自带的字面量标签：跳过开标签继续往后找
        re.lastIndex = m.index + name.length + 2;
        continue;
      } else if (ctx.spare.length) {
        idx = ctx.spare.shift();
      }
      if (m.index > last) plain(line.slice(last, m.index));
      const src = ctx.keeps[idx];
      const inner = stripTags(m[2], ctx);
      if (src && isMathRoot(src)) {
        // 公式整体克隆，忽略模型返回的内容
        const clone = src.cloneNode(true);
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        parent.appendChild(clone);
      } else if (src && inner) {
        const clone = src.cloneNode(false);
        clone.removeAttribute('id');
        clone.textContent = inner;
        parent.appendChild(clone);
      } else {
        plain(m[2]);
      }
      last = re.lastIndex;
    }
    if (last < line.length) plain(line.slice(last));
  }

  /** 兜底清理：模型偶尔会把输入的包裹标签一起吐回来 */
  function sanitize(text) {
    let s = String(text || '').replace(/\r/g, '');
    for (let i = 0; i < 2; i++) {
      s = s
        .replace(/^\s*<(?:item|t)\s+id=["']?\d+["']?\s*>/i, '')
        .replace(/<\/(?:item|t)>\s*$/i, '');
    }
    // 少数模型会把文本重新转义成 HTML 实体
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, '&');
    return normalize(s);
  }

  function failPlaceholder(span, message) {
    span.setAttribute('data-bt-state', 'error');
    span.textContent = '⚠ 翻译失败：' + message;
    span.title = message;
  }

  function restore() {
    document.querySelectorAll('.bt-translation').forEach((n) => n.remove());
    document.querySelectorAll('[' + DONE_ATTR + ']').forEach((n) => n.removeAttribute(DONE_ATTR));
    for (const w of state.runWrappers) {
      if (!w.parentNode) continue;
      while (w.firstChild) w.parentNode.insertBefore(w.firstChild, w);
      w.remove();
    }
    state.runWrappers = [];
    stopObserver();
    state.phase = 'idle';
    state.total = state.done = state.failed = 0;
    state.lastError = '';
    ui.update();
  }

  /* ---------------------------------------------------------- 批处理 */

  function makeBatches(targets) {
    const { batchChars, batchSize } = state.settings;
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const t of targets) {
      if (cur.length && (chars + t.text.length > batchChars || cur.length >= batchSize)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(t);
      chars += t.text.length;
    }
    if (cur.length) batches.push(cur);

    // 让当前视口附近的内容优先翻译
    const idx = batches.findIndex((b) => {
      const r = b[0].el.getBoundingClientRect();
      return r.bottom > 0;
    });
    if (idx > 0) return batches.slice(idx).concat(batches.slice(0, idx));
    return batches;
  }

  async function runPool(jobs, limit) {
    let i = 0;
    const workers = new Array(Math.max(1, Math.min(limit, jobs.length))).fill(0).map(async () => {
      while (i < jobs.length) {
        if (state.abort && state.abort.aborted) return;
        const job = jobs[i++];
        await job();
      }
    });
    await Promise.all(workers);
  }

  async function translateTargets(targets) {
    if (!targets.length) return;
    const batches = makeBatches(targets);
    state.total += targets.length;
    ui.update();

    const jobs = batches.map((batch) => async () => {
      const spans = batch.map(({ el }) => placeholder(el));
      const res = await send({
        type: 'bt:translate',
        items: batch.map((b) => b.text),
        sourceLang: state.settings.sourceLang,
        targetLang: state.settings.targetLang,
      });
      if (state.abort && state.abort.aborted) return;
      if (res.ok) {
        res.translations.forEach((t, k) => {
          const text = sanitize(t);
          if (!text || text === batch[k].text) {
            spans[k].remove();
            batch[k].el.removeAttribute(DONE_ATTR);
          } else {
            fill(spans[k], text, batch[k].keeps, batch[k].text);
          }
        });
        state.done += batch.length;
      } else {
        state.failed += batch.length;
        state.lastError = res.error || '未知错误';
        spans.forEach((s) => failPlaceholder(s, state.lastError));
      }
      ui.update();
    });

    await runPool(jobs, state.settings.concurrency);
  }

  async function translatePage() {
    if (state.phase === 'running') return;
    await loadSettings();
    state.abort = { aborted: false };
    state.phase = 'running';
    state.total = state.done = state.failed = 0;
    state.lastError = '';
    ui.update();

    const targets = collectTargets(document.body);
    if (!targets.length) {
      state.phase = 'done';
      state.lastError = '页面上没有找到需要翻译的文字';
      ui.update();
      return;
    }
    await translateTargets(targets);
    if (state.abort.aborted) return;
    state.phase = 'done';
    ui.update();
    if (state.settings.autoTranslateNew) startObserver();
  }

  /* ------------------------------------------------- 动态内容监听 */

  function startObserver() {
    if (state.observer) return;
    let timer = null;
    const pending = new Set();
    state.observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          if (isOurs(n) || SKIP_TAGS.has(n.tagName.toUpperCase())) continue;
          // 译文里还原出来的超链接等克隆元素不参与翻译
          if (n.closest && n.closest('.bt-translation')) continue;
          pending.add(n);
        }
      }
      if (!pending.size) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const nodes = Array.from(pending).filter((n) => n.isConnected);
        pending.clear();
        if (state.phase !== 'done' || !nodes.length) return;
        const targets = [];
        for (const n of nodes) targets.push(...collectTargets(n));
        if (targets.length) {
          state.phase = 'running';
          ui.update();
          await translateTargets(targets);
          state.phase = 'done';
          ui.update();
        }
      }, 900);
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  /* -------------------------------------------------------------- UI */

  const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { position: fixed; z-index: 2147483600; display: flex; align-items: flex-end; gap: 8px; }
  .wrap[data-pos="bottom-right"] { right: 20px; bottom: 20px; flex-direction: row-reverse; }
  .wrap[data-pos="bottom-left"]  { left: 20px;  bottom: 20px; }
  .wrap[data-pos="top-right"]    { right: 20px; top: 20px; flex-direction: row-reverse; align-items: flex-start; }
  .wrap[data-pos="top-left"]     { left: 20px;  top: 20px; align-items: flex-start; }

  .fab { width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
         background: #2f6fed; color: #fff; font-size: 16px; font-weight: 600; line-height: 1;
         box-shadow: 0 4px 14px rgba(0,0,0,.28); transition: transform .15s, background .15s;
         display: flex; align-items: center; justify-content: center; opacity: .92; }
  .fab:hover { transform: scale(1.06); opacity: 1; }
  .fab[data-phase="running"] { background: #c88914; }
  .fab[data-phase="done"] { background: #1f9254; }
  .fab .pct { font-size: 11px; font-weight: 700; }

  .panel { width: 250px; background: #fff; color: #1f2328; border-radius: 12px; padding: 12px;
           box-shadow: 0 8px 30px rgba(0,0,0,.22); font-size: 13px; display: none; }
  .panel.open { display: block; }
  .title { font-weight: 700; font-size: 13px; margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center; }
  .title a { color:#2f6fed; text-decoration:none; font-weight:500; font-size:12px; cursor:pointer; }
  .row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .row label { width: 48px; color: #656d76; flex: none; }
  select { flex: 1; padding: 4px 6px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff;
           color: inherit; font-size: 12px; max-width: 100%; }
  .btns { display: flex; gap: 6px; margin-top: 10px; }
  button.act { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa;
               cursor: pointer; font-size: 12px; color: #1f2328; }
  button.act.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button.act:hover { filter: brightness(.96); }
  .status { margin-top: 8px; font-size: 11px; color: #656d76; line-height: 1.5; word-break: break-word; max-height: 76px; overflow: auto; }
  .status.err { color: #cf222e; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #22272e; color: #cdd9e5; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    select, button.act { background: #2d333b; border-color: #444c56; color: #cdd9e5; }
    button.act.primary { background: #2f6fed; border-color: #2f6fed; color:#fff; }
    .row label, .status { color: #8b949e; }
  }`;

  const ui = {
    host: null,
    shadow: null,
    els: {},

    mount() {
      if (this.host || !document.body) return;
      const host = document.createElement('div');
      host.id = ROOT_ID;
      host.setAttribute('data-bt-el', '1');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);

      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('data-pos', state.settings.buttonPosition);
      wrap.innerHTML = `
        <button class="fab" title="对照翻译（Alt+T）">译</button>
        <div class="panel">
          <div class="title"><span>对照翻译</span><a class="settings">设置</a></div>
          <div class="row"><label>原文</label><select class="src"></select></div>
          <div class="row"><label>译文</label><select class="tgt"></select></div>
          <div class="btns">
            <button class="act primary go">翻译本页</button>
            <button class="act back">恢复原文</button>
          </div>
          <div class="status"></div>
        </div>`;
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);

      this.host = host;
      this.shadow = shadow;
      this.els = {
        wrap,
        fab: shadow.querySelector('.fab'),
        panel: shadow.querySelector('.panel'),
        src: shadow.querySelector('.src'),
        tgt: shadow.querySelector('.tgt'),
        go: shadow.querySelector('.go'),
        back: shadow.querySelector('.back'),
        status: shadow.querySelector('.status'),
        settings: shadow.querySelector('.settings'),
      };

      fillLangSelects(this.els.src, this.els.tgt);

      let hideTimer = null;
      const open = () => {
        clearTimeout(hideTimer);
        this.els.panel.classList.add('open');
      };
      const close = () => {
        hideTimer = setTimeout(() => this.els.panel.classList.remove('open'), 350);
      };
      wrap.addEventListener('mouseenter', open);
      wrap.addEventListener('mouseleave', close);

      this.els.fab.addEventListener('click', () => toggle());
      this.els.go.addEventListener('click', () => {
        restoreIfNeeded();
        translatePage();
      });
      this.els.back.addEventListener('click', () => restore());
      this.els.settings.addEventListener('click', () => send({ type: 'bt:openOptions' }));

      const onLangChange = async () => {
        state.settings.sourceLang = this.els.src.value;
        state.settings.targetLang = this.els.tgt.value;
        await send({
          type: 'bt:saveSettings',
          patch: { sourceLang: this.els.src.value, targetLang: this.els.tgt.value },
        });
      };
      this.els.src.addEventListener('change', onLangChange);
      this.els.tgt.addEventListener('change', onLangChange);

      this.update();
    },

    unmount() {
      if (this.host) {
        this.host.remove();
        this.host = null;
      }
    },

    update() {
      if (!this.host) return;
      const { phase, total, done, failed } = state;
      const fab = this.els.fab;
      fab.setAttribute('data-phase', phase);
      this.els.wrap.setAttribute('data-pos', state.settings.buttonPosition);
      if (phase === 'running') {
        const pct = total ? Math.floor(((done + failed) / total) * 100) : 0;
        fab.innerHTML = `<span class="pct">${pct}%</span>`;
        fab.title = `翻译中 ${done + failed}/${total}`;
      } else if (phase === 'done') {
        fab.textContent = '原';
        fab.title = '点击恢复原文（Alt+T）';
      } else {
        fab.textContent = '译';
        fab.title = '点击翻译本页（Alt+T）';
      }
      this.els.src.value = state.settings.sourceLang;
      this.els.tgt.value = state.settings.targetLang;

      let msg = '';
      if (phase === 'running') msg = `已完成 ${done + failed}/${total} 段`;
      else if (phase === 'done') msg = `共 ${total} 段，成功 ${done} 段${failed ? `，失败 ${failed} 段` : ''}`;
      if (state.lastError) msg += (msg ? '\n' : '') + state.lastError;
      this.els.status.textContent = msg;
      this.els.status.classList.toggle('err', Boolean(state.lastError));
    },
  };

  function fillLangSelects(srcSel, tgtSel) {
    const langs = state.languages || [];
    srcSel.innerHTML = '';
    tgtSel.innerHTML = '';
    for (const l of langs) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      srcSel.appendChild(o);
      if (l.code !== 'auto') {
        const o2 = o.cloneNode(true);
        tgtSel.appendChild(o2);
      }
    }
    srcSel.value = state.settings.sourceLang;
    tgtSel.value = state.settings.targetLang;
  }

  function restoreIfNeeded() {
    if (state.phase !== 'idle') restore();
  }

  function toggle() {
    if (state.phase === 'running') {
      state.abort.aborted = true;
      // 清掉尚未返回的占位
      document.querySelectorAll('.bt-translation[data-bt-state="loading"]').forEach((s) => {
        const host = s.parentElement;
        s.remove();
        if (host) host.removeAttribute(DONE_ATTR);
      });
      state.phase = state.done ? 'done' : 'idle';
      state.lastError = '已取消';
      ui.update();
      return;
    }
    if (state.phase === 'done') restore();
    else translatePage();
  }

  /* ------------------------------------------------------------ 启动 */

  async function loadSettings() {
    const res = await send({ type: 'bt:init' });
    if (res.ok) {
      state.settings = res.settings;
      state.languages = res.languages;
    } else if (!state.settings) {
      throw new Error(res.error);
    }
    return state.settings;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (!state.settings) {
        try {
          await loadSettings();
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
          return;
        }
      }
      switch (msg.type) {
        case 'bt:ping':
          sendResponse({ ok: true });
          break;
        case 'bt:toggle':
          toggle();
          sendResponse({ ok: true, phase: state.phase });
          break;
        case 'bt:translate':
          if (msg.payload) {
            if (msg.payload.sourceLang) state.settings.sourceLang = msg.payload.sourceLang;
            if (msg.payload.targetLang) state.settings.targetLang = msg.payload.targetLang;
          }
          restoreIfNeeded();
          translatePage();
          sendResponse({ ok: true });
          break;
        case 'bt:restore':
          restore();
          sendResponse({ ok: true });
          break;
        case 'bt:status':
          sendResponse({
            ok: true,
            phase: state.phase,
            total: state.total,
            done: state.done,
            failed: state.failed,
            error: state.lastError,
          });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown' });
      }
    })();
    return true;
  });

  function applyDisplayStyle() {
    const root = document.documentElement;
    root.classList.remove('bt-style-border', 'bt-style-plain', 'bt-style-dashed', 'bt-style-card');
    root.classList.add('bt-style-' + (state.settings.displayStyle || 'border'));
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    await loadSettings();
    applyDisplayStyle();
    if (state.settings.showButton) ui.mount();
    else ui.unmount();
    ui.update();
  });

  (async () => {
    try {
      await loadSettings();
    } catch (e) {
      console.warn('[对照翻译] 初始化失败：', e.message);
      return;
    }
    applyDisplayStyle();
    if (state.settings.showButton) ui.mount();

    const hosts = state.settings.autoTranslateHosts || [];
    if (hosts.some((h) => h && location.hostname.endsWith(h))) {
      translatePage();
    }
  })();
})();
