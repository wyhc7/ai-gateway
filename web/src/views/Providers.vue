<template>
  <div>
    <div class="tool-row">
      <span class="label-micro">{{ providers.length }} 个平台</span>
      <div class="tool-actions">
        <el-button plain @click="triggerImport">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          导入
        </el-button>
        <el-button plain @click="exportProviders">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          导出
        </el-button>
        <!-- 入口先留着：订阅接入方案（订阅预设）已整体下线，等重新配好方案再接回实现。
             目前点它只会明确告知「还没有可用方案」，不弹一张空表单。 -->
        <el-button plain @click="openSubscriptionDialog">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></svg>
          添加订阅
        </el-button>
        <el-button type="primary" @click="openCreateDialog">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          添加平台
        </el-button>
      </div>
      <input ref="importInput" type="file" accept=".json" aria-label="导入平台配置" style="display: none" @change="importProviders" />
    </div>

    <div v-loading="loading" class="provider-list">
      <div v-if="!loading && providers.length === 0" class="empty-state">
        <div class="empty-mark">空</div>
        <div class="empty-title">还没有任何平台</div>
        <div class="empty-desc">点击「添加平台」，选择接口格式（OpenAI Chat / Responses / Anthropic），填入 API 地址与 Token 即可接入。<br />支持拉取模型列表、一个平台配置多个 Key，自动限流切换。</div>
        <el-button type="primary" @click="openCreateDialog">添加第一个平台</el-button>
      </div>

      <div
        v-for="p in providers"
        :key="p.id"
        class="provider-card"
        :class="{ 'is-open': expandedId === p.id }"
      >
        <!-- 卡头本身就是「展开详情」的开关，里面没有别的可聚焦元素，
             所以给它 button 语义与键盘触发；缺了这两样，收起状态下的平台
             对键盘用户就是个死结——除它之外没有任何入口能展开。 -->
        <div
          class="provider-head"
          role="button"
          tabindex="0"
          :aria-expanded="expandedId === p.id"
          @click="toggle(p)"
          @keydown.enter.prevent="toggle(p)"
          @keydown.space.prevent="toggle(p)"
        >
          <div :class="['provider-avatar', !p.enabled && 'offline']">{{ p.name.charAt(0).toUpperCase() }}</div>
          <div class="provider-info">
            <div class="name">
              {{ p.name }}
              <span class="badge badge-blue">{{ protocolLabel(p.protocol) }}</span>
              <span v-if="isCustomCallPlan(p)" class="badge badge-purple">自定义调用方案</span>
              <span :class="['badge', p.enabled ? 'badge-green' : 'badge-gray']">
                <span class="badge-dot" :class="p.enabled ? 'green' : 'gray'"></span>{{ p.enabled ? '启用' : '停用' }}
              </span>
              <span v-if="cooldownKeys(p).length > 0" class="badge badge-red">{{ cooldownKeys(p).length }} 个 Key 冷却中</span>
            </div>
            <div class="url">{{ p.base_url }}</div>
          </div>
          <div class="provider-stats">
            <div class="stat"><div class="num">{{ p.keys.length }}</div><div class="label">Key</div></div>
            <div class="stat"><div class="num">{{ p.models.length }}</div><div class="label">模型</div></div>
          </div>
          <span class="chev" :class="{ open: expandedId === p.id }">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </span>
        </div>

        <el-collapse-transition>
          <div v-show="expandedId === p.id" class="provider-expand">
            <el-row :gutter="20">
              <el-col :xs="24" :md="14">
                <div class="sub-head">
                  <span class="section-title">{{ isOAuthProvider(p) ? '订阅账号' : 'API Keys' }} · {{ p.keys.length }}</span>
                  <div class="head-actions">
                    <template v-if="isOAuthProvider(p)">
                      <el-button size="small" plain @click="openImportCredentialDialog(p)">导入 Token</el-button>
                      <el-button size="small" plain @click="openGrokAuth(p)">授权 {{ authLabel(p) }} 账号</el-button>
                    </template>
                    <el-button v-else size="small" plain @click="openAddKeyDialog(p)">添加 Key</el-button>
                  </div>
                </div>
                <div class="key-ledger">
                  <div v-if="p.keys.length === 0" class="key-empty">
                    {{ isOAuthProvider(p) ? `尚未绑定订阅账号，点击「授权 ${authLabel(p)} 账号」添加。` : '尚未配置 Key，点击右上角添加。' }}
                  </div>
                  <div
                    v-for="k in p.keys"
                    :key="k.id"
                    class="key-item"
                    :class="{ 'is-off': !k.enabled }"
                  >
                    <span class="badge-dot" :class="keyDot(k)"></span>
                    <span class="key-name">{{ k.name }}</span>
                    <template v-if="k.type === 'oauth'">
                      <span class="mask">{{ k.email || '订阅账号' }}</span>
                      <span class="badge" :class="credBadge(k)">{{ credText(k) }}</span>
                      <el-button
                        v-if="k.refresh_token_present"
                        size="small"
                        text
                        :loading="refreshingCred === k.id"
                        @click="refreshCredential(p, k)"
                      >续期</el-button>
                    </template>
                    <span v-else class="mask">{{ k.api_key }}</span>
                    <template v-if="isCooldown(k)">
                      <span class="badge badge-red">冷却 {{ cooldownText(k) }}</span>
                      <el-tooltip :content="k.last_error || '无错误信息'" placement="top">
                        <span class="badge badge-amber key-err">{{ k.last_error || '失败' }}</span>
                      </el-tooltip>
                      <el-button size="small" plain @click="resetKey(p, k)">立即恢复</el-button>
                    </template>
                    <SwitchRail v-model="k.enabled" small :label="`Key ${k.name}`" @change="toggleKey(p, k)" />
                    <el-button v-if="k.type !== 'oauth'" size="small" text @click="openEditKeyDialog(p, k)">编辑</el-button>
                    <el-button size="small" text type="danger" @click="removeKey(p, k)">删除</el-button>
                  </div>
                </div>
              </el-col>

              <el-col :xs="24" :md="10">
                <div class="sub-head">
                  <span class="section-title">模型列表 · {{ p.models.length }}</span>
                  <el-button size="small" :loading="refreshingId === p.id" @click="refreshModels(p)">
                    <svg style="margin-right: 4px" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                    刷新
                  </el-button>
                </div>
                <div v-if="p.models.length === 0" class="key-empty">模型为空，点击「刷新」自动从平台拉取。</div>
                <div v-else class="model-list">
                  <div v-for="m in p.models" :key="m.id" class="model-item">
                    <span class="model-id">{{ m.id }}</span>
                    <span class="muted">{{ m.owned_by }}</span>
                  </div>
                </div>
                <div v-if="p.models_updated_at" class="muted" style="margin-top: 8px">最近更新：{{ formatTime(p.models_updated_at) }}</div>
              </el-col>
            </el-row>

            <div class="provider-actions">
              <span class="muted" style="margin-right: auto">平台开关</span>
              <SwitchRail v-model="p.enabled" :label="`平台 ${p.name}`" @change="toggleProvider(p)" />
              <el-button size="small" @click="openEditDialog(p)">编辑平台</el-button>
              <el-popconfirm title="确定删除该平台及其所有 Key？" @confirm="removeProvider(p)">
                <template #reference>
                  <el-button size="small" plain type="danger">删除平台</el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </el-collapse-transition>
      </div>
    </div>

    <el-dialog v-model="providerDialog" :title="editingProvider ? '编辑平台' : '添加平台'" width="640px" top="5vh">
      <el-form label-position="top" style="padding-right: 6px">
        <div v-if="!editingProvider" style="margin-bottom: 18px">
          <div class="preset-label">常用平台模板（参考各平台调用方案，自动填充接口格式、鉴权与 API 地址）</div>
          <el-select v-model="presetId" placeholder="选择平台模板" clearable filterable style="width: 100%" @change="applyPreset">
            <el-option-group v-for="g in presetGroups" :key="g" :label="g">
              <el-option v-for="t in templatesInGroup(g)" :key="t.id" :label="t.name" :value="t.id" />
            </el-option-group>
          </el-select>
        </div>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="接口格式" required>
              <!-- 锁定只对「编辑已有平台」生效：它的 OAuth 凭据是按当前协议绑定的，
                   改协议等于让手上的凭据失效，还可能被误选成别的协议。
                   新建时必须放行 —— WorkBuddy 就是从这个下拉建的，选完就被锁死
                   会让人以为自己选错了。 -->
              <div v-if="editingProvider && isOAuthProtocol(providerForm.protocol)" class="protocol-locked">
                {{ protocolLabel(providerForm.protocol) }}（协议不可更改）
              </div>
              <el-select v-else v-model="providerForm.protocol" style="width: 100%" @change="onProtocolChange">
                <el-option label="OpenAI Chat" value="openai-chat" />
                <el-option label="OpenAI Responses" value="openai-responses" />
                <el-option label="Anthropic（OpenAI 兼容端点）" value="anthropic-openai" />
                <el-option label="Anthropic 原生 Messages（需转换层）" value="anthropic" />
                <el-option label="OpenCode Zen 免费通道（免凭据）" value="zen-free" />
                <el-option label="WorkBuddy 订阅（OAuth，需导入登录态文件）" value="workbuddy-oauth" />
                <el-option label="自定义调用方案" value="custom" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="平台名称" required>
              <el-input v-model="providerForm.name" placeholder="例如：OpenAI / DeepSeek" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="模型 API 地址" required>
          <el-input v-model="providerForm.base_url" placeholder="https://api.openai.com/v1（填写到版本前缀，不含 /chat/completions 等接口路径）" />
        </el-form-item>
        <!-- 订阅接入方案已下线，当前没有任何入口能创建订阅平台。这里仍保留该分支：
             编辑已有的订阅平台时要挡住下面那个 API Token 输入框——
             订阅凭据不在表单里填，走授权或导入。 -->
        <el-form-item v-if="isOAuthProtocol(providerForm.protocol)" label="订阅账号">
          <div class="oauth-hint">
            订阅账号的凭据不走 API Token，这个字段在这里填不了。保存后在平台列表里点
            「授权 {{ authLabel(providerForm) }} 账号」走网页授权，或点「导入 Token」粘贴已有凭据。
          </div>
        </el-form-item>
        <el-form-item v-else-if="isCredentiallessProtocol(providerForm.protocol)" label="凭据">
          <div class="oauth-hint">
            该通道免凭据：上游按请求头与请求体指纹放行，平台创建后即可直接使用，无需填写 API Token。
          </div>
        </el-form-item>
        <el-form-item v-else :label="editingProvider ? 'API Token（留空则保持不变）' : 'API Token'" :required="!editingProvider">
          <el-input v-model="providerForm.api_key" placeholder="请输入 API Token" show-password />
        </el-form-item>

        <el-collapse v-model="advancedOpen" style="margin-bottom: 18px; border: 1px solid var(--rule-soft); border-radius: 6px; overflow: hidden">
          <el-collapse-item name="advanced">
            <template #title>
              <span style="font-size: 13px">高级调用方案（鉴权 / 端点路径，留空 = 使用所选接口格式的默认配置）</span>
            </template>
            <div class="adv-grid">
              <el-form-item label="鉴权方式">
                <el-select v-model="providerForm.auth_type" placeholder="跟随接口格式默认" clearable style="width: 100%">
                  <el-option label="请求头（如 Authorization: Bearer）" value="header" />
                  <el-option label="URL 参数（如 ?api_key=xxx）" value="query" />
                  <el-option label="Anthropic 风格（x-api-key）" value="anthropic" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'header' || providerForm.auth_type === ''" label="鉴权 Header 名">
                <el-input v-model="providerForm.auth_header" placeholder="Authorization" />
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'header' || providerForm.auth_type === ''" label="Header 值前缀">
                <el-input v-model="providerForm.auth_prefix" placeholder="Bearer " />
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'query'" label="URL 参数名">
                <el-input v-model="providerForm.auth_query_param" placeholder="api_key" />
              </el-form-item>
              <el-form-item label="对话接口路径">
                <el-input v-model="providerForm.chat_path" placeholder="/chat/completions" />
              </el-form-item>
              <el-form-item label="模型列表路径">
                <el-input v-model="providerForm.models_path" placeholder="/models" />
              </el-form-item>
              <el-form-item label="模型列表方法">
                <el-select v-model="providerForm.models_method" placeholder="GET" clearable style="width: 100%">
                  <el-option label="GET" value="GET" />
                  <el-option label="POST" value="POST" />
                </el-select>
              </el-form-item>
            </div>
          </el-collapse-item>
        </el-collapse>

        <el-form-item label="模型名称">
          <el-input v-model="providerForm.model_names_text" type="textarea" :rows="3" placeholder="与服务商API一致，如 deepseek-chat、gpt-4o&#10;每行填写一个模型；点击「拉取列表」选择后自动填入此处" />
        </el-form-item>
        <div style="display: flex; align-items: flex-start; gap: 10px; margin-bottom: 20px">
          <el-button type="primary" plain :loading="previewing" @click="doPreview">
            <svg style="margin-right: 5px" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
            拉取列表
          </el-button>
          <span class="muted" style="font-size: 12px; line-height: 1.7; padding-top: 4px">
            <template v-if="isOAuthProtocol(providerForm.protocol)">绑定订阅账号后可点「拉取列表」；订阅上游通常没有干净的 /models，<br />拉不到就按上游文档手动填写，或建完点平台列表里的「刷新」。</template>
            <template v-else-if="isCredentiallessProtocol(providerForm.protocol)">该通道免凭据，直接点「拉取列表」即可获取可用模型（模型名称不预填，留空也行）；<br />拉取失败时按上游文档手动填写，建完后平台列表里的「刷新」同样管用。</template>
            <template v-else>输入 API Token 后可拉取可用模型列表选择，选择后填入「模型名称」；<br />拉取失败时按服务商文档手动填写。</template>
          </span>
        </div>
        <el-form-item label="自定义请求头（可选）">
          <el-input v-model="providerForm.extra_headers_text" type="textarea" :rows="2" placeholder='JSON 格式，如 {"HTTP-Referer": "https://local.ai-gateway.dev"}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="providerDialog = false">取消</el-button>
        <el-button type="primary" @click="saveProvider">保存</el-button>
      </template>
    </el-dialog>

    <!-- 添加订阅：与「添加平台」完全分开。订阅没有 API Token 可填，凭据要建完平台
         才能授权/导入，塞进同一张表单里只会让人以为接口格式少了个选项。 -->
    <el-dialog v-model="subscriptionDialog" title="添加订阅" width="600px" top="8vh" :close-on-click-modal="false">
      <div class="oauth-hint" style="margin-bottom: 18px">
        订阅账号与 API 平台是两回事：这里没有 API Token 可填。先选接入点把平台建出来，
        随后用设备码授权或「导入 Token」绑定凭据。
      </div>
      <el-form label-position="top" style="padding-right: 6px">
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="订阅接入" required>
              <el-select v-model="subForm.plan_id" placeholder="选择订阅类型" style="width: 100%" @change="applyPlan">
                <el-option v-for="p in subscriptionPlans" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="平台名称" required>
              <el-input v-model="subForm.name" placeholder="例如：WorkBuddy 订阅账号" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="模型 API 地址" required>
          <el-input v-model="subForm.base_url" :placeholder="subFormPlaceholder" />
        </el-form-item>
        <el-form-item label="模型名称">
          <el-input
            v-model="subForm.model_names_text"
            type="textarea"
            :rows="4"
            placeholder="每行一个模型；默认不预填，留空即可"
          />
          <span class="muted" style="display: block; margin-top: 6px; font-size: 12px; line-height: 1.7">
            默认模型不预填——订阅上游的可用型号随版本演进，写死一份容易与实际对不上。
            留空建完后点平台列表里的「刷新」，拉取失败时网关会回退到内置默认列表兜底。
          </span>
        </el-form-item>
      </el-form>
      <div v-if="currentPlanHint" class="oauth-hint" style="margin-top: 4px">{{ currentPlanHint }}</div>
      <template #footer>
        <el-button @click="subscriptionDialog = false">取消</el-button>
        <el-button type="primary" :loading="creatingSub" @click="createSubscription">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewDialog" title="选择可用模型" width="560px" top="12vh">
      <el-select v-model="previewSelected" multiple filterable collapse-tags collapse-tags-tooltip placeholder="搜索并选择模型，选择结果将填入「模型名称」" style="width: 100%">
        <el-option v-for="m in previewList" :key="m.id" :label="m.id" :value="m.id" />
      </el-select>
      <div class="preview-summary">
        <div class="muted" style="margin-bottom: 6px">已选 {{ previewSelected.length }} / {{ previewList.length }} 个，将填入「模型名称」：</div>
        <div v-if="previewSelected.length === 0" class="muted">未选择任何模型</div>
        <div v-else class="preview-tags">
          <el-tag v-for="id in previewSelected" :key="id" size="small" closable @close="previewSelected = previewSelected.filter((x) => x !== id)" style="margin: 2px">
            {{ id }}
          </el-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="previewDialog = false">取消</el-button>
        <el-button type="primary" :disabled="previewSelected.length === 0" @click="applyPreviewModels">填充到模型名称</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="keyDialog" :title="editingKey ? '编辑 Key' : '添加 Key'" width="480px">
      <el-form label-width="90px">
        <el-form-item label="Key 名称">
          <el-input v-model="keyForm.name" placeholder="可选，用于区分多个 Key" />
        </el-form-item>
        <el-form-item :label="editingKey ? '新 Key（留空不变）' : 'API Key'" required>
          <el-input v-model="keyForm.api_key" placeholder="sk-..." show-password />
        </el-form-item>
        <el-form-item label="启用">
          <SwitchRail v-model="keyForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="keyDialog = false">取消</el-button>
        <el-button type="primary" @click="saveKey">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="grokDialog"
      :title="`授权 ${authLabel(authProvider)} 订阅账号`"
      width="520px"
      :close-on-click-modal="false"
      @closed="closeGrokAuth"
    >
      <div v-if="!deviceFlow" class="grok-intro">
        <p v-if="isCodexProvider(authProvider)">
          用你的 ChatGPT Plus / Pro / Business 订阅账号授权，授权后这个账号的 Codex 额度即可通过网关调用。
        </p>
        <p v-else>用你的 SuperGrok / X Premium 订阅账号授权，授权后这个账号的额度即可通过网关调用。</p>
        <p class="grok-note">不需要 API Key，也不会保存你的登录密码。网关只拿到一枚可撤销的访问令牌。</p>
        <p v-if="isCodexProvider(authProvider)" class="grok-note">
          注意：需先在 ChatGPT → 设置 → 安全 中开启「允许设备码登录」（默认关闭），否则无法完成授权。
        </p>
      </div>

      <div v-else-if="deviceFlow.status === 'pending'" class="device-step">
        <div class="device-code">{{ deviceFlow.user_code }}</div>
        <p class="device-hint">
          请在浏览器打开
          <a :href="deviceFlow.verify_url" target="_blank" rel="noopener noreferrer">{{ deviceFlow.verify_url }}</a>
          ，输入上面的验证码完成授权。
        </p>
        <div class="device-actions">
          <el-button size="small" plain @click="copyCode">复制验证码</el-button>
          <el-button v-if="deviceFlow.verify_url_complete" size="small" text @click="openVerifyPage">
            直接打开验证页
          </el-button>
        </div>
        <p class="device-status">
          等待授权确认……页面会自动检查，无需手动刷新。
        </p>
      </div>

      <div v-else-if="deviceFlow.status === 'done'" class="device-done">
        <p>授权成功，账号已绑定到该平台。</p>
      </div>

      <div v-else class="device-error">
        <p>{{ deviceFlow.error || '授权失败' }}</p>
      </div>

      <template #footer>
        <el-button @click="grokDialog = false">{{ deviceFlow?.status === 'done' ? '完成' : '取消' }}</el-button>
        <el-button v-if="!deviceFlow" type="primary" :loading="startingAuth" @click="startGrokAuth">
          开始授权
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importDialog" :title="`导入 ${authLabel(importProvider)} 账号 Token`" width="520px" :close-on-click-modal="false">
      <div class="grok-intro">
        <p v-if="isWorkbuddyProvider(importProvider)">
          粘贴 CodeBuddy CLI 的登录态文件 <code>workbuddy-&lt;uid&gt;.json</code> 的完整内容。
          uid、realm、token 五个字段网关自己解析，不用你去文件里翻——少填一个 realm，
          请求会被发到错误的域上，只返回一个非 JSON 的 401，从报错完全看不出来。
        </p>
        <p v-else-if="isCodexProvider(importProvider)">
          粘贴 ~/.codex/auth.json 里的凭据（access_token 和可选的 refresh_token、account_id），网关直接当 Bearer 转发到上游。account_id 在 Codex 上游的 ChatGPT-Account-Id 头里要用，务必填对。
        </p>
        <p v-else>粘贴商城/工具提供的 Grok 订阅账号 Token（access_token 或 sso_token），网关直接把它当 Bearer 转发到上游，无需浏览器授权。</p>
        <p v-if="!isWorkbuddyProvider(importProvider)" class="grok-note">不填 refresh_token 时按长期有效处理；填了的话可以点账号旁的「续期」刷新。</p>
      </div>
      <el-form :label-width="isWorkbuddyProvider(importProvider) ? '100px' : '130px'">
        <el-form-item label="账号名称">
          <el-input v-model="importForm.name" :placeholder="`可选，如 ${authLabel(importProvider)}-01`" />
        </el-form-item>
        <template v-if="isWorkbuddyProvider(importProvider)">
          <el-form-item label="登录态文件" required>
            <el-input
              v-model="importForm.access_token"
              type="textarea"
              :rows="10"
              placeholder='{"auth":{"accessToken":"...","refreshToken":"...","domain":"workbuddy.ai"},"account":{"uid":"..."}}'
            />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="access_token / sso_token" required>
            <el-input v-model="importForm.access_token" placeholder="eyJ0eXAiOi...（或以 . 分隔的会话票据）" show-password />
          </el-form-item>
          <el-form-item label="refresh_token（可选）">
            <el-input v-model="importForm.refresh_token" placeholder="有就填，填了才能自动续期" show-password />
          </el-form-item>
          <el-form-item v-if="isCodexProvider(importProvider)" label="account_id">
            <el-input v-model="importForm.account_id" placeholder="Codex 上游需要，如 acct_xxxx 或 openai 账号 ID" />
          </el-form-item>
          <el-form-item label="有效时长（秒）">
            <el-input v-model="importForm.expires_in" placeholder="留空 = 长期有效；如 21600（6 小时）" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="importDialog = false">取消</el-button>
        <el-button type="primary" :loading="importingCred" @click="saveImportCredential">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import SwitchRail from '../components/SwitchRail.vue'

const providers = ref([])
const loading = ref(false)
const expandedId = ref(null)
const refreshingId = ref(null)
const now = ref(Date.now())
const importInput = ref(null)

const providerDialog = ref(false)
const editingProvider = ref(null)
const advancedOpen = ref([])
const emptyForm = () => ({
  protocol: 'openai-chat',
  name: '',
  base_url: '',
  api_key: '',
  model_names_text: '',
  extra_headers_text: '',
  auth_type: '',
  auth_header: '',
  auth_prefix: '',
  auth_query_param: '',
  chat_path: '',
  models_path: '',
  models_method: ''
})
const providerForm = ref(emptyForm())
const previewing = ref(false)
const previewDialog = ref(false)
const previewList = ref([])
const previewSelected = ref([])

const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-openai': 'Anthropic（OpenAI 兼容）',
  'grok-oauth': 'Grok 订阅（OAuth）',
  'codex-oauth': 'Codex 订阅（OAuth）',
  'workbuddy-oauth': 'WorkBuddy 订阅（OAuth）',
  'zen-free': 'OpenCode Zen 免费通道',
  anthropic: 'Anthropic 原生',
  custom: '自定义'
}

function protocolLabel(proto) {
  return PROTOCOL_LABELS[proto] || 'OpenAI Chat'
}

function isCustomCallPlan(p) {
  return p.auth_type || p.auth_header || p.auth_prefix || p.auth_query_param || p.chat_path || p.models_path || p.models_method
}

const presetId = ref('')
const presets = ref([])
const presetGroups = computed(() => [...new Set(presets.value.map((t) => t.group))])

function templatesInGroup(group) {
  return presets.value.filter((t) => t.group === group)
}

async function loadTemplates() {
  try {
    const data = await api.getTemplates()
    presets.value = data.templates || []
  } catch {
    presets.value = []
  }
}

function applyPreset(id) {
  const t = presets.value.find((x) => x.id === id)
  if (!t) return
  providerForm.value.protocol = t.protocol || 'openai-chat'
  providerForm.value.base_url = t.base_url || ''
  providerForm.value.auth_type = t.auth_type || ''
  providerForm.value.auth_header = t.auth_header || ''
  providerForm.value.auth_prefix = t.auth_prefix !== undefined ? t.auth_prefix : ''
  providerForm.value.auth_query_param = t.auth_query_param || ''
  providerForm.value.chat_path = t.chat_path || ''
  providerForm.value.models_path = t.models_path || ''
  providerForm.value.models_method = t.models_method || ''
  providerForm.value.extra_headers_text = t.extra_headers ? JSON.stringify(t.extra_headers, null, 2) : ''
  if (!providerForm.value.name) providerForm.value.name = t.name
  // 模型一律不预填，模板自带的 default_models 不参与这张表单。
  // 写死一份默认清单有两个毛病：随上游版本演进很快过期，还会盖掉用户自己填的；
  // 且同一协议下各家厂商模型毫无交集，曾经正是它把 ChatGPT 的模型列表套到了
  // DeepSeek / 通义 / Gemini 平台上。
  // 需要默认清单的平台（订阅、免凭据通道）靠 refreshModels 兜底拿——那是拉取失败时
  // 才发生的事，不是创建时偷偷塞进去。
  if (t.auth_type || t.chat_path || t.models_path) advancedOpen.value = ['advanced']
}

function onProtocolChange() {
  if (providerForm.value.protocol !== 'custom') {
    providerForm.value.auth_type = ''
    providerForm.value.auth_header = ''
    providerForm.value.auth_prefix = ''
    providerForm.value.auth_query_param = ''
    providerForm.value.chat_path = ''
    providerForm.value.models_path = ''
    providerForm.value.models_method = ''
  }
  // 切到订阅类协议时清掉残留的 API Token：这类平台凭据靠授权/导入，
  // 留着既会在提交时被丢弃，又让用户误以为凭据已经填好了
  if (isOAuthProtocol(providerForm.value.protocol)) {
    providerForm.value.api_key = ''
  }
}

const keyDialog = ref(false)
const editingKey = ref(null)
const keyForm = ref({ name: '', api_key: '', enabled: true })
const keyOwner = ref(null)

let timer = null

function toggle(p) {
  expandedId.value = expandedId.value === p.id ? null : p.id
}

function isCooldown(k) {
  return k.cooldown_until && k.cooldown_until > now.value
}

function cooldownKeys(p) {
  return p.keys.filter(isCooldown)
}

function keyDot(k) {
  if (!k.enabled) return 'gray'
  if (isCooldown(k)) return 'red'
  return 'green'
}

function cooldownText(k) {
  const ms = k.cooldown_until - now.value
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s >= 60) return `${Math.ceil(s / 60)} 分钟`
  return `${s} 秒`
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN')
}

async function load() {
  loading.value = true
  try {
    providers.value = await api.getProviders()
  } catch (e) {
    ElMessage.error(e?.message || '加载平台列表失败')
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  editingProvider.value = null
  advancedOpen.value = []
  providerForm.value = emptyForm()
  providerDialog.value = true
}

function openEditDialog(p) {
  editingProvider.value = p
  advancedOpen.value = []
  providerForm.value = {
    protocol: p.protocol || 'openai-chat',
    name: p.name,
    base_url: p.base_url,
    api_key: '',
    model_names_text: (p.models || []).map((m) => m.id).join('\n'),
    extra_headers_text: JSON.stringify(p.extra_headers || {}, null, 2),
    auth_type: p.auth_type || '',
    auth_header: p.auth_header || '',
    auth_prefix: p.auth_prefix !== undefined ? p.auth_prefix : '',
    auth_query_param: p.auth_query_param || '',
    chat_path: p.chat_path || '',
    models_path: p.models_path || '',
    models_method: p.models_method || ''
  }
  providerDialog.value = true
}

async function saveProvider() {
  if (!providerForm.value.name || !providerForm.value.base_url) {
    return ElMessage.warning('平台名称和模型 API 地址为必填项')
  }
  // 订阅类平台没有静态 API Token 可言，凭据要创建后走 OAuth 授权或导入；
  // 免凭据通道（OpenCode Zen）凭据是固定的公共放行，表单里压根没有这个输入框。
  // 两者都得放行——否则表单把字段藏了、提交时却要求填，用户对着空白表单无从下手。
  if (!editingProvider.value && !providerForm.value.api_key
    && !isOAuthProtocol(providerForm.value.protocol)
    && !isCredentiallessProtocol(providerForm.value.protocol)) {
    return ElMessage.warning('请输入 API Token')
  }
  let extra = {}
  if (providerForm.value.extra_headers_text.trim()) {
    try {
      extra = JSON.parse(providerForm.value.extra_headers_text)
    } catch {
      return ElMessage.warning('自定义请求头必须是合法 JSON')
    }
  }
  const model_names = providerForm.value.model_names_text.split('\n').map((s) => s.trim()).filter(Boolean)
  const payload = {
    name: providerForm.value.name,
    base_url: providerForm.value.base_url,
    protocol: providerForm.value.protocol,
    extra_headers: extra,
    model_names
  }
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'models_path', 'models_method']) {
    // 始终提交（含空字符串）：空值 = 清空自定义配置、回退到协议默认
    payload[field] = providerForm.value[field] || ''
  }
  // 订阅类平台不提交静态 API Token：否则后端会当普通 Key 存进去，
  // 平台下冒出一个既非 OAuth 凭据、也调不通的静态 Key
  if (!editingProvider.value && providerForm.value.api_key && !isOAuthProtocol(providerForm.value.protocol)) {
    payload.api_key = providerForm.value.api_key
  }
  try {
    if (editingProvider.value) {
      await api.updateProvider(editingProvider.value.id, payload)
      ElMessage.success('平台已更新')
    } else {
      await api.createProvider(payload)
      ElMessage.success('平台已添加')
    }
    providerDialog.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '保存平台失败')
  }
}

function parseExtraFromForm() {
  if (!providerForm.value.extra_headers_text.trim()) return {}
  try {
    return JSON.parse(providerForm.value.extra_headers_text)
  } catch {
    return {}
  }
}

async function doPreview() {
  const { base_url, api_key } = providerForm.value
  if (!base_url) return ElMessage.warning('请先填写模型 API 地址')
  // 免凭据通道没有 Token 可填，拦了它就永远拉不了列表——和上面的保存同一个洞
  if (!editingProvider.value && !api_key && !isCredentiallessProtocol(providerForm.value.protocol)) {
    return ElMessage.warning('请先填写 API Token')
  }
  const payload = {
    base_url,
    protocol: providerForm.value.protocol,
    api_key,
    extra_headers: parseExtraFromForm()
  }
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'models_path', 'models_method']) {
    if (providerForm.value[field]) payload[field] = providerForm.value[field]
  }
  if (editingProvider.value && !api_key) {
    delete payload.api_key
    payload.provider_id = editingProvider.value.id
  }
  previewing.value = true
  try {
    const result = await api.previewModels(payload)
    previewList.value = result.models
    previewSelected.value = []
    previewDialog.value = true
  } catch (e) {
    ElMessage.error(e?.message || '拉取模型列表失败')
  } finally {
    previewing.value = false
  }
}

function applyPreviewModels() {
  const current = providerForm.value.model_names_text.split('\n').map((s) => s.trim()).filter(Boolean)
  const merged = [...new Set([...current, ...previewSelected.value])]
  providerForm.value.model_names_text = merged.join('\n')
  previewDialog.value = false
  ElMessage.success(`已将 ${previewSelected.value.length} 个模型填入「模型名称」，可继续增删`)
}

async function removeProvider(p) {
  try {
    await api.deleteProvider(p.id)
    ElMessage.success('平台已删除')
    if (expandedId.value === p.id) expandedId.value = null
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '删除平台失败')
  }
}

async function toggleProvider(p) {
  try {
    await api.updateProvider(p.id, { enabled: p.enabled })
  } catch (e) {
    p.enabled = !p.enabled
    ElMessage.error(e?.message || '更新失败')
  }
}

async function refreshModels(p) {
  refreshingId.value = p.id
  try {
    const result = await api.refreshModels(p.id)
    // 免费通道的刷新会顺带实测收编上游新上的免费型号，新捞到的单独报一下
    const found = result.discovered?.length
    ElMessage.success(
      found ? `已获取 ${result.count} 个模型，新收编 ${found} 个：${result.discovered.join('、')}` : `已获取 ${result.count} 个模型`
    )
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '刷新模型失败')
  } finally {
    refreshingId.value = null
  }
}

function openAddKeyDialog(p) {
  keyOwner.value = p
  editingKey.value = null
  keyForm.value = { name: '', api_key: '', enabled: true }
  keyDialog.value = true
}

function openEditKeyDialog(p, k) {
  keyOwner.value = p
  editingKey.value = k
  keyForm.value = { name: k.name, api_key: '', enabled: k.enabled }
  keyDialog.value = true
}

async function saveKey() {
  if (!keyForm.value.api_key && !editingKey.value) {
    return ElMessage.warning('API Key 不能为空')
  }
  try {
    if (editingKey.value) {
      await api.updateKey(keyOwner.value.id, editingKey.value.id, keyForm.value)
      ElMessage.success('Key 已更新')
    } else {
      await api.addKey(keyOwner.value.id, keyForm.value)
      ElMessage.success('Key 已添加')
    }
    keyDialog.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '保存 Key 失败')
  }
}

async function toggleKey(p, k) {
  try {
    await api.updateKey(p.id, k.id, { enabled: k.enabled })
  } catch (e) {
    k.enabled = !k.enabled
    ElMessage.error(e?.message || '更新失败')
  }
}

async function removeKey(p, k) {
  try {
    await ElMessageBox.confirm(`确定删除 Key "${k.name}"？`, '删除确认', { type: 'warning' })
    await api.deleteKey(p.id, k.id)
    ElMessage.success('Key 已删除')
    await load()
  } catch (e) {
    if (e !== 'cancel' && e?.message !== 'cancel') ElMessage.error(e?.message || '删除失败')
  }
}

async function resetKey(p, k) {
  try {
    await api.resetKey(p.id, k.id)
    ElMessage.success('已恢复该 Key')
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '恢复失败')
  }
}

// ---------------------------------------------------------------------------
// 添加订阅：与「添加平台」完全分开的入口
//
// 订阅平台没有 API Token 可填，凭据要建完平台才能授权或导入。混在「添加平台」里
// 只会在接口格式下拉框外多出几个选项，或者干脆被必填校验拦住要填 API Token。
// 这里单独建，建完直接接后面的凭据绑定。
// ---------------------------------------------------------------------------
const subscriptionDialog = ref(false)
const subscriptionPlans = ref([])
const creatingSub = ref(false)
const emptySubForm = () => ({ plan_id: '', name: '', base_url: '', model_names_text: '' })
const subForm = ref(emptySubForm())

// 方案自带的接入提示与地址占位。地址框不锁死：上游迁移时用户能自己改，
// 但占位给的是方案的正确地址，避免手滑填成计费域（WorkBuddy 尤其容易踩）。
const currentPlan = computed(() => subscriptionPlans.value.find((p) => p.id === subForm.value.plan_id) || null)
const currentPlanHint = computed(() => currentPlan.value?.hint || '')
const subFormPlaceholder = computed(() => currentPlan.value?.base_url || '接入地址会随所选方案自动填入')

async function openSubscriptionDialog() {
  subForm.value = emptySubForm()
  subscriptionDialog.value = true
  // 方案来自服务端（/api/subscriptions/plans），拉过一次就复用
  if (subscriptionPlans.value.length === 0) {
    try {
      const data = await api.getSubscriptionPlans()
      subscriptionPlans.value = data.plans || []
    } catch (e) {
      subscriptionDialog.value = false
      return ElMessage.error(e?.message || '加载订阅方案失败')
    }
  }
  if (subscriptionPlans.value.length === 0) {
    subscriptionDialog.value = false
    return ElMessage.warning('服务端没有返回任何订阅方案')
  }
  subForm.value.plan_id = subscriptionPlans.value[0].id
  applyPlan()
}

// 换接入点时只跟着刷新接入地址。名称只在为空、或还停在某个方案自带的名字上时
// 才覆盖，免得把用户自己敲的名字抹掉。
// 模型清单故意不碰：默认模型随上游版本变，预填一份很容易与实际可用型号对不上，
// 而用户在里面写过东西时更不能覆盖。留空由他自己填，或建完点「刷新」让网关兜底。
function applyPlan() {
  const plan = subscriptionPlans.value.find((p) => p.id === subForm.value.plan_id)
  if (!plan) return
  const stillPlanName = subscriptionPlans.value.some((p) => p.name === subForm.value.name)
  if (!subForm.value.name || stillPlanName) subForm.value.name = plan.name
  subForm.value.base_url = plan.base_url
}

async function createSubscription() {
  const plan = subscriptionPlans.value.find((p) => p.id === subForm.value.plan_id)
  if (!plan) return ElMessage.warning('请选择订阅接入')
  if (!subForm.value.name || !subForm.value.base_url) {
    return ElMessage.warning('平台名称和模型 API 地址为必填项')
  }
  const model_names = subForm.value.model_names_text.split('\n').map((s) => s.trim()).filter(Boolean)
  creatingSub.value = true
  try {
    // 不提交 api_key：订阅平台的凭据走授权/导入，交了后端会存成一个永远调不通的静态 Key
    const created = await api.createProvider({
      name: subForm.value.name,
      base_url: subForm.value.base_url,
      protocol: plan.protocol,
      extra_headers: {},
      model_names
    })
    subscriptionDialog.value = false
    await load()
    ElMessage.success('订阅平台已创建，接下来绑定凭据')
    if (isWorkbuddyProvider(created)) {
      // WorkBuddy 没有设备码授权，凭据只能靠导入登录态文件。直接把导入框打开，
      // 免得用户回头在平台列表里找「导入 Token」在哪一步。
      openImportCredentialDialog(created)
    } else {
      // 平台没有凭据就服务不了，所以建完直接进授权；想改走「导入 Token」关掉即可
      openGrokAuth(created)
    }
  } catch (e) {
    ElMessage.error(e?.message || '创建订阅平台失败')
  } finally {
    creatingSub.value = false
  }
}

// ---------------------------------------------------------------------------
// Grok / Codex 订阅账号（OAuth 设备码授权）
//
// 流程：服务端申请 user_code → 用户在浏览器确认 → 前端按服务端给的节奏轮询
// 直到 done / error / expired。轮询间隔由服务端决定（含 slow_down 退避），
// 前端不自己拍脑袋定频率。
// Grok 与 Codex 走同一套 UI 与状态机，差异只在端点与文案，按协议分流。
// ---------------------------------------------------------------------------
const grokDialog = ref(false)
const startingAuth = ref(false)
const deviceFlow = ref(null)
const refreshingCred = ref(null)
const authProvider = ref(null)
let pollTimer = null

// 订阅类协议的凭据来自 OAuth 授权或导入 token，不是创建平台时手填的静态 API Key。
// 建平台表单、必填校验都要据此区分——否则选了 Grok / Codex 模板仍被拦住要填 API Token。
function isOAuthProtocol(protocol) {
  return protocol === 'grok-oauth' || protocol === 'codex-oauth' || protocol === 'workbuddy-oauth'
}

// 免凭据通道（OpenCode Zen 免费档）：创建平台时不需要 API Token，
// 也不能把空 Token 当普通 Key 提交，否则平台下会挂一个永远调不通的静态 Key。
function isCredentiallessProtocol(protocol) {
  return protocol === 'zen-free'
}

function isOAuthProvider(p) {
  return isOAuthProtocol(p?.protocol)
}

function isCodexProvider(p) {
  return p?.protocol === 'codex-oauth'
}

function isWorkbuddyProvider(p) {
  return p?.protocol === 'workbuddy-oauth'
}

// 前端操作归属哪一套 OAuth 端点
function oauthKind(p) {
  if (isCodexProvider(p)) return 'codex'
  if (isWorkbuddyProvider(p)) return 'workbuddy'
  return 'grok'
}

function authLabel(p) {
  if (isCodexProvider(p)) return 'Codex'
  if (isWorkbuddyProvider(p)) return 'WorkBuddy'
  return 'Grok'
}

// 「导入 Token」直接粘贴 access_token / sso_token 作为订阅账号凭据
const importDialog = ref(false)
const importingCred = ref(false)
const importProvider = ref(null)
const importForm = ref({ name: '', access_token: '', refresh_token: '', account_id: '', expires_in: '' })

function openImportCredentialDialog(p) {
  importProvider.value = p
  importForm.value = { name: '', access_token: '', refresh_token: '', account_id: '', expires_in: '' }
  importDialog.value = true
}

// 与服务端 workbuddy-oauth.js 的 parseWorkbuddyAuthFile 同源：解析 CodeBuddy CLI
// 的登录态文件。字段是驼峰，网关内部统一用下划线。嵌套（CLI 实际写盘的形状）
// 与扁平两种都收，用户手工改过文件也不至于认不出来。
function parseWorkbuddyAuthFile(raw) {
  let obj
  try {
    obj = JSON.parse(String(raw || '').trim())
  } catch {
    return null
  }
  const auth = obj.auth || obj
  const account = obj.account || obj
  const access_token = auth.accessToken || auth.access_token || ''
  const uid = account.uid || account.UID || auth.uid || ''
  if (!access_token || !uid) return null
  return {
    access_token,
    refresh_token: auth.refreshToken || auth.refresh_token || '',
    uid,
    domain: auth.domain || account.domain || '',
    expires_at: auth.expiresAt || auth.expires_at || 0
  }
}

async function saveImportCredential() {
  const { name, access_token, refresh_token, account_id, expires_in } = importForm.value
  if (!access_token || !access_token.trim()) return ElMessage.warning('请先填写 access_token / sso_token')

  // WorkBuddy 用户手里是整份 workbuddy-<uid>.json —— uid / domain / token 全在里面。
  // 让他们自己抠五个字段出来填，出错率高得离谱，所以这里直接吃整份 JSON。
  if (isWorkbuddyProvider(importProvider.value)) {
    const parsed = parseWorkbuddyAuthFile(access_token.trim())
    if (!parsed) return ElMessage.warning('读不到 access_token 与 uid，请粘贴完整的 workbuddy-<uid>.json 文件内容')
    importingCred.value = true
    try {
      await api.addKey(importProvider.value.id, {
        type: 'oauth',
        provider: 'workbuddy',
        name: name || '',
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        // WorkBuddy 上游按 uid + realm 识别身份，缺一个都调不通
        uid: parsed.uid,
        domain: parsed.domain,
        // 服务端按「剩余秒数」落成 expires_at
        expires_in: parsed.expires_at ? Math.max(0, Math.floor((parsed.expires_at - Date.now()) / 1000)) : 0,
        enabled: true
      })
      ElMessage.success('WorkBuddy 凭据已导入，账号已绑定')
      importDialog.value = false
      await load()
    } catch (e) {
      ElMessage.error(e?.message || '导入失败')
    } finally {
      importingCred.value = false
    }
    return
  }

  importingCred.value = true
  try {
    await api.addKey(importProvider.value.id, {
      type: 'oauth',
      // Codex 平台导入时必须标 codex，凭据刷新与账号头才会走对的那套逻辑
      provider: oauthKind(importProvider.value),
      name: name || '',
      access_token: access_token.trim(),
      refresh_token: refresh_token ? refresh_token.trim() : '',
      // Codex 上游需要 ChatGPT-Account-Id，导入时顺手带上
      account_id: account_id ? account_id.trim() : '',
      expires_in: expires_in ? Number(expires_in) : 0,
      enabled: true
    })
    ElMessage.success('Token 已导入，账号已绑定')
    importDialog.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '导入失败')
  } finally {
    importingCred.value = false
  }
}

// 状态由后端判定（后端用统一的 1 小时提前量），前端只负责呈现，避免两边口径不一致
function credBadge(k) {
  if (k.credential_state === 'valid') return 'badge-green'
  if (k.credential_state === 'expiring') return 'badge-amber'
  return 'badge-red'
}

function credText(k) {
  if (k.credential_state === 'valid') return '正常'
  if (k.credential_state === 'expiring') return '即将过期'
  return '凭据缺失'
}

function openGrokAuth(p) {
  authProvider.value = p
  deviceFlow.value = null
  grokDialog.value = true
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function closeGrokAuth() {
  stopPolling()
  const flow = deviceFlow.value
  // 用户中途放弃时通知服务端丢弃会话，别让它在那儿空转到过期
  if (flow?.status === 'pending' && flow?.session_id) {
    const kind = isCodexProvider(authProvider.value) ? 'codex' : 'grok'
    ;(kind === 'codex' ? api.cancelCodexDevice(flow.session_id) : api.cancelGrokDevice(flow.session_id)).catch(() => {})
  }
  deviceFlow.value = null
  authProvider.value = null
}

async function startGrokAuth() {
  startingAuth.value = true
  try {
    const kind = oauthKind(authProvider.value)
    const flow = kind === 'codex'
      ? await api.startCodexDevice({ provider_id: authProvider.value?.id })
      : await api.startGrokDevice({ provider_id: authProvider.value?.id })
    deviceFlow.value = {
      status: 'pending',
      session_id: flow.session_id,
      user_code: flow.user_code,
      verify_url: flow.verification_uri,
      verify_url_complete: flow.verification_uri_complete
    }
    schedulePoll(2000)
  } catch (e) {
    // 最常见的失败原因是服务器访问不到上游授权服务器，提示要说到点子上
    const host = isCodexProvider(authProvider.value) ? 'auth.openai.com' : 'auth.x.ai'
    ElMessage.error(e?.message || `发起授权失败，请确认服务器可以访问 ${host}`)
  } finally {
    startingAuth.value = false
  }
}

function schedulePoll(delay) {
  stopPolling()
  pollTimer = setTimeout(pollOnce, delay)
}

async function pollOnce() {
  const sessionId = deviceFlow.value?.session_id
  if (!sessionId) return
  try {
    const kind = oauthKind(authProvider.value)
    const r = kind === 'codex'
      ? await api.pollCodexDevice(sessionId)
      : await api.pollGrokDevice(sessionId)
    if (r.status === 'done') {
      stopPolling()
      deviceFlow.value = { status: 'done' }
      ElMessage.success(`${authLabel(authProvider.value)} 账号授权成功`)
      await load()
      return
    }
    if (r.status === 'error' || r.status === 'expired') {
      stopPolling()
      deviceFlow.value = { status: 'error', error: r.error || '授权已超时，请重新发起' }
      return
    }
    schedulePoll(Math.max((r.retry_after || 5) * 1000, 2000))
  } catch (e) {
    stopPolling()
    deviceFlow.value = { status: 'error', error: e?.message || '轮询失败' }
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(deviceFlow.value.user_code)
    ElMessage.success('验证码已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中')
  }
}

function openVerifyPage() {
  window.open(deviceFlow.value.verify_url_complete, '_blank', 'noopener')
}

async function refreshCredential(p, k) {
  refreshingCred.value = k.id
  try {
    const kind = oauthKind(p)
    await (kind === 'codex' ? api.refreshCodexAccount(p.id, k.id) : api.refreshGrokAccount(p.id, k.id))
    ElMessage.success('凭据已续期')
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '续期失败')
  } finally {
    refreshingCred.value = null
  }
}

async function exportProviders() {
  try {
    const blob = await api.exportProviders()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `providers_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出成功（含 Key 和模型）')
  } catch (e) {
    ElMessage.error(e?.message || '导出失败')
  }
}

function triggerImport() {
  importInput.value.click()
}

async function importProviders(event) {
  const file = event.target.files[0]
  if (!file) return

  try {
    const text = await file.text()
    const data = JSON.parse(text)
    if (!Array.isArray(data)) {
      throw new Error('文件格式错误：必须是平台数组')
    }

    let keyCount = 0
    for (const item of data) {
      if (!item.name || !item.base_url) {
        throw new Error('平台缺少必要字段：name 和 base_url')
      }
      if (Array.isArray(item.keys)) {
        keyCount += item.keys.length
      }
    }

    ElMessageBox.confirm(
      `确定导入 ${data.length} 个平台、${keyCount} 个 Key 吗？`,
      '确认导入',
      { type: 'warning' }
    ).then(async () => {
      const result = await api.importProviders(data)
      ElMessage.success(`成功导入 ${result.imported} 个平台`)
      await load()
    }).catch(() => {
      ElMessage.info('已取消导入')
    })
  } catch (e) {
    ElMessage.error(e?.message || '导入失败')
  }
  event.target.value = ''
}

onMounted(() => {
  load()
  loadTemplates()
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.tool-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.tool-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.provider-list { display: flex; flex-direction: column; gap: 12px; }

.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.sub-head .section-title { margin-bottom: 0; flex: 1; }

.key-err {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}

.preset-label {
  font-size: 12px;
  color: var(--ink-3);
  margin-bottom: 6px;
}

.oauth-hint {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--ink-2);
  background: var(--surface-2);
  border-left: 2px solid var(--rule-soft);
  padding: 9px 13px;
  border-radius: 0 4px 4px 0;
  width: 100%;
}

/* 编辑订阅平台时替代「接口格式」下拉框——协议不是这里能改的东西，
   照常渲染会得到一个空着的必填项 */
.protocol-locked {
  width: 100%;
  min-height: 32px;
  display: flex;
  align-items: center;
  padding: 0 11px;
  background: var(--surface-2);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-sm);
  color: var(--ink-2);
  font-size: 13px;
}

.preview-summary {
  margin-top: 14px;
  background: var(--paper-sunk);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-sm);
  padding: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.preview-tags { display: flex; flex-wrap: wrap; gap: 4px; }

.adv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
  padding-top: 4px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 56px 20px;
  background: var(--surface);
  border: 1px dashed var(--rule-strong);
  border-radius: var(--r);
}

.empty-mark {
  width: 46px;
  height: 46px;
  border: 1.5px dashed var(--rule-strong);
  border-radius: var(--r-sm);
  color: var(--ink-4);
  font-family: var(--font-mono);
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}

.empty-title { font-size: 15.5px; font-weight: 600; margin-bottom: 8px; color: var(--ink); }

.empty-desc {
  color: var(--ink-3);
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px;
}

@media (max-width: 767px) {
  .adv-grid { grid-template-columns: 1fr; }
  .tool-row { flex-wrap: wrap; }
  .tool-actions { margin-left: 0; flex-basis: 100%; }
  .tool-actions .el-button { flex: 1; }
}
</style>
