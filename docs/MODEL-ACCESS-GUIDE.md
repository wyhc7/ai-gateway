# 大模型接入 ai-gateway 总览

> ai-gateway 统一调度多种大模型。本文对比已支持的几条主流通道，告诉你在什么场景选哪条、各要什么前提。
> 详细卡见文末链接。

---

## 通道对比

| 通道 | 上游 | 鉴权 | 逆向/转换 | 代理需求 | ai-gateway 现状 |
|---|---|---|---|---|---|
| **Gemini**（Google） | `generativelanguage.googleapis.com/v1beta/openai` | **API Key**（AI Studio） | 否，官方兼容 | 仅国内需过 GFW | ✅ 内置 `gemini` 模板，零改动 |
| **Codex**（OpenAI 编程） | `chatgpt.com/backend-api/codex`（Responses API） | device-code OAuth | 网关内置 Responses 转换 | 需支持区域节点 | ✅ 内置 `codex-oauth` + 转换 |
| **网页版 ChatGPT** | `chatgpt.com/backend-api/conversation` + 图片 | access_token 直导入 | chatgpt2api 外部转换 | 需支持区域节点 | ✅ `chatgpt-web` 模板 + 组合架构 |
| 其他 OpenAI 兼容 | 各家 `/v1` | API Key | 否 | 视厂商 | ✅ `openai-chat` 协议通用 |

---

## Gemini（最省事，已内置）

官方就提供 OpenAI 兼容端点，**不需要逆向、不需要组合架构、不需要 device-code、不触发手机号**。

接入 3 步：
1. 拿 Key：https://aistudio.google.com/apikey （免费，有 gemini-2.5-flash 免费额度）
2. ai-gateway 建平台选模板 **`Google Gemini`**（base_url 已填好）
3. 填 API Key → 对话（模型用真实名如 `gemini-2.5-flash` / `gemini-2.5-pro`）

注意：
- 国内访问 `generativelanguage.googleapis.com` 走 Clash（7897）等代理；服务器配 `HTTPS_PROXY` 即可（c43acda 已支持全局代理）
- Google **无区域封禁**（不像 OpenAI 封香港/台湾/大陆），只受 GFW 影响
- 鉴权用 `Authorization: Bearer <key>`（与 ai-gateway openai-chat 协议一致 ✅）
- 模型名必须用 Gemini 真实名（`gemini-2.5-flash` 等），不能填 gpt-4o

---

## 选路指引

- **要 Google 模型、想最省事** → Gemini（内置，API Key 即可）
- **要 OpenAI 编程 / Codex 智能体** → Codex 通道（见 `CODEX-ONBOARDING.md`）
- **要 ChatGPT 对话 / 文生图 / 绕手机号** → 网页版通道（见 `CHATGPT2API-ONBOARDING.md`）
- **其他 OpenAI 兼容厂商**（DeepSeek/硅基流动/OpenRouter 等）→ 直接选对应模板或 `openai-chat` 通用协议

---

## 详细卡

- Codex 编程通道 → `CODEX-ONBOARDING.md`
- 网页/手机版 ChatGPT 通道 → `CHATGPT2API-ONBOARDING.md`
- ChatGPT 两通道深入对比 + 部署矩阵 → `CHATGPT-ACCESS-GUIDE.md`
- chatgpt2api 本机一键部署 → `scripts/deploy-chatgpt2api.bat`

## 共同风控

- Codex / chatgpt2api 均基于 ChatGPT 官网接口逆向，项目声明仅供个人学习、有封号风险 → 勿用重要/常用号
- Gemini 为官方 API，合规风险低，但注意用量与配额
