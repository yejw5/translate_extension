/**
 * Service Worker：
 * - 保管 API Key，代理所有大模型请求（页面脚本拿不到密钥）
 * - 缓存命中/写入
 * - 快捷键、右键菜单、content script 注入
 */
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './lib/config.js';
import { LANGUAGES, TARGET_LANGUAGES } from './lib/langs.js';
import { translateBatch, testConnection } from './lib/translator.js';
import { cacheKey, cacheGetMany, cacheSetMany, cacheClear, cacheStats } from './lib/cache.js';

const MENU_ID = 'bt-translate-page';

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.create(
    { id: MENU_ID, title: '对照翻译：翻译本页 / 恢复原文', contexts: ['page', 'selection'] },
    () => void chrome.runtime.lastError
  );
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab && tab.id != null) toggleTab(tab.id);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) toggleTab(tab.id);
});

/** content script 可能未注入（扩展刚安装/刷新），需要时补注入 */
async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'bt:ping' });
    if (pong && pong.ok) return true;
  } catch {
    /* 未注入 */
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    return true;
  } catch (e) {
    console.warn('[对照翻译] 无法注入脚本：', e.message);
    return false;
  }
}

async function toggleTab(tabId) {
  if (!(await ensureContent(tabId))) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'bt:toggle' });
  } catch (e) {
    console.warn('[对照翻译]', e.message);
  }
}

/** 处理一次批量翻译：先查缓存，未命中的才请求模型 */
async function handleTranslate(payload) {
  const settings = await getSettings();
  const merged = {
    ...settings,
    sourceLang: payload.sourceLang || settings.sourceLang,
    targetLang: payload.targetLang || settings.targetLang,
  };
  if (!merged.endpoint) throw new Error('尚未配置服务端地址，请先打开设置页完成配置');
  if (!merged.apiKey && merged.apiStyle !== 'openai') throw new Error('尚未配置 API Key，请先打开设置页完成配置');
  if (!merged.model) throw new Error('尚未配置模型名称，请先打开设置页完成配置');

  const items = payload.items || [];
  const result = new Array(items.length).fill(null);

  const keys = items.map((text) =>
    cacheKey({ text, model: merged.model, sourceLang: merged.sourceLang, targetLang: merged.targetLang })
  );
  if (merged.useCache) {
    const cached = await cacheGetMany([...new Set(keys)]);
    keys.forEach((k, i) => {
      if (typeof cached[k] === 'string') result[i] = cached[k];
    });
  }

  const missIdx = result.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  if (missIdx.length) {
    const out = await translateBatch(merged, missIdx.map((i) => items[i]));
    const toCache = {};
    missIdx.forEach((origIdx, k) => {
      result[origIdx] = out[k];
      if (merged.useCache && out[k]) toCache[keys[origIdx]] = out[k];
    });
    if (Object.keys(toCache).length) {
      cacheSetMany(toCache).catch(() => {});
    }
  }
  return { translations: result, fromCache: items.length - missIdx.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'bt:init': {
          const s = await getSettings();
          const { apiKey, ...safe } = s;
          sendResponse({
            ok: true,
            settings: { ...safe, hasApiKey: Boolean(apiKey) },
            languages: LANGUAGES,
            targetLanguages: TARGET_LANGUAGES,
          });
          break;
        }
        case 'bt:translate': {
          const data = await handleTranslate(msg);
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'bt:test': {
          const s = await getSettings();
          const data = await testConnection({ ...DEFAULT_SETTINGS, ...s, ...(msg.settings || {}) });
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'bt:saveSettings': {
          await saveSettings(msg.patch || {});
          sendResponse({ ok: true });
          break;
        }
        case 'bt:cacheStats': {
          sendResponse({ ok: true, ...(await cacheStats()) });
          break;
        }
        case 'bt:cacheClear': {
          sendResponse({ ok: true, removed: await cacheClear() });
          break;
        }
        case 'bt:openOptions': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case 'bt:tabAction': {
          const tabId = msg.tabId;
          if (!(await ensureContent(tabId))) throw new Error('当前页面不允许注入脚本（如 Chrome 商店、设置页）');
          const res = await chrome.tabs.sendMessage(tabId, { type: msg.action, payload: msg.payload });
          sendResponse({ ok: true, result: res });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // 异步响应
});
