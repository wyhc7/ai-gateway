// ---------------------------------------------------------------------------
// 订阅账号接入方案
//
// 原先混在 templates.js 里，作为「添加平台」的模板出现。但订阅账号和 API 平台
// 本来就不是一回事：凭据来自设备码 OAuth 授权或导入 token，没有 API Token 可填，
// 要等平台建完才能绑定。把它塞进「添加平台」只会让人以为是接口格式少了个选项。
// 现在独立成一份清单，配自己的入口与对话框。
//
// default_models 不参与表单预填，只有一个用途：proxy.js 的 defaultModelsFor() 拿它兜底。
// 订阅类上游没有干净的 GET /models，拉取失败时若没有这份清单，平台建完等于没法用。
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_PLANS = [
  // Grok 订阅账号：凭据来自 OAuth 授权（SuperGrok / X Premium 订阅）或直接粘贴 token。
  // 两个上游任选：cli-chat-proxy.grok.com 是订阅专用，api.x.ai 是官方 API 端点（token 可能两者通用）。
  // 上游通常没有干净的 /models，default_models 作为拉取失败的兜底。
  // 注意：cli-chat-proxy 订阅通道实测只提供 grok-4.6，请求其他模型一律 402
  // personal-team-blocked:spending-limit —— 默认列表必须只写 grok-4.6，
  // 否则「刷新模型失败 → 兜底覆盖」会把手工设置冲成一批必然失败的模型名。
  { id: 'grok-oauth', name: 'Grok 订阅账号（OAuth）', protocol: 'grok-oauth', base_url: 'https://cli-chat-proxy.grok.com/v1', default_models: ['grok-4.6'] },
  { id: 'grok-oauth-api', name: 'Grok 订阅账号（api.x.ai 直连）', protocol: 'grok-oauth', base_url: 'https://api.x.ai/v1', default_models: ['grok-4', 'grok-4-fast', 'grok-4-reasoning', 'grok-4-reasoning-fast', 'grok-3', 'grok-3-fast', 'grok-3-mini-fast', 'grok-3-reasoner', 'grok-3-reasoner-fast', 'grok-2', 'grok-2-fast'] },
  // Codex 订阅账号（ChatGPT Plus / Pro / Business 附带）：走设备码 OAuth 授权，
  // 上游是 chatgpt.com/backend-api/codex 的 Responses API，网关自动做协议转换。
  // 上游没有公开的 /models，default_models 同时充当兜底列表；
  // 实际可用模型随 OpenAI 版本演进，以对话实测为准。
  { id: 'codex-oauth', name: 'Codex 订阅账号（ChatGPT Plus/Pro）', protocol: 'codex-oauth', base_url: 'https://chatgpt.com/backend-api/codex', default_models: ['gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] }
]
