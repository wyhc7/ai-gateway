# ChatGPT 接入 ai-gateway 总览

> 把 ChatGPT 账号接入 ai-gateway 统一调度，有**两条完全不同的通道**。先选对通道，再照对应速查卡走。
> 详细卡见：
> - Codex 编程通道 → `CODEX-ONBOARDING.md`
> - 网页/手机版对话生图通道 → `CHATGPT2API-ONBOARDING.md`

---

## 两条通道一句话对比

| | Codex 通道 | 网页/手机版通道 |
|---|---|---|
| 是什么 | OpenAI **编程智能体**（Codex CLI 同款） | ChatGPT **对话 / 生图 / 联网搜索** |
| 上游 | `chatgpt.com/backend-api/codex`（Responses API） | `chatgpt.com/backend-api/conversation` + 图片接口 |
| 模型 | gpt-5.4-codex 等编程模型 | gpt-5 系文本、gpt-image-2 生图 |
| 鉴权 | **设备码 OAuth**（auth.openai.com/codex/device） | **access_token 直导入**（绕过手机号） |
| 转换层 | ai-gateway 内置（codex-responses.js） | chatgpt2api 外部（组合架构） |
| 账号要求 | ChatGPT Plus/Pro（免费号被订阅校验挡） | Plus/Team/Pro（免费号额度受限） |
| 绕过手机号 | ❌ 走 device-code 必触发手机验证 | ✅ 用已登录号抓 access_token 即可 |

## 怎么选

- **要写代码 / 自动化编程** → Codex 通道（`CODEX-ONBOARDING.md`）
- **要聊天 / 文生图 / 图编辑 / 联网搜索** → 网页版通道（`CHATGPT2API-ONBOARDING.md`）
- 两个通道**账号体系相通**（同一 ChatGPT 订阅），可同时接，互相不冲突

## 共同前提

1. **ChatGPT 订阅号**（Plus/Team/Pro 最稳；免费号能力受限）
2. **能访问 OpenAI 的代理出口**（美/日/新/韩等支持区域；香港/台湾/大陆被封）
   - 沙箱自带代理（56786）不出境，不可用
   - 本机 Clash 在 7897，需确保 OpenAI 域名走支持区域节点（直接打设备码端点实测，别信 ipinfo）

## 部署矩阵

| 组件 | 部署位置 | 说明 |
|---|---|---|
| ai-gateway | 服务器（已有）或本机 | 统一调度层，零改动接 chatgpt2api |
| chatgpt2api | **本机**（服务器/沙箱无 Docker） | 网页版通道的转换层，Docker/uv 跑 |
| Codex 授权 | 走网关 device-code 流程 | 卡手机号时换网页版通道 |

## 风控提示

- chatgpt2api / Codex 逆向均基于 ChatGPT 官网接口，项目声明仅供个人学习、有封号风险 → 勿用重要/常用号
- 免费号进入生产环境前先小流量验证额度与限流
