// ---------------------------------------------------------------------------
// 订阅账号接入方案
//
// 与 templates.js 分开：模板只服务「添加平台」，订阅没有 API Token 可填，
// 凭据要建完平台才能授权或导入，混在同一张表单里只会让人以为接口格式少了个选项。
// 现在独立成一份清单，配自己的入口与对话框。
//
// default_models 不参与表单预填，只有一个用途：proxy.js 的 defaultModelsFor() 拿它兜底。
// 订阅类上游没有干净的 GET /models，拉取失败时若没有这份清单，平台建完等于没法用。
//
// WorkBuddy 例外：它的上游有干净的目录端点（/v3/config + 企业端点），模型与倍率
// 一律动态抓取，所以 models 留空、不设 default_models 兜底。
// ---------------------------------------------------------------------------

// WorkBuddy 拆成两条方案，因为「国内版」和「国际版」不是同一套接入：
// 登录入口不同（国际版只认 IDE 客户端，platform=ide），落到的 realm 也不同。
// 各自一条方案，建出来的平台从名字上就分得清，模型清单也不会串。
//
// base_url 只是建平台时的默认值——真发请求时按账号自己的 X-Domain 选网关，
// 一个平台里混进另一 realm 的账号也不会发错域。
export const SUBSCRIPTION_PLANS = [
  {
    id: 'workbuddy-cn',
    name: 'WorkBuddy 国内版（腾讯 CodeBuddy）',
    protocol: 'workbuddy-oauth',
    // 国内与 WorkBuddy 全球版账号共用这个入口；账号落在哪个 realm
    // 由上游签发的 domain 决定，这里选的只是登录起点。
    base_url: 'https://copilot.tencent.com',
    region: 'cn',
    models: [],
    hint: '建完平台直接弹扫码授权，uid / realm / token 由网关自动拿到；不想扫码也可以在平台列表点「导入 Token」，把 CLI 的 workbuddy-<uid>.json 整份粘贴进去。'
  },
  {
    id: 'workbuddy-intl',
    name: 'WorkBuddy 国际版（CodeBuddy 国际）',
    protocol: 'workbuddy-oauth',
    base_url: 'https://www.codebuddy.ai',
    region: 'intl',
    models: [],
    hint: '国际版的登录入口只认 IDE 客户端，授权框里会默认选好版本；对话、签到与额度都按账号自己的 realm 路由。'
  },
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

export function findPlan(id) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === id) || null
}
