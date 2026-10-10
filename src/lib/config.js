/**
 * 配置读写。
 * - 普通设置放在 chrome.storage.sync（可随 Chrome 账号同步）
 * - API Key 放在 chrome.storage.local（不离开本机）
 */

export const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  apiStyle: 'openai',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-chat',

  // 默认 英文 -> 中文
  sourceLang: 'en',
  targetLang: 'zh-Hans',

  // 展示
  displayStyle: 'border', // border | plain | dashed | card
  showButton: true, // 是否显示页面常驻入口
  buttonPosition: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
  preserveInline: true, // 译文中还原超链接等行内元素

  // 性能/质量
  concurrency: 3, // 并发请求数
  batchChars: 1500, // 单次请求最多字符数
  batchSize: 8, // 单次请求最多段落数
  temperature: 0.2,
  timeout: 60000, // 单次请求超时(ms)
  maxRetries: 2,
  minTextLength: 2, // 小于该长度的文本不翻译
  useCache: true,
  autoTranslateNew: true, // 页面滚动加载的新内容自动翻译
  extraPrompt: '', // 额外的翻译要求（术语表、风格等）
  autoTranslateHosts: [], // 打开即自动翻译的域名
};

const SYNC_KEY = 'settings';
const LOCAL_KEY = 'apiKey';

export async function getSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(SYNC_KEY),
    chrome.storage.local.get(LOCAL_KEY),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(syncData[SYNC_KEY] || {}) };
  settings.apiKey = localData[LOCAL_KEY] || '';
  return settings;
}

export async function saveSettings(patch) {
  const { apiKey, ...rest } = patch;
  if (Object.keys(rest).length) {
    const cur = (await chrome.storage.sync.get(SYNC_KEY))[SYNC_KEY] || {};
    await chrome.storage.sync.set({ [SYNC_KEY]: { ...DEFAULT_SETTINGS, ...cur, ...rest } });
  }
  if (apiKey !== undefined) {
    await chrome.storage.local.set({ [LOCAL_KEY]: apiKey });
  }
}

export async function resetSettings() {
  await chrome.storage.sync.set({ [SYNC_KEY]: { ...DEFAULT_SETTINGS } });
}
