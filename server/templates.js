export const TEMPLATES = [
  { id: 'openai', name: 'OpenAI', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.openai.com/v1' },
  { id: 'openai-responses', name: 'OpenAI Responses', group: 'OpenAI 兼容', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', name: 'Moonshot Kimi', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.moonshot.cn/v1' },
  { id: 'qwen', name: '阿里通义千问', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'zhipu', name: '智谱 GLM', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'gemini', name: 'Google Gemini', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'siliconflow', name: '硅基流动', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.siliconflow.cn/v1' },
  { id: 'groq', name: 'Groq', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.groq.com/openai/v1' },
  { id: 'xai', name: 'xAI', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.x.ai/v1' },
  // Grok 订阅账号：凭据来自 OAuth 授权（SuperGrok / X Premium 订阅）或直接粘贴 token。
  // 两个上游任选：cli-chat-proxy.grok.com 是订阅专用，api.x.ai 是官方 API 端点（token 可能两者通用）。
  // 上游通常没有干净的 /models，default_models 作为拉取失败的兜底。
  { id: 'grok-oauth', name: 'Grok 订阅账号（OAuth）', group: 'OAuth 订阅', protocol: 'grok-oauth', base_url: 'https://cli-chat-proxy.grok.com/v1', default_models: ['grok-4', 'grok-4-fast', 'grok-4-reasoning', 'grok-4-reasoning-fast', 'grok-3', 'grok-3-fast', 'grok-3-mini-fast', 'grok-3-reasoner', 'grok-3-reasoner-fast', 'grok-2', 'grok-2-fast'] },
  { id: 'grok-oauth-api', name: 'Grok 订阅账号（api.x.ai 直连）', group: 'OAuth 订阅', protocol: 'grok-oauth', base_url: 'https://api.x.ai/v1', default_models: ['grok-4', 'grok-4-fast', 'grok-4-reasoning', 'grok-4-reasoning-fast', 'grok-3', 'grok-3-fast', 'grok-3-mini-fast', 'grok-3-reasoner', 'grok-3-reasoner-fast', 'grok-2', 'grok-2-fast'] },
  { id: 'openrouter', name: 'OpenRouter', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', extra_headers: { 'HTTP-Referer': 'https://local.ai-gateway.dev', 'X-Title': 'AI Gateway' } },
  { id: 'volc', name: '火山方舟', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'baidu', name: '百度千帆', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://qianfan.baidubce.com/v2' },
  { id: 'hunyuan', name: '腾讯混元', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { id: 'minimax', name: 'MiniMax', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.minimax.chat/v1' },
  { id: 'stepfun', name: '阶跃星辰', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://api.stepfun.com/v1' },
  { id: 'spark', name: '讯飞星火', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://spark-api-open.xf-yun.com/v1' },
  { id: 'nvidia', name: 'NVIDIA NIM', group: 'OpenAI 兼容', protocol: 'openai-chat', base_url: 'https://integrate.api.nvidia.com/v1' },
  { id: 'ollama', name: 'Ollama 本地', group: '本地部署', protocol: 'openai-chat', base_url: 'http://localhost:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio 本地', group: '本地部署', protocol: 'openai-chat', base_url: 'http://localhost:1234/v1' },
  { id: 'vllm', name: 'vLLM 本地', group: '本地部署', protocol: 'openai-chat', base_url: 'http://localhost:8000/v1' },
  // 走官方 OpenAI 兼容端点：鉴权仍是 x-api-key，请求体无需转换即可透传。
  // 直接用原生 /v1/messages 会因缺少 max_tokens、响应结构不同而必然 400。
  { id: 'anthropic', name: 'Anthropic Claude', group: 'Anthropic 格式', protocol: 'anthropic-openai', base_url: 'https://api.anthropic.com/v1' },
  { id: 'azure', name: 'Azure OpenAI', group: '自定义调用方案', protocol: 'custom', base_url: 'https://RESOURCE_NAME.openai.azure.com/openai', auth_type: 'header', auth_header: 'api-key', auth_prefix: '', chat_path: '/deployments/DEPLOYMENT_NAME/chat/completions?api-version=2024-10-21', models_path: '/models?api-version=2024-10-21' }
]
