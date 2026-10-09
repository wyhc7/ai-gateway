// 订阅接入方案
//
// 与 templates.js 分开：模板只服务「添加平台」，订阅没有 API Token 可填，
// 凭据要建完平台才能授权或导入，混在同一张表单里只会让人以为接口格式少了个选项。
//
// 每条方案描述的是「一家订阅源的固定接法」——接入地址是常量、协议是常量，
// 用户不需要也不应该去改。模型清单一律留空：订阅上游的可用型号随版本演进，
// 写死一份必然与实际对不上，建完点「刷新」让网关自己探测或兜底。

export const SUBSCRIPTION_PLANS = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy 订阅账号（腾讯 CodeBuddy 国际版）',
    protocol: 'workbuddy-oauth',
    // 对话必须走 codebuddy.ai；计费与成长中心才是 workbuddy.ai。
    // 这两个域别对调——发错域会拿到非 JSON 的 401，报错只显示
    // "parse failed: invalid character '<'"，完全看不出是域名选错了。
    base_url: 'https://www.codebuddy.ai',
    models: [],
    // 19 个模型里有 8 个上游界面不展示但直调可用（gpt-5.6-luna/sol/terra、
    // claude-opus-5、glm-5.3、gpt-6-astra 等），清单由协议内置白名单兜底，
    // 不在这里重复维护。
    hint: '凭据从 CodeBuddy CLI 的登录态文件 workbuddy-<uid>.json 取，建完平台用「导入 Token」整份粘贴，网关自己解析 uid / realm / token。'
  }
]

export function findPlan(id) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === id) || null
}
