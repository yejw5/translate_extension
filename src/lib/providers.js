/**
 * 常见大模型服务的预设。
 * apiStyle 决定请求体/鉴权头的构造方式：
 *   - openai    : OpenAI Chat Completions 兼容协议（绝大多数国内外服务都支持）
 *   - anthropic : Anthropic Messages 协议
 *   - gemini    : Google Gemini generateContent 协议
 */
export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    apiStyle: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    apiStyle: 'openai',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    docs: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    apiStyle: 'openai',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    docs: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    apiStyle: 'openai',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    apiStyle: 'openai',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    docs: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    apiStyle: 'openai',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    docs: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiStyle: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.0-flash-001',
    docs: 'https://openrouter.ai/keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    apiStyle: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-latest',
    docs: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    apiStyle: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    docs: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'ollama',
    label: 'Ollama 本地模型',
    apiStyle: 'openai',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
    docs: 'https://ollama.com/',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    apiStyle: 'openai',
    endpoint: '',
    model: '',
    docs: '',
  },
];

export function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}
