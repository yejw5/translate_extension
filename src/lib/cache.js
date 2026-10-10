/**
 * 翻译结果缓存（chrome.storage.local），避免同一段文字反复消耗 token。
 * key = tc:<hash(model|src|tgt|text)>
 */

const PREFIX = 'tc:';
const MAX_ENTRIES = 3000;
const INDEX_KEY = 'tc_index';

/** FNV-1a 32bit，足够做缓存键 */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + '_' + str.length.toString(36);
}

export function cacheKey({ text, model, sourceLang, targetLang }) {
  return PREFIX + hash(`${model}|${sourceLang}|${targetLang}|${text}`);
}

export async function cacheGetMany(keys) {
  if (!keys.length) return {};
  const data = await chrome.storage.local.get(keys);
  return data;
}

export async function cacheSetMany(entries) {
  const keys = Object.keys(entries);
  if (!keys.length) return;
  await chrome.storage.local.set(entries);
  // 维护一个简单的插入顺序索引，超量时按先进先出淘汰
  const idx = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] || [];
  const next = idx.concat(keys);
  if (next.length > MAX_ENTRIES) {
    const drop = next.splice(0, next.length - MAX_ENTRIES);
    await chrome.storage.local.remove(drop);
  }
  await chrome.storage.local.set({ [INDEX_KEY]: next });
}

export async function cacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  keys.push(INDEX_KEY);
  await chrome.storage.local.remove(keys);
  return keys.length;
}

export async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  let count = 0;
  let bytes = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(PREFIX)) continue;
    count++;
    bytes += k.length + String(v).length;
  }
  return { count, bytes };
}
