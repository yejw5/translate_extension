import { getSettings, saveSettings } from './lib/config.js';
import { LANGUAGES } from './lib/langs.js';

const $ = (id) => document.getElementById(id);
let tabId = null;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function fillLanguages(settings) {
  for (const l of LANGUAGES) {
    $('sourceLang').add(new Option(l.name, l.code));
    if (l.code !== 'auto') $('targetLang').add(new Option(l.name, l.code));
  }
  $('sourceLang').value = settings.sourceLang;
  $('targetLang').value = settings.targetLang;
  $('showButton').checked = Boolean(settings.showButton);
}

async function tabAction(action, payload) {
  const res = await chrome.runtime.sendMessage({ type: 'bt:tabAction', tabId, action, payload });
  if (!res || !res.ok) setStatus((res && res.error) || '操作失败', 'err');
  return res;
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'bt:tabAction', tabId, action: 'bt:status' });
  if (!res || !res.ok || !res.result) return;
  const r = res.result;
  if (r.phase === 'running') setStatus(`翻译中 ${r.done + r.failed}/${r.total}`);
  else if (r.phase === 'done') setStatus(`已翻译 ${r.done} 段${r.failed ? `，失败 ${r.failed} 段` : ''}`, r.failed ? 'err' : 'ok');
  else setStatus('');
  if (r.error) setStatus(r.error, 'err');
}

async function init() {
  const settings = await getSettings();
  fillLanguages(settings);

  if (!settings.apiKey && settings.apiStyle !== 'openai') {
    setStatus('尚未配置 API Key，请先打开设置页', 'err');
  } else if (!settings.endpoint || !settings.model) {
    setStatus('配置不完整，请先打开设置页', 'err');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  refreshStatus();

  const saveLangs = async () => {
    await saveSettings({ sourceLang: $('sourceLang').value, targetLang: $('targetLang').value });
  };
  $('sourceLang').addEventListener('change', saveLangs);
  $('targetLang').addEventListener('change', saveLangs);

  $('showButton').addEventListener('change', async () => {
    await saveSettings({ showButton: $('showButton').checked });
  });

  $('go').addEventListener('click', async () => {
    await saveLangs();
    setStatus('已开始翻译…');
    await tabAction('bt:translate', {
      sourceLang: $('sourceLang').value,
      targetLang: $('targetLang').value,
    });
    setTimeout(refreshStatus, 1200);
  });

  $('back').addEventListener('click', async () => {
    await tabAction('bt:restore');
    setStatus('已恢复原文');
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
