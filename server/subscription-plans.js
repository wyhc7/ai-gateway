// 订阅接入方案
//
// 与 templates.js 分开：模板只服务「添加平台」，订阅没有 API Token 可填，
// 凭据要建完平台才能授权或导入，混在同一张表单里只会让人以为接口格式少了个选项。
//
// 每条方案描述的是「一家订阅源的固定接法」——接入地址是常量、协议是常量，
// 用户不需要也不应该去改。模型清单一律留空：订阅上游的可用型号随版本演进，
// 写死一份必然与实际对不上，建完点「刷新」让网关自己探测或兜底。

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
  }
]

export function findPlan(id) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === id) || null
}
