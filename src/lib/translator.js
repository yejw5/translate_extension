/**
 * 大模型调用与译文解析（只在 Service Worker 中运行，API Key 不会暴露给页面）。
 */
import { langEnName } from './langs.js';

/** 把 endpoint 规范化成可直接请求的 URL */
export function buildUrl(settings) {
  const raw = (settings.endpoint || '').trim().replace(/\s/g, '');
  if (!raw) throw new Error('未配置服务端地址（Endpoint）');

  if (settings.apiStyle === 'gemini') {
    const base = raw.replace(/\/+$/, '').replace(/\/models.*$/, '');
    return `${base}/models/${encodeURIComponent(settings.model)}:generateContent`;
  }
  if (settings.apiStyle === 'anthropic') {
    if (/\/messages$/.test(raw)) return raw;
    return raw.replace(/\/+$/, '') + '/v1/messages';
  }
  // openai 兼容：允许用户只填到 /v1 或者根地址
  if (/\/chat\/completions$/.test(raw)) return raw;
  const base = raw.replace(/\/+$/, '');
  if (/\/v\d+$/.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

function systemPrompt(settings) {
  const src = settings.sourceLang === 'auto' ? 'the detected source language' : langEnName(settings.sourceLang);
  const tgt = langEnName(settings.targetLang);
  const extra = (settings.extraPrompt || '').trim();
  return [
    `You are a professional translator. Translate every <item> from ${src} into ${tgt}.`,
    'Strict output format:',
    '- Reply with ONLY one <t id="N">…</t> block per input item, with the same ids, in the same order.',
    '- Never echo the input <item> tags, and never nest any other tag inside <t>…</t>.',
    '- No preface, no explanation, no markdown fences, no extra quotes.',
    'Translation rules:',
    `- Produce natural, fluent ${tgt}; translate meaning, not word by word.`,
    '- Keep line breaks: if an item spans several lines, output exactly the same number of lines in the same order, one translated line per original line.',
    '- Some items contain numbered inline tags like <k0>…</k0> marking links or code. Reproduce every tag exactly, with the same number, wrapped around the translated words that correspond to the tagged original words. Never add, drop, renumber or nest these tags.',
    '- Keep numbers, URLs, emails, file paths, code identifiers, and inline markup unchanged.',
    '- Keep proper nouns / product names in their original form when that is the common usage.',
    `- If an item is already in ${tgt}, output it unchanged.`,
    '- Never merge, split, drop or reorder items; an empty translation is not allowed.',
    extra ? `Additional requirements from the user: ${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function userPrompt(items) {
  return items.map((t, i) => `<item id="${i + 1}">${t}</item>`).join('\n');
}

/** 清掉模型有时会一起吐出来的包裹标签与代码围栏 */
export function cleanTranslation(text) {
  let s = String(text).replace(/\r/g, '');
  // 代码围栏
  s = s.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
  // 残留的 <item id="N"> … </item> / <t id="N"> … </t>
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/^\s*<(?:item|t)\s+id=["']?\d+["']?\s*>/i, '')
      .replace(/<\/(?:item|t)>\s*$/i, '');
  }
  // 折叠行内多余空白，但保留段内换行
  return s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** 按标签名提取 <tag id="N">…</tag>，容忍缺失的闭合标签 */
function matchTagged(content, count, tag) {
  const out = new Array(count).fill('');
  const re = new RegExp(
    `<${tag}\\s+id=["']?(\\d+)["']?\\s*>([\\s\\S]*?)(?=</${tag}>|<${tag}\\s+id=|$)`,
    'gi'
  );
  let m;
  let matched = 0;
  while ((m = re.exec(content)) !== null) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < count && !out[idx]) {
      const text = cleanTranslation(m[2]);
      if (text) {
        out[idx] = text;
        matched++;
      }
    }
  }
  return { out, matched };
}

/** 解析 <t id="N">…</t>；失败时依次回退到 <item> 标签、按行对齐 */
export function parseTranslations(content, count) {
  for (const tag of ['t', 'item']) {
    const { out, matched } = matchTagged(content, count, tag);
    if (matched > 0) return out;
  }

  const out = new Array(count).fill('');
  const cleaned = cleanTranslation(content);
  if (count === 1) {
    out[0] = cleaned;
  } else {
    // 退化处理：按非空行顺序对齐
    const lines = cleaned.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length === count) for (let i = 0; i < count; i++) out[i] = lines[i];
  }
  return out;
}

function buildRequest(settings, items) {
  const url = buildUrl(settings);
  const sys = systemPrompt(settings);
  const user = userPrompt(items);
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (settings.apiStyle === 'anthropic') {
    headers['x-api-key'] = settings.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = {
      model: settings.model,
      max_tokens: 8192,
      temperature: settings.temperature,
      system: sys,
      messages: [{ role: 'user', content: user }],
    };
  } else if (settings.apiStyle === 'gemini') {
    headers['x-goog-api-key'] = settings.apiKey;
    body = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: settings.temperature },
    };
  } else {
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    body = {
      model: settings.model,
      temperature: settings.temperature,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    };
  }
  return { url, headers, body };
}

function extractContent(settings, data) {
  if (settings.apiStyle === 'anthropic') {
    return (data.content || []).map((p) => p.text || '').join('');
  }
  if (settings.apiStyle === 'gemini') {
    const cand = (data.candidates || [])[0];
    return ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
  }
  const choice = (data.choices || [])[0];
  if (!choice) return '';
  const msg = choice.message || {};
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => p.text || '').join('');
  return msg.reasoning_content || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发一次请求（含超时与重试） */
async function requestOnce(settings, items, signal) {
  const { url, headers, body } = buildRequest(settings, items);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), settings.timeout || 60000);
  const onAbort = () => ctrl.abort(new Error('cancelled'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('返回内容不是合法 JSON：' + text.slice(0, 200));
    }
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 300));
    const content = extractContent(settings, data);
    if (!content) throw new Error('模型返回为空，请检查模型名称或配额');
    return content;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 翻译一组文本，返回译文数组（与输入等长）。
 */
export async function translateBatch(settings, items, signal) {
  if (!items.length) return [];
  const retries = Math.max(0, settings.maxRetries ?? 2);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const content = await requestOnce(settings, items, signal);
      const out = parseTranslations(content, items.length);
      const missing = out.filter((s) => !s).length;
      // 多数条目解析失败时重试一次（通常是模型没遵守格式）
      if (missing > 0 && missing === items.length) throw new Error('译文解析失败：' + content.slice(0, 200));
      return out.map((s, i) => s || items[i]);
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
      const status = e.status || 0;
      const retriable = !status || status === 429 || status >= 500;
      if (attempt === retries || !retriable) break;
      await sleep(600 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/** 配置自检：翻译一句话 */
export async function testConnection(settings) {
  const started = Date.now();
  const out = await translateBatch({ ...settings, maxRetries: 0 }, ['Hello, world! This is a connection test.']);
  return { text: out[0], ms: Date.now() - started, url: buildUrl(settings) };
}
