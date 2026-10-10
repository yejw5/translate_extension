import { DEFAULT_SETTINGS, getSettings, saveSettings } from './lib/config.js';
import { LANGUAGES } from './lib/langs.js';
import { PROVIDER_PRESETS, findPreset } from './lib/providers.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['endpoint', 'model', 'extraPrompt'];
const SELECT_FIELDS = ['apiStyle', 'sourceLang', 'targetLang', 'displayStyle', 'buttonPosition'];
const NUM_FIELDS = ['concurrency', 'batchSize', 'batchChars', 'temperature', 'timeout', 'maxRetries', 'minTextLength'];
const BOOL_FIELDS = ['showButton', 'preserveInline', 'autoTranslateNew', 'useCache'];

function fillLanguages() {
  for (const l of LANGUAGES) {
    const o = new Option(`${l.name} (${l.en})`, l.code);
    $('sourceLang').add(o);
    if (l.code !== 'auto') $('targetLang').add(new Option(`${l.name} (${l.en})`, l.code));
  }
}

function fillProviders() {
  for (const p of PROVIDER_PRESETS) $('provider').add(new Option(p.label, p.id));
}

function applyPreset(id) {
  const p = findPreset(id);
  if (p.id === 'custom') {
    $('providerHint').textContent = '自定义：填入任何兼容 OpenAI 协议的服务地址。';
    return;
  }
  $('apiStyle').value = p.apiStyle;
  $('endpoint').value = p.endpoint;
  $('model').value = p.model;
  $('providerHint').innerHTML = p.docs
    ? `已填入 ${p.label} 的默认地址与模型。密钥获取：<a href="${p.docs}" target="_blank" rel="noreferrer">${p.docs}</a>`
    : `已填入 ${p.label} 的默认地址与模型。`;
}

function collect() {
  const patch = {};
  for (const k of TEXT_FIELDS) patch[k] = $(k).value.trim();
  for (const k of SELECT_FIELDS) patch[k] = $(k).value;
  for (const k of NUM_FIELDS) {
    const v = Number($(k).value);
    patch[k] = Number.isFinite(v) ? v : DEFAULT_SETTINGS[k];
  }
  for (const k of BOOL_FIELDS) patch[k] = $(k).checked;
  patch.provider = $('provider').value;
  patch.apiKey = $('apiKey').value.trim();
  patch.autoTranslateHosts = $('autoTranslateHosts')
    .value.split('\n')
    .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  return patch;
}

function render(s) {
  for (const k of [...TEXT_FIELDS, ...SELECT_FIELDS, ...NUM_FIELDS]) $(k).value = s[k];
  for (const k of BOOL_FIELDS) $(k).checked = Boolean(s[k]);
  $('provider').value = s.provider || 'custom';
  $('apiKey').value = s.apiKey || '';
  $('autoTranslateHosts').value = (s.autoTranslateHosts || []).join('\n');
}

function flash(el, text, cls) {
  el.textContent = text;
  el.className = 'result ' + (cls || '');
}

async function refreshCacheInfo() {
  const res = await chrome.runtime.sendMessage({ type: 'bt:cacheStats' });
  if (res && res.ok) {
    flash($('cacheInfo'), `当前缓存 ${res.count} 条，约 ${(res.bytes / 1024).toFixed(1)} KB`);
  }
}

async function init() {
  fillLanguages();
  fillProviders();
  render(await getSettings());
  refreshCacheInfo();

  $('provider').addEventListener('change', (e) => applyPreset(e.target.value));

  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('save').addEventListener('click', async () => {
    await saveSettings(collect());
    flash($('saveResult'), '已保存 ✓', 'ok');
    setTimeout(() => flash($('saveResult'), ''), 2500);
  });

  $('reset').addEventListener('click', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS });
    render(await getSettings());
    flash($('saveResult'), '已恢复默认设置（API Key 未清除）', 'ok');
  });

  $('test').addEventListener('click', async () => {
    flash($('testResult'), '测试中…');
    const res = await chrome.runtime.sendMessage({ type: 'bt:test', settings: collect() });
    if (res && res.ok) flash($('testResult'), `成功（${res.ms}ms）：${res.text}`, 'ok');
    else flash($('testResult'), '失败：' + ((res && res.error) || '未知错误'), 'err');
  });

  $('clearCache').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'bt:cacheClear' });
    flash($('cacheInfo'), res && res.ok ? '缓存已清空' : '清空失败', res && res.ok ? 'ok' : 'err');
  });
}

init();
