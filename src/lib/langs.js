/**
 * 支持的语言列表与语言名称。
 * code 为传给大模型的语言标识，name 用于界面展示。
 */
export const LANGUAGES = [
  { code: 'auto', name: '自动检测', en: 'Auto detect' },
  { code: 'zh-Hans', name: '简体中文', en: 'Simplified Chinese' },
  { code: 'zh-Hant', name: '繁體中文', en: 'Traditional Chinese' },
  { code: 'en', name: '英语', en: 'English' },
  { code: 'ja', name: '日语', en: 'Japanese' },
  { code: 'ko', name: '韩语', en: 'Korean' },
  { code: 'fr', name: '法语', en: 'French' },
  { code: 'de', name: '德语', en: 'German' },
  { code: 'es', name: '西班牙语', en: 'Spanish' },
  { code: 'pt', name: '葡萄牙语', en: 'Portuguese' },
  { code: 'ru', name: '俄语', en: 'Russian' },
  { code: 'it', name: '意大利语', en: 'Italian' },
  { code: 'ar', name: '阿拉伯语', en: 'Arabic' },
  { code: 'hi', name: '印地语', en: 'Hindi' },
  { code: 'th', name: '泰语', en: 'Thai' },
  { code: 'vi', name: '越南语', en: 'Vietnamese' },
  { code: 'id', name: '印尼语', en: 'Indonesian' },
  { code: 'tr', name: '土耳其语', en: 'Turkish' },
];

/** 目标语言不允许是 auto */
export const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== 'auto');

export function langEnName(code) {
  const hit = LANGUAGES.find((l) => l.code === code);
  return hit ? hit.en : code;
}

export function langName(code) {
  const hit = LANGUAGES.find((l) => l.code === code);
  return hit ? hit.name : code;
}
