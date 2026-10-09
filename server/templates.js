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
  // ChatGPT 网页/手机版账号：经 chatgpt2api 反向代理转成 OpenAI 兼容 /v1。
  // 凭据在 chatgpt2api 侧以 access_token 导入（手机已登录号可绕过 device-code 的手机号验证），
  // 网关只做统一调度与负载均衡。chatgpt2api 默认 API 端口 3000，部署改端口时同步改 base_url。
  { id: 'chatgpt-web', name: 'ChatGPT 网页/手机版（chatgpt2api）', group: '本地中转', protocol: 'openai-chat', base_url: 'http://127.0.0.1:3000/v1', default_models: ['gpt-5', 'gpt-5-mini', 'gpt-5-1', 'gpt-5-2', 'gpt-5-3', 'gpt-5-3-mini', 'gpt-image-2'] },
  // OpenCode Zen 免费通道：免密钥（凭据就是字符串 public），无需任何外部进程，
  // 协议整形在 server/zen-lane.js 内完成（弱化工具名、强制流式、补客户端指纹头）。
  // 上游 /models 会把付费模型一并列出，因此模型列表以白名单为准，不能靠拉取决定。
  { id: 'opencode-zen', name: 'OpenCode Zen 免费通道', group: '免费通道', protocol: 'zen-free', base_url: 'https://opencode.ai/zen/v1', default_models: ['nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'longcat-2.5-preview-free', 'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free', 'big-pickle', 'space-bunny-free'] },
  // 走官方 OpenAI 兼容端点：鉴权仍是 x-api-key，请求体无需转换即可透传。
  // 直接用原生 /v1/messages 会因缺少 max_tokens、响应结构不同而必然 400。
  { id: 'anthropic', name: 'Anthropic Claude', group: 'Anthropic 格式', protocol: 'anthropic-openai', base_url: 'https://api.anthropic.com/v1' },
  { id: 'azure', name: 'Azure OpenAI', group: '自定义调用方案', protocol: 'custom', base_url: 'https://RESOURCE_NAME.openai.azure.com/openai', auth_type: 'header', auth_header: 'api-key', auth_prefix: '', chat_path: '/deployments/DEPLOYMENT_NAME/chat/completions?api-version=2024-10-21', models_path: '/models?api-version=2024-10-21' }
]
