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
              <!-- WorkBuddy 两个版本是两个平台、两套登录入口。徽标从平台自己的
                   workbuddy_region 来，不靠名字猜——名字是用户能改的 -->
              <span v-if="isWorkbuddyProvider(p)" class="badge" :class="workbuddyRegion(p) === 'intl' ? 'badge-purple' : 'badge-green'">
                {{ workbuddyVersionLabel(p) }}
              </span>
              <span v-if="isCustomCallPlan(p)" class="badge badge-purple">自定义调用方案</span>
              <span :class="['badge', p.enabled ? 'badge-green' : 'badge-gray']">
                <span class="badge-dot" :class="p.enabled ? 'green' : 'gray'"></span>{{ p.enabled ? '启用' : '停用' }}
              </span>
              <span v-if="cooldownKeys(p).length > 0" class="badge badge-red">{{ cooldownKeys(p).length }} 个 Key 冷却中</span>
            </div>
            <div class="url">{{ p.base_url }}</div>
          </div>
          <!-- 平台级积分汇总：不用展开、不用点进任何一个号，卡头就写清这个平台
               还剩多少。只有 WorkBuddy 系有 credits_* 字段，其余平台这里是空的。 -->
          <div v-if="creditStats[p.id]" class="provider-credits" :title="creditStats[p.id].tip">
            <div class="pc-line">
              <span class="pc-num">{{ creditStats[p.id].remainText }}</span>
              <span class="pc-of">/ {{ creditStats[p.id].sizeText }}</span>
            </div>
            <div class="pc-bar">
              <div class="pc-fill" :class="creditStats[p.id].cls" :style="{ width: creditStats[p.id].pctNum + '%' }"></div>
            </div>
            <div class="pc-foot">{{ creditStats[p.id].pct }} 剩余 · {{ creditStats[p.id].count }} 号</div>
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
                  <!-- 转换层类平台（chatgpt2api 等）：网关这一侧只认一个上游凭据，
                       不是账号列表。标签写成「转换层凭据」，免得被当成加账号的入口。 -->
                  <span class="section-title">
                    {{ isOAuthProvider(p) ? '订阅账号' : (isBridgeProvider(p) ? '转换层凭据' : 'API Keys') }}
                    · {{ p.keys.length }}
                  </span>
                  <div class="head-actions">
                    <template v-if="isOAuthProvider(p)">
                      <el-button v-if="isWorkbuddyProvider(p)" size="small" plain @click="openWbJsonDialog(p)">导入 JSON</el-button>
                      <el-button size="small" plain @click="openImportCredentialDialog(p)">导入 Token</el-button>
                      <el-button size="small" plain @click="openAuthDialog(p)">授权 {{ authLabel(p) }} 账号</el-button>
                    </template>
                    <el-button
                      v-else-if="isBridgeProvider(p) && p.keys.length > 0"
                      size="small"
                      type="primary"
                      plain
                      @click="openChatgptAccounts(p)"
                    >管理账号</el-button>
                    <el-button
                      v-if="isBridgeProvider(p) && p.keys.length > 0"
                      size="small"
                      plain
                      @click="openAddKeyDialog(p)"
                    >换转换层 Key</el-button>
                    <el-button v-else-if="!isBridgeProvider(p)" size="small" plain @click="openAddKeyDialog(p)">添加 Key</el-button>
                  </div>
                </div>
                <div class="key-ledger">
                  <div v-if="p.keys.length === 0" class="key-empty">
                    {{ isOAuthProvider(p)
                      ? `尚未绑定订阅账号，点击「授权 ${authLabel(p)} 账号」添加。`
                      : (isBridgeProvider(p)
                        ? '尚未配置转换层凭据，点击右上角填入 CHATGPT2API_AUTH_KEY。'
                        : '尚未配置 Key，点击右上角添加。') }}
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
                      <!-- realm 是三套互不通用的网关，一眼要能分清——
                           不标出来的话「这个账号为什么 401」只能靠翻配置才知道 -->
                      <span
                        v-if="isWorkbuddyProvider(p)"
                        class="badge realm-badge"
                        :class="realmOf(k).cls"
                        :title="realmOf(k).tip"
                      >{{ realmOf(k).label }}</span>
                      <span class="badge" :class="credBadge(k)">{{ credText(k) }}</span>
                      <el-button
                        v-if="k.refresh_token_present"
                        size="small"
                        text
                        :loading="refreshingCred === k.id"
                        @click="refreshCredential(p, k)"
                      >续期</el-button>
                      <!-- WorkBuddy 独有：剩余额度 + 每日签到。
                           当天已签就只显示状态，不再给按钮 -->
                      <template v-if="isWorkbuddyProvider(p)">
                        <el-tooltip
                          v-if="k.credits_remain !== undefined"
                          :content="creditsTip(k)"
                          placement="top"
                        >
                          <span class="badge" :class="{ 'badge-amber': creditsLow(k) }">剩 {{ k.credits_remain }}</span>
                        </el-tooltip>
                        <el-tooltip v-else-if="k.credits_error" :content="k.credits_error" placement="top">
                          <span class="badge badge-amber">额度未知</span>
                        </el-tooltip>
                        <span v-if="k.checkin_date === checkinDay()" class="badge">已签到</span>
                        <el-button
                          v-else
                          size="small"
                          text
                          :loading="checkingIn === `${p.id}:${k.id}`"
                          @click="doCheckin(p, k)"
                        >签到</el-button>
                      </template>
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
                <div v-if="p.models.length === 0" class="key-empty">
                  <template v-if="p.models_source === 'unavailable'">上游取不到模型清单，请检查账号凭据或网络后点「刷新」。</template>
                  <template v-else>模型为空，点击「刷新」自动从平台拉取。</template>
                </div>
                <div v-else class="model-list">
                  <div v-for="m in p.models" :key="m.id" class="model-item" :class="{ 'model-non-chat': isNonChat(m) }">
                    <img v-if="m.icon" class="model-icon" :src="m.icon" :alt="m.name || m.id" loading="lazy" @error="($event.target.style.display = 'none')" />
                    <!-- 倍率直接写进模型名这一整串文本：`GLM-5.3 · x0.79`。
                         名字只出现一次，倍率跟在名字后面；上游没给倍率就
                         只留名字，不补「未给倍率」这种网关自己的判断 -->
                    <span class="model-id" :title="m.description || m.id">{{ modelLabel(p, m) }}</span>
                    <!-- 非对话模型（补全/生图）或自动选择别名：上游确实接受这些名字，
                         所以留在路由表里可点名，但在列表里标出来免得被当成常规对话模型 -->
                    <span
                      v-if="isNonChat(m)"
                      class="model-non-chat-tag"
                      :title="m.auto_select ? '上游的自动选择别名：由服务端挑一个后端，不是具体模型' : '非对话模型（补全或图像生成），仍可直接点名调用'"
                    >{{ m.auto_select ? '自动' : '非对话' }}</span>
                    <!-- 厂商：上游 vendor 字段直接给，不在网关里映射成猜测的名字 -->
                    <span v-if="m.vendor" class="model-vendor">{{ m.vendor }}</span>
                    <!-- 上下文窗口：上游给了就显示长度，没给明说「未知」。
                         标准 OpenAI /models 大多不含这个字段，所以「未知」是常态，
                         让这一格空着反而让人以为刷新坏了。 -->
                    <span class="model-ctx" :title="contextTitle(m)">{{ contextText(m) }}</span>
                    <!-- 能力标记同样是上游事实，不猜 -->
                    <span v-if="m.images || m.reasoning || m.tools" class="model-caps">
                      <span v-if="m.tools" title="支持工具调用">工具</span>
                      <span v-if="m.reasoning" title="支持推理">推理</span>
                      <span v-if="m.images" title="支持图像输入">视觉</span>
                    </span>
                    <!-- 没有倍率的模型：realm 才是有用的那一维——厂商名在同一平台里
                         每行都一样，而模型落在哪个网关决定调用时用哪个账号。 -->
                    <span
                      v-if="!modelRate(p, m) && m.realm"
                      class="model-realm"
                      :title="`该模型属于 ${realmLabel(m.realm)} 网关，调用时用对应版本的账号`"
                    >{{ realmLabel(m.realm) }}</span>
                  </div>
                </div>
                <!-- 倍率是上游给的，不是网关内置：把取数时间标出来，
                     过没过期一眼能看出来，不用猜这个数还准不准 -->
                <div v-if="p.model_rates_at" class="muted" style="margin-top: 8px">
                  模型与倍率取自上游 · {{ formatTime(p.model_rates_at) }}
                  <span v-if="p.model_rates_error">（{{ p.model_rates_error }}）</span>
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
        <!-- 订阅平台不再能从这里创建（见「添加订阅」）。这里仍保留该分支：
             编辑已有的订阅平台时要挡住下面那个 API Token 输入框——
             订阅凭据不在表单里填，走授权或导入。 -->
        <el-form-item v-if="isOAuthProtocol(providerForm.protocol)" label="订阅账号">
          <div class="oauth-hint">
            订阅账号的凭据不走 API Token，这个字段在这里填不了。保存后在平台列表里点
            「授权 {{ authLabel(providerForm) }} 账号」走网页授权，或点「导入 Token」粘贴已有凭据。
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
              <!-- 生图路径独立一栏：只生图平台（chatgpt2api 等）没有对话可言，
                   路径填错的表现是生图请求直接 404，且在网关日志里只看到一次转发 -->
              <el-form-item label="生图接口路径">
                <el-input v-model="providerForm.images_path" placeholder="/images/generations" />
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
          <!-- 两个版本是两条独立方案：选了哪条，建出来的平台就属于哪个版本，
               授权框与登录入口都跟着它走，之后不再提供切换 -->
          <el-col v-if="currentPlan?.protocol === 'workbuddy-oauth'" :span="24">
            <div class="oauth-hint" style="margin-top: -4px">
              国内版与国际版是两条独立方案：登录入口不同，账号落到的网关也不同。
              按你订阅的版本选；建成后该平台固定属于这个版本，要接另一个版本请另建一个平台。
            </div>
          </el-col>
          <!-- 静态 Key 类方案（chatgpt2api 等自建转换层）：凭据建完再补，
               这里先把话说明白，免得创建后找不到入口。
               关键区分：「添加 Key」填的是**转换层凭据**（整条链路只需要 1 个），
               而真正的 ChatGPT 账号池在转换层自己那边，加账号与网关无关。 -->
          <el-col v-if="currentPlan?.auth_kind === 'api_key'" :span="24">
            <div class="oauth-hint" style="margin-top: -4px">
              这条方案用的是自建转换层的凭据，不是 OpenAI 官方 Key。
              创建后点「添加 Key」只需填 <code>一次</code> <code>CHATGPT2API_AUTH_KEY</code>，之后不要再加。
              <br />
              <strong>要加 ChatGPT 账号，不在网关这里加</strong>：账号池在转换层
              <code>{{ currentPlan?.base_url?.replace(/\/v1\/?$/, '') }}</code> 自己那边，
              在那台机器上跑 <code>cgpt-add</code> 走 OAuth 授权即可，加多少都行、与网关 Key 数量无关。
              <template v-if="currentPlan?.image_only">本方案只生图，模型清单只有生图模型。</template>
            </div>
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
            :placeholder="currentPlan?.image_only ? '只生图方案：预填 gpt-image-2，留空则由网关回退到同一份清单' : '每行一个模型；默认不预填，留空即可'"
          />
          <span class="muted" style="display: block; margin-top: 6px; font-size: 12px; line-height: 1.7">
            <template v-if="currentPlan?.image_only">
              只生图方案：非生图模型即使填进来也会被服务端剔掉，客户端 <code>/v1/models</code> 只会看到生图模型。
            </template>
            <template v-else>
              默认模型不预填——订阅上游的可用型号随版本演进，写死一份容易与实际对不上。
              留空建完后点平台列表里的「刷新」，拉取失败时网关会回退到内置默认列表兜底。
            </template>
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

    <!-- 转换层账号池：加 ChatGPT 账号在这里，不在「添加 Key」 -->
    <ChatgptAccountsDialog
      ref="chatgptAccountsDialogRef"
      v-model="chatgptAccountsDialog"
      :provider="chatgptAccountsTarget"
      @changed="load"
    />

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

    <!-- Grok / Codex 订阅账号：设备码授权（上游给 user_code，用户去网页里填）。
         WorkBuddy 不走这里——它是扫码/网页登录，没有可填的验证码，单独一个对话框。 -->
    <el-dialog
      v-model="grokDialog"
      :title="`授权 ${authLabel(authProvider)} 订阅账号`"
      width="520px"
      :close-on-click-modal="false"
      @closed="closeAuthDialog"
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
        <el-button v-if="!deviceFlow" type="primary" :loading="startingAuth" @click="startDeviceAuth">
          开始授权
        </el-button>
      </template>
    </el-dialog>

    <!-- WorkBuddy 订阅账号：扫码 / 网页登录，上游给的是登录页地址，没有 user_code 可填。
         版本由**平台**决定（建平台时选的方案），框内不再提供切换：
         一个平台就是一个版本，混着切只会让「这个账号到底落在哪个网关」变得说不清。
         要授权另一个版本，就建另一个版本的平台。 -->
    <el-dialog
      v-model="workbuddyDialog"
      :title="`授权 WorkBuddy ${workbuddyVersionLabel(authProvider)}账号`"
      width="520px"
      :close-on-click-modal="false"
      @closed="closeAuthDialog"
    >
      <div v-if="!deviceFlow" class="grok-intro">
        <p>
          用你的 CodeBuddy {{ workbuddyVersionLabel(authProvider) }}订阅账号扫码授权，
          授权后这个账号的额度即可通过网关调用。
          uid、realm、token 由网关自动拿到并绑定，不用再去 CLI 里翻登录态文件。
        </p>
        <!-- 版本是平台的属性，这里只如实标出它会去哪个登录入口，
             不再给单选——选错入口的代价是拿不到凭据，而不是能顺手切回来 -->
        <div class="realm-pick">
          <span class="realm-label">登录入口</span>
          <span class="realm-value">{{ workbuddyLoginHost(authProvider) }}</span>
          <p class="grok-note">
            该地址只用于发起登录；账号最终落在哪个 realm 由上游签发的 domain 决定，
            对话、签到与额度都按账号自己的 realm 路由。
          </p>
        </div>
        <p class="grok-note">不需要 API Key，也不会保存你的登录密码。网关只拿到一枚可撤销的访问令牌。</p>
        <p class="grok-note">授权会话 5 分钟过期，超时了重新点一次即可。</p>
      </div>

      <div v-else-if="deviceFlow.status === 'pending'" class="device-step">
        <p class="device-hint">
          用 CodeBuddy 手机端扫码，或直接在
          <a :href="deviceFlow.verify_url" target="_blank" rel="noopener noreferrer">登录页</a>
          上登录。完成后这里会自动绑定。
        </p>
        <div class="device-actions">
          <el-button size="small" plain @click="openVerifyPage">打开授权登录页</el-button>
          <el-button size="small" text @click="copyCode">复制链接</el-button>
        </div>
        <p class="device-status">
          等待登录完成……页面会自动检查，无需手动刷新。
        </p>
      </div>

      <div v-else-if="deviceFlow.status === 'done'" class="device-done">
        <p>授权成功，账号已绑定到该平台。</p>
      </div>

      <div v-else class="device-error">
        <p>{{ deviceFlow.error || '授权失败' }}</p>
      </div>

      <template #footer>
        <el-button @click="workbuddyDialog = false">{{ deviceFlow?.status === 'done' ? '完成' : '取消' }}</el-button>
        <el-button v-if="!deviceFlow" type="primary" :loading="startingAuth" @click="startWorkbuddyAuth">
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

    <!-- WorkBuddy 登录态 JSON 批量导入。国内版/国际版两个平台共用同一个入口：
         账号归哪个平台由它自己的域名决定，不是由用户从哪个平台点进来决定——
         用户手里就是一个文件一个账号，不会替网关分好类。 -->
    <el-dialog v-model="wbJsonDialog" title="导入 WorkBuddy 登录态 JSON" width="680px" :close-on-click-modal="false">
      <div class="grok-intro">
        <p>粘贴或上传 CodeBuddy CLI 的登录态文件 <code>workbuddy-&lt;uid&gt;.json</code>，单个账号或账号数组都可以，uid、realm、token 网关自己解析。</p>
        <p>
          按每个账号自己的域名分流：<span class="badge realm-cn">国内</span>进国内版平台，<span class="badge realm-intl">国际</span><span class="badge realm-global">全球</span>进国际版平台——混着两个域的数组也能一次导入。
          同一账号重复导入会更新 token，不会堆出重复 Key；没有对应版本的平台时该账号失败，其它账号不受影响。
        </p>
      </div>
      <div class="wb-json-toolbar">
        <el-button size="small" plain @click="wbJsonFileInput?.click()">选择 .json 文件</el-button>
        <input ref="wbJsonFileInput" type="file" accept=".json,.txt" multiple aria-label="选择 WorkBuddy 账号 JSON 文件" style="display: none" @change="onWbJsonFiles" />
        <span v-if="wbJsonFiles.length" class="wb-json-files">{{ wbJsonFiles.join('、') }}</span>
      </div>
      <el-input
        v-model="wbJsonText"
        type="textarea"
        :rows="5"
        placeholder='也可以直接粘贴：[{"auth":{"accessToken":"...","domain":"workbuddy.ai"},"account":{"uid":"..."}}]'
      />
      <div class="wb-json-actions">
        <el-button size="small" @click="parseWbJsonText" :disabled="!wbJsonText.trim()">解析粘贴内容</el-button>
        <el-button v-if="wbJsonEntries.length" size="small" text type="danger" @click="wbJsonEntries = []">清空列表</el-button>
      </div>
      <div v-if="wbJsonParseError" class="wb-json-error">{{ wbJsonParseError }}</div>
      <div v-if="wbJsonEntries.length" class="wb-json-preview">
        <div class="section-title">解析出 {{ wbJsonEntries.length }} 个账号</div>
        <div v-for="(e, i) in wbJsonEntries" :key="i" class="wb-json-entry">
          <span class="badge" :class="wbRealmBadge(e.realm).cls">{{ wbRealmBadge(e.realm).label }}</span>
          <span class="key-name">{{ e.name || e.uid.slice(0, 8) + '…' }}</span>
          <span class="mask">{{ e.domain || '域名未填（按国内版处理）' }}</span>
          <span class="mask">token {{ e.access_token.slice(0, 6) }}…{{ e.access_token.slice(-4) }}</span>
          <el-button size="small" text type="danger" @click="wbJsonEntries.splice(i, 1)">移除</el-button>
        </div>
      </div>
      <div v-if="wbJsonResults" class="wb-json-results">
        <div class="section-title">
          导入结果：新增 {{ wbJsonResults.added }} · 更新 {{ wbJsonResults.updated }} · 失败 {{ wbJsonResults.failed }}
        </div>
        <div v-for="(r, i) in wbJsonResults.results" :key="i" class="wb-json-entry">
          <span class="badge" :class="r.status === 'failed' ? 'badge-red' : (r.status === 'updated' ? 'badge-amber' : 'badge-green')">
            {{ r.status === 'added' ? '已新增' : r.status === 'updated' ? '已更新' : '失败' }}
          </span>
          <span class="key-name">{{ r.name || (r.uid || '').slice(0, 8) }}</span>
          <span class="mask">{{ r.provider || wbRealmBadge(r.realm).label || '' }}</span>
          <span v-if="r.error" class="wb-json-error">{{ r.error }}</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="wbJsonDialog = false">关闭</el-button>
        <el-button type="primary" :loading="wbJsonImporting" :disabled="!wbJsonEntries.length" @click="submitWbJsonImport">
          导入 {{ wbJsonEntries.length }} 个账号
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import SwitchRail from '../components/SwitchRail.vue'
import ChatgptAccountsDialog from '../components/ChatgptAccountsDialog.vue'

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
  images_path: '',
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
  anthropic: 'Anthropic 原生',
  custom: '自定义'
}

function protocolLabel(proto) {
  return PROTOCOL_LABELS[proto] || 'OpenAI Chat'
}

function isCustomCallPlan(p) {
  return p.auth_type || p.auth_header || p.auth_prefix || p.auth_query_param || p.chat_path || p.images_path || p.models_path || p.models_method
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
  providerForm.value.images_path = t.images_path || ''
  providerForm.value.models_path = t.models_path || ''
  providerForm.value.models_method = t.models_method || ''
  providerForm.value.extra_headers_text = t.extra_headers ? JSON.stringify(t.extra_headers, null, 2) : ''
  if (!providerForm.value.name) providerForm.value.name = t.name
  // 模型一律不预填，模板自带的 default_models 不参与这张表单。
  // 写死一份默认清单有两个毛病：随上游版本演进很快过期，还会盖掉用户自己填的；
  // 且同一协议下各家厂商模型毫无交集，曾经正是它把 ChatGPT 的模型列表套到了
  // DeepSeek / 通义 / Gemini 平台上。
  // 需要默认清单的平台（订阅类）靠 refreshModels 兜底拿——那是拉取失败时
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
    providerForm.value.images_path = ''
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
    refreshWorkbuddyCredits()
  } catch (e) {
    ElMessage.error(e?.message || '加载平台列表失败')
  } finally {
    loading.value = false
  }
}

// 额度轮询。结果直接回写当前这份数据，不触发整页 reload——额度只是展示
// 信息，不该让页面闪一下。in-flight 集合防止上一轮还没回来又发一轮：
// 这个上游接口不快，30 秒一轮时偶尔会重叠。
const CREDITS_POLL_MS = 30 * 1000
let creditsTimer = null
const creditsInFlight = new Set()

function refreshWorkbuddyCredits() {
  for (const p of providers.value || []) {
    if (p.protocol !== 'workbuddy-oauth') continue
    for (const k of p.keys || []) {
      if (k.type !== 'oauth' || !k.token_present) continue
      const tag = `${p.id}:${k.id}`
      if (creditsInFlight.has(tag)) continue
      creditsInFlight.add(tag)
      api.getWorkbuddyCredits(p.id, k.id)
        .then((c) => {
          k.credits_remain = c.remain
          // 已用也要一起回写：卡头 tooltip 里有「已用 X」，只更新剩余会让
          // 剩余 + 已用 ≠ 总量，看着像账错了
          k.credits_used = c.used
          k.credits_size = c.size
          k.credits_at = c.fetched_at
          delete k.credits_error
        })
        .catch((e) => { k.credits_error = e?.message || '额度查询失败' })
        .finally(() => creditsInFlight.delete(tag))
    }
  }
}

// 模型积分倍率。按 realm 分开存：两个 realm 的模型名是两套（国际版是
// fast-model 这种抽象别名），合成一张表会让国际模型去查国内的倍率，
// 一条都查不到——生产上就是这么撞上的。
// 优先用模型自带的 rate（目录刷新时就写好），旧数据回落到按 realm 查表。
function modelRate(p, m) {
  if (m?.rate) return m.rate
  const table = p?.model_rates
  if (!table) return null
  if (m?.realm) return table[m.realm]?.[m.id] || null
  // 旧格式：扁平的一张表
  return table[m.id] || null
}

// 上游写成 "x0.79" 这种带前缀的字符串，去掉前缀再判零。
// 企业端点的倍率还会带单位后缀（"x2.20 credits"），一并剥掉——
// 不剥的话 Number() 得到 NaN，0 倍率的免费模型会判不出来。
// 倍率为 0 的模型走免费配色——hy3 就是 0，别和 0.79 一个待遇。
function rateNumber(rate) {
  const n = Number(String(rate ?? '').trim().replace(/^[xX×]/, '').replace(/\s*credits\s*$/i, ''))
  return Number.isFinite(n) ? n : null
}

function isFreeRate(rate) {
  return rateNumber(rate) === 0
}

// 展示时只留数值部分（"x2.20 credits" → "x2.20"）。
// 单位由 rate-chip 的样式与 title 表达，不必塞进这一列的窄格里。
function rateLabel(rate) {
  const raw = String(rate ?? '').trim()
  const m = raw.match(/^[xX×]?(\d+(?:\.\d+)?)/)
  return m ? `x${m[1]}` : raw
}

// 有促销时标出促销价：`x0.17→x0.50`。用箭头而不是「（促销 …）」——
// 这一列很窄，箭头更短且一眼看出折扣幅度。
function rateText(m) {
  const base = rateLabel(m?.rate)
  const discounted = m?.rate_discounted
  if (!discounted) return base
  // 「免费」这类非数值促销价不能套 x 前缀
  const shown = /^\d|^[xX×]/.test(String(discounted)) ? rateLabel(discounted) : String(discounted)
  return `${base}→${shown}`
}

// 该模型的倍率是否免费：原价或促销价任一为 0 都算（夜间免费的活动很常见）。
function isFreeModel(m) {
  return isFreeRate(m?.rate) || isFreeRate(m?.rate_discounted)
}

/**
 * 模型这一行的完整显示文本：`GLM-5.3 · x0.79`。
 *
 * 名字只出现一次（优先用上游给的名字，没有才退回 id），倍率紧跟其后，
 * 用「 · 」隔开。倍率是上游事实，有就拼、没有就不拼 ——
 * 不写「未给倍率」，那是拿网关的判断冒充上游事实。
 */
function modelLabel(p, m) {
  const parts = [m?.name || m?.id].filter(Boolean)
  const rate = modelRate(p, m) ? rateText(m) : ''
  if (rate) parts.push(rate)
  return parts.join(' · ')
}

// 上下文窗口：上游给了就显示长度，没给明说「未知」。
//
// 实测上游普遍不直接下发 contextWindow（国内 0/33 条有），后端会回落
// 到 maxInputTokens 等写法；全都取不到时这里写「未知」——
// 比留空白好，留白会让人以为是刷新失败了。
function contextText(m) {
  const n = Number(m?.context)
  return Number.isFinite(n) && n > 0 ? fmtTokens(m.context) : '未知'
}

function contextTitle(m) {
  const n = Number(m?.context)
  if (Number.isFinite(n) && n > 0) return `上下文窗口 ${m.context} tokens`
  return '上游未提供该模型的上下文窗口长度'
}

// 非对话模型（补全 / 生图）仍留在路由表里可点名，但在列表里淡化，
// 免得用户以为它们是常规对话模型。上游事实，不是网关的判断。
function isNonChat(m) {
  return m?.chat === false || m?.auto_select === true
}

// token 数按量级缩写。这是展示层唯一一处必要的换算，不参与任何判定。
function fmtTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  if (v >= 1000000) return `${Math.round(v / 100000) / 10}M`
  if (v >= 1000) return `${Math.round(v / 100) / 10}K`
  return String(v)
}

// realm 的可读名。账号标记与模型标记共用同一套叫法，
// 免得同一个 realm 在页面上出现两种称呼。
function realmLabel(realm) {
  return { cn: '国内', intl: '国际', global: '全球' }[realm] || realm
}

// WorkBuddy 账号属于哪个 realm。由 token 的 X-Domain 判定，不是平台配置——
// 一个平台里混进另一 realm 的账号时，只有这里看得出来。
function realmOf(k) {
  const d = String(k.domain || '').toLowerCase()
  if (d.includes('workbuddy.ai')) {
    return { label: '全球', cls: 'realm-global', tip: `WorkBuddy 全球版 · ${k.domain} · 对话走 www.workbuddy.ai` }
  }
  if (d.includes('codebuddy.ai')) {
    return { label: '国际', cls: 'realm-intl', tip: `CodeBuddy 国际版 · ${k.domain} · 对话走 www.codebuddy.ai` }
  }
  return { label: '国内', cls: 'realm-cn', tip: `腾讯 CodeBuddy 国内版 · ${k.domain || 'codebuddy.cn'} · 对话走 copilot.tencent.com` }
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
    images_path: p.images_path || '',
    models_path: p.models_path || '',
    models_method: p.models_method || ''
  }
  providerDialog.value = true
}

async function saveProvider() {
  if (!providerForm.value.name || !providerForm.value.base_url) {
    return ElMessage.warning('平台名称和模型 API 地址为必填项')
  }
  // 订阅类平台没有静态 API Token 可言，凭据要创建后走 OAuth 授权或导入。
  // 它们都得放行——否则表单把字段藏了、提交时却要求填，用户对着空白表单无从下手。
  if (!editingProvider.value && !providerForm.value.api_key
    && !isOAuthProtocol(providerForm.value.protocol)) {
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
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'images_path', 'models_path', 'models_method']) {
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
  if (!editingProvider.value && !api_key) {
    return ElMessage.warning('请先填写 API Token')
  }
  const payload = {
    base_url,
    protocol: providerForm.value.protocol,
    api_key,
    extra_headers: parseExtraFromForm()
  }
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'images_path', 'models_path', 'models_method']) {
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

// 转换层账号池对话框。账号存在转换层那边，网关只做代理，
// 所以这里把目标平台整条传过去（组件要用 base_url 展示、用 id 拼请求）。
const chatgptAccountsDialog = ref(false)
const chatgptAccountsTarget = ref(null)
const chatgptAccountsDialogRef = ref(null)

async function openChatgptAccounts(p) {
  chatgptAccountsTarget.value = p
  chatgptAccountsDialog.value = true
  // 等组件挂载后再拉数据；同一 tick 里 ref 还没绑上
  await nextTick()
  chatgptAccountsDialogRef.value?.open?.()
}

async function toggleProvider(p) {  try {
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
// 模型清单：OAuth 方案故意不碰（默认模型随上游版本变，预填一份很容易与实际对不上，
// 而用户在里面写过东西时更不能覆盖）；只生图方案例外——它的全部意义就是清单里
// 只有生图模型，必须预填，否则建出来的平台空着，刷新又会把文本模型灌回来。
function applyPlan() {
  const plan = subscriptionPlans.value.find((p) => p.id === subForm.value.plan_id)
  if (!plan) return
  const stillPlanName = subscriptionPlans.value.some((p) => p.name === subForm.value.name)
  if (!subForm.value.name || stillPlanName) subForm.value.name = plan.name
  subForm.value.base_url = plan.base_url
  if (!plan.default_models || plan.default_models.length === 0) return
  const stillPlanModels = subscriptionPlans.value.some(
    (p) => (p.default_models || []).join('\n') === subForm.value.model_names_text
  )
  if (!subForm.value.model_names_text.trim() || stillPlanModels || plan.image_only) {
    subForm.value.model_names_text = plan.default_models.join('\n')
  }
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
    // 不提交 api_key：订阅平台的凭据走授权/导入/补填，交了后端会存成一个
    // 未必可用的静态 Key。plan_id 一并提交，image_only 这类方案属性由服务端裁定，
    // 不靠前端抄一份字段说了算。
    const created = await api.createProvider({
      name: subForm.value.name,
      base_url: subForm.value.base_url,
      protocol: plan.protocol,
      plan_id: plan.id,
      extra_headers: {},
      // 方案自带的调用路径（生图路径尤其关键）：反代挂子路径时全靠它指对地方
      chat_path: plan.chat_path || '',
      images_path: plan.images_path || '',
      // 登录起点版本：国际版入口只认 IDE 客户端，和国内版不是同一个地址
      workbuddy_region: plan.region,
      image_only: Boolean(plan.image_only),
      model_names
    })
    subscriptionDialog.value = false
    await load()
    // 凭据是静态 Key 的方案（自建转换层）：没有设备码可走，直接把他送到
    // 「添加 Key」对话框，否则建完一个空平台在列表里杵着，没人知道下一步是填 Key。
    // 注意：这里填的是**转换层凭据**，一个平台一个就够；加 ChatGPT 账号是
    // 转换层那边的事（cgpt-add），不在网关这里加。
    if (plan.auth_kind === 'api_key') {
      ElMessage.success('平台已创建，请填入转换层凭据（只需一个，之后加账号在转换层那侧做）')
      openAddKeyDialog(created)
      return
    }
    ElMessage.success('订阅平台已创建，接下来绑定凭据')
    // 平台没有凭据就服务不了，所以建完直接进授权：WorkBuddy 扫码、Grok/Codex 设备码。
    // 想改走「导入 Token」关掉这个框，从平台列表里点即可
    openAuthDialog(created)
  } catch (e) {
    ElMessage.error(e?.message || '创建订阅平台失败')
  } finally {
    creatingSub.value = false
  }
}

// ---------------------------------------------------------------------------
// 订阅账号授权
//
// 两套独立的对话框，不共用：
//   grokDialog     —— Grok / Codex：设备码授权（上游给 user_code，用户去网页填）
//   workbuddyDialog—— WorkBuddy：扫码 / 网页登录（上游给登录页地址，无验证码）
//
// 刻意不合成一个「按协议分支」的大框：两者的交互步骤本就不同（一个有验证码、
// 一个没有），而且 WorkBuddy 的**版本**是平台属性，不该在框里给单选——
// 一个平台就是一个版本，混着切只会让「这个账号落在哪个网关」变得说不清。
//
// 轮询节奏由服务端决定（含 slow_down 退避），前端不自己拍脑袋定频率。
// ---------------------------------------------------------------------------
const grokDialog = ref(false)
const workbuddyDialog = ref(false)
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

function isOAuthProvider(p) {
  return isOAuthProtocol(p?.protocol)
}

// 自建转换层平台（如 chatgpt2api）：网关侧只需要一个上游凭据，
// 真正的账号池在转换层自己那边。UI 据此把「添加 Key」的语义改掉，
// 避免用户以为这里是加账号的地方、被 1 个 Key 卡住。
function isBridgeProvider(p) {
  const proto = p?.protocol
  const url = String(p?.base_url || '')
  if (proto !== 'openai-chat') return false
  if (p?.image_only) return true
  // 兜底：指向本机/内网的 openai-chat 也按转换层看待
  return /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
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

// WorkBuddy 平台属于哪个版本。建平台时按所选方案写进 workbuddy_region，
// 授权入口据此定，**不在对话框里给切换**。
// 缺字段（旧数据）按国内版处理：国内与全球版共用同一个登录入口，
// 猜错成国际版会去一个只认 IDE 客户端的入口，直接拿不到凭据。
function workbuddyRegion(p) {
  return p?.workbuddy_region === 'intl' ? 'intl' : 'cn'
}

function workbuddyVersionLabel(p) {
  return workbuddyRegion(p) === 'intl' ? '国际版' : '国内版'
}

// 该版本从哪个域名起登录。国内与全球版共用腾讯这边（platform=CLI），
// 国际版从 codebuddy.ai 起（只认 IDE 客户端）。
function workbuddyLoginHost(p) {
  return workbuddyRegion(p) === 'intl' ? 'www.codebuddy.ai' : 'copilot.tencent.com'
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
// 拆成对象版 + 文本版两层：批量导入要吃「一个或一串」登录态，对象版是共用的
// 那一半，文本版只是包一层 JSON.parse。
// 把「秒或毫秒」的绝对过期时刻统一成毫秒；缺失/非法返回 0。
// 与服务端 workbuddy-core.js 的 expiryToMs 同源：导出文件的 expiresAt 是秒
// （1795260343），网关内部 expires_at 一律毫秒。判据 1e12 见服务端注释。
function wbExpiryToMs(raw) {
  if (raw === undefined || raw === null || raw === '') return 0
  const s = String(raw).trim()
  if (!s) return 0
  // 负数直接判 0：否则 "-1" 会掉进 Date.parse 被当成有效日期
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
  }
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) ? parsed : 0
}

// 选一个能看的昵称：文件里的 nickname 常是打码串（"188****1530"），
// JWT 的 preferred_username 才是完整值。与服务端 pickWorkbuddyNickname 同源。
function wbPickNickname(fileNickname, accessToken) {
  const fromFile = typeof fileNickname === 'string' ? fileNickname.trim() : ''
  if (fromFile && !fromFile.includes('*')) return fromFile
  const fromJwt = jwtClaim(accessToken, 'preferred_username') || jwtClaim(accessToken, 'nickname')
  if (fromJwt) return fromJwt
  return fromFile
}

function parseWorkbuddyAuthObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const auth = obj.auth || obj
  const account = obj.account || obj
  const access_token = auth.accessToken || auth.access_token || ''
  const uid = account.uid || account.UID || auth.uid || ''
  if (!access_token || !uid) return null
  // 昵称：文件里常为空或打码，真值在 access_token 的 JWT 声明里（与服务端一致）
  const nickname = wbPickNickname(account.nickname, access_token)
  return {
    access_token,
    refresh_token: auth.refreshToken || auth.refresh_token || '',
    uid,
    domain: auth.domain || account.domain || '',
    // 单位归一：导出文件给秒，内部一律毫秒，否则提交时减 Date.now() 会算出负数
    expires_at: wbExpiryToMs(auth.expiresAt ?? auth.expires_at),
    name: nickname
  }
}

function parseWorkbuddyAuthFile(raw) {
  let obj
  try {
    obj = JSON.parse(String(raw || '').trim())
  } catch {
    return null
  }
  // 批量导出外壳（{ format, accounts:[...] }）在单条口也认，取第一个账号：
  // 用户手里只有这种文件，粘到「导入 Token」里报读不到 token 是最常见的困惑。
  if (!Array.isArray(obj) && Array.isArray(obj?.accounts)) obj = obj.accounts[0]
  return parseWorkbuddyAuthObject(obj)
}

// 读 JWT 里的一个字符串声明（不验签，仅用于展示昵称）
function jwtClaim(token, key) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(atob(padded))
    const v = payload?.[key]
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

// 批量版：一个账号（对象）或一串账号（数组）都收。坏条目跳过并报出序号，
// 不让一个文件里的坏账号拖垮整批——用户手里就是一个文件一个账号，格式
// 五花八门，逐条容错比整体拒绝好用。
function parseWorkbuddyAuthEntries(raw) {
  let obj
  try {
    obj = JSON.parse(String(raw || '').trim())
  } catch {
    return { entries: [], error: '不是合法的 JSON，请确认粘贴/上传的是登录态文件内容' }
  }
  // 三种形状都认：
  //   1) 裸数组        [ {accessToken, uid, ...}, ... ]
  //   2) 单个登录态    { accessToken, uid, ... } 或 { auth, account }
  //   3) 批量导出文件  { format:'workbuddy-accounts', accounts: [...] }
  // 第 3 种是网关自己的批量导出产物，字段是驼峰（accessToken），
  // 与单条登录态同形，所以只要把 accounts 摊平就能复用后面那套解析。
  const list = Array.isArray(obj)
    ? obj
    : Array.isArray(obj?.accounts)
      ? obj.accounts
      : [obj]
  if (list.length === 0) return { entries: [], error: 'JSON 里没有账号' }
  const entries = []
  const bad = []
  list.forEach((item, i) => {
    const parsed = parseWorkbuddyAuthObject(item)
    if (!parsed) {
      bad.push(i + 1)
      return
    }
    parsed.realm = wbEntryRealm(parsed.domain)
    entries.push(parsed)
  })
  return { entries, error: bad.length ? `第 ${bad.join('、')} 条读不到 access_token 与 uid，已跳过` : '' }
}

// 与服务端 workbuddyRealmFor 同源：域名归 realm，空域名按国内兜底。
// 分流是路由问题，服务端会按同一判据再判一次（见 import-workbuddy-json），
// 前端这里只用于预览展示。
function wbEntryRealm(domain) {
  const d = String(domain || '').toLowerCase()
  if (d.includes('workbuddy.ai')) return 'global'
  if (d.includes('codebuddy.ai')) return 'intl'
  return 'cn'
}

function wbRealmBadge(realm) {
  if (realm === 'global') return { label: '全球', cls: 'realm-global' }
  if (realm === 'intl') return { label: '国际', cls: 'realm-intl' }
  return { label: '国内', cls: 'realm-cn' }
}

// WorkBuddy 登录态 JSON 批量导入。分流（域名→平台）与去重（同 uid 更新）
// 都在服务端做，前端只管解析预览与展示结果。
const wbJsonDialog = ref(false)
const wbJsonImporting = ref(false)
const wbJsonText = ref('')
const wbJsonEntries = ref([])
const wbJsonFiles = ref([])
const wbJsonFileInput = ref(null)
const wbJsonParseError = ref('')
const wbJsonResults = ref(null)

function openWbJsonDialog() {
  wbJsonText.value = ''
  wbJsonEntries.value = []
  wbJsonFiles.value = []
  wbJsonParseError.value = ''
  wbJsonResults.value = null
  if (wbJsonFileInput.value) wbJsonFileInput.value.value = ''
  wbJsonDialog.value = true
}

function parseWbJsonText() {
  const { entries, error } = parseWorkbuddyAuthEntries(wbJsonText.value)
  wbJsonParseError.value = error
  // 替换而不是追加：textarea 里的文本就是「这一次要导入的东西」，
  // push 会把上一次的结果留在预览区，用户看到旧条目以为新文本没解析成功。
  wbJsonEntries.value = entries
}

// 多文件：逐个读、逐个解析，坏文件只报错不影响好文件。读完全部清掉 input 的
// value，否则同一个文件第二次选不触发 change。
async function onWbJsonFiles(e) {
  const files = [...(e.target.files || [])]
  const errors = []
  // 新一轮选文件视为重来：先清空，避免上一次的预览条目混进来
  wbJsonEntries.value = []
  for (const f of files) {
    try {
      const { entries, error } = parseWorkbuddyAuthEntries(await f.text())
      if (error) errors.push(`${f.name}：${error}`)
      wbJsonEntries.value.push(...entries)
    } catch {
      errors.push(`${f.name}：读取失败`)
    }
  }
  wbJsonFiles.value = files.map((f) => f.name)
  wbJsonParseError.value = errors.join('；')
  e.target.value = ''
}

async function submitWbJsonImport() {
  if (!wbJsonEntries.value.length) return
  wbJsonImporting.value = true
  try {
    // 直接把绝对毫秒传给服务端（字段名沿用 expires_at，服务端 expiryToMs 会再归一
    // 一次，秒/毫秒都收）。曾经这里折成相对秒数 expires_in，一旦单位错就变 0，
    // 落库后账号永不续期。
    const entries = wbJsonEntries.value.map((e) => ({
      name: e.name || '',
      access_token: e.access_token,
      refresh_token: e.refresh_token || '',
      uid: e.uid,
      domain: e.domain || '',
      expires_at: e.expires_at || 0
    }))
    const r = await api.importWorkbuddyJson({ entries })
    wbJsonResults.value = r
    if (r.added + r.updated > 0) {
      ElMessage.success(`导入完成：新增 ${r.added}、更新 ${r.updated}${r.failed ? `、失败 ${r.failed}` : ''}`)
      await load()
    } else {
      ElMessage.warning('没有账号导入成功，请看下方原因')
    }
  } catch (err) {
    ElMessage.error(err?.message || '导入失败')
  } finally {
    wbJsonImporting.value = false
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

// 打开授权框。WorkBuddy 与 Grok/Codex 是**两个独立的框**：
// 前者扫码/网页登录（无验证码），后者设备码（要填 user_code）。
// 版本不在这里选——它由平台的 workbuddy_region 决定。
function openAuthDialog(p) {
  authProvider.value = p
  deviceFlow.value = null
  if (isWorkbuddyProvider(p)) workbuddyDialog.value = true
  else grokDialog.value = true
}

// 兼容旧调用点（建完平台直接进授权）
function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function closeAuthDialog() {
  stopPolling()
  const flow = deviceFlow.value
  // 用户中途放弃时通知服务端丢弃会话，别让它在那儿空转到过期——
  // WorkBuddy 的 cookie 罐也随 state 挂在服务端，不通知就只能等满 5 分钟
  if (flow?.status === 'pending' && flow?.session_id) {
    const kind = oauthKind(authProvider.value)
    const cancel = { codex: api.cancelCodexDevice, workbuddy: api.cancelWorkbuddyLogin }[kind] || api.cancelGrokDevice
    cancel(flow.session_id).catch(() => {})
  }
  deviceFlow.value = null
  authProvider.value = null
}

// Grok / Codex：设备码授权（上游给 user_code 与验证地址）
async function startDeviceAuth() {
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
    const host = kind === 'codex' ? 'auth.openai.com' : 'auth.x.ai'
    ElMessage.error(e?.message || `发起授权失败，请确认服务器可以访问 ${host}`)
  } finally {
    startingAuth.value = false
  }
}

// WorkBuddy：扫码 / 网页登录。上游给的是登录页地址（打开后扫码或网页登录），
// 凭据由网关侧轮询 auth/token 拿到，没有可以填的 user_code。
// session_id 存 state，轮询与取消沿用与设备码同一套节奏。
// region 取自**平台**，不是框里的单选——发错入口会拿不到凭据。
async function startWorkbuddyAuth() {
  startingAuth.value = true
  const region = workbuddyRegion(authProvider.value)
  try {
    const flow = await api.startWorkbuddyLogin({ provider_id: authProvider.value?.id, region })
    deviceFlow.value = {
      status: 'pending',
      session_id: flow.state,
      user_code: '',
      verify_url: flow.auth_url,
      verify_url_complete: flow.auth_url
    }
    // 扫码这件事发生在用户自己的浏览器里，直接开新标签，别让他再手动复制
    window.open(flow.auth_url, '_blank', 'noopener')
    schedulePoll(2000)
  } catch (e) {
    const host = region === 'intl' ? 'www.codebuddy.ai' : 'copilot.tencent.com'
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
    const r = kind === 'workbuddy'
      ? await api.pollWorkbuddyLogin(sessionId)
      : kind === 'codex'
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
      // WorkBuddy 用 message 传错误，设备码流程用 error，两个都认
      deviceFlow.value = { status: 'error', error: r.error || r.message || '授权已超时，请重新发起' }
      return
    }
    // 扫码登录的「刚扫完」这一下值得查得密一点，人会盯着页面看
    const fallback = kind === 'workbuddy' ? 3 : 5
    schedulePoll(Math.max((r.retry_after || fallback) * 1000, 2000))
  } catch (e) {
    stopPolling()
    deviceFlow.value = { status: 'error', error: e?.message || '轮询失败' }
  }
}

async function copyCode() {
  // 设备码流程复制验证码，WorkBuddy 复制登录页地址——没有 user_code 可抄
  const flow = deviceFlow.value
  const isCode = Boolean(flow?.user_code)
  try {
    await navigator.clipboard.writeText(flow?.user_code || flow?.verify_url || '')
    ElMessage.success(isCode ? '验证码已复制' : '链接已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中')
  }
}

function openVerifyPage() {
  window.open(deviceFlow.value.verify_url_complete || deviceFlow.value.verify_url, '_blank', 'noopener')
}

// 凭据续期。三家各有自己的端点与信封，必须按类型分流——
// WorkBuddy 的续期走 /v2/plugin/auth/token/refresh（X-Refresh-Token 头 + 自家信封），
// 打到 Grok 的端点上只会拿回一个无从分辨的 404/401。
async function refreshCredential(p, k) {
  refreshingCred.value = k.id
  try {
    const kind = oauthKind(p)
    const refresh = {
      codex: api.refreshCodexAccount,
      workbuddy: api.refreshWorkbuddyAccount
    }[kind] || api.refreshGrokAccount
    await refresh(p.id, k.id)
    ElMessage.success('凭据已续期')
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '续期失败')
  } finally {
    refreshingCred.value = null
  }
}

// —— WorkBuddy 每日签到 ——
// 按北京时间的自然日算：签到按自然日重置，直接用宿主机日期的话，
// 网关跑在 UTC 机器上会在凌晨把「今天」判成昨天。
function checkinDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

const checkingIn = ref(null)

async function doCheckin(p, k) {
  checkingIn.value = `${p.id}:${k.id}`
  try {
    const r = await api.workbuddyCheckin(p.id, k.id)
    const credit = r?.summary?.daily_credit || r?.summary?.today_credit
    if (r.status === 'ok') ElMessage.success(`签到成功${credit ? `，+${credit} 额度` : ''}`)
    else if (r.status === 'already') ElMessage.info('今日已签到')
    else ElMessage.info('该账号没有可签到活动')
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '签到失败')
  } finally {
    checkingIn.value = null
  }
}

// 一行放不下全部信息：明细进 tooltip，行上只留「剩 X」这个数。
// 刻意不展示已消耗量——用户要的是「现在还剩多少」，不是账本。
function creditsTip(k) {
  if (k.credits_error) return `额度查询失败：${k.credits_error}`
  const parts = [`剩余额度 ${k.credits_remain}${k.credits_size ? ` / ${k.credits_size}` : ''} ${k.credits_unit || 'credits'}`]
  if (k.credits_at) parts.push(`更新于 ${new Date(k.credits_at).toLocaleTimeString()}`)
  return parts.join(' · ')
}

// 低于总量 10% 转琥珀色：签到攒出来的额度本来就不多，别等归零才提醒
function creditsLow(k) {
  return Number(k.credits_size) > 0 && Number(k.credits_remain) <= Number(k.credits_size) / 10
}

// 卡头上的平台积分汇总，按平台 id 索引。
//
// 只算 WorkBuddy 系 —— 商汤 / NVIDIA / chatgpt2api 的 key 是按次计费或固定凭据，
// 压根没有 credits_* 字段。要是把它们也当 0 加进来，「还剩多少积分」这个大数字
// 就被稀释成一个既不是余额也不是次数的怪数，干脆不进汇总。
//
// 阈值跟展开后每个号的徽章用同一套：<10% 红、<30% 琥珀，别一个平台两套口径。
const creditStats = computed(() => {
  const out = {}
  for (const p of providers.value) {
    if (!isWorkbuddyProvider(p)) continue
    const keys = (p.keys || []).filter((k) => k.credits_remain != null || k.credits_size != null)
    if (keys.length === 0) continue

    let remain = 0
    let used = 0
    let size = 0
    let latest = 0
    for (const k of keys) {
      remain += Number(k.credits_remain) || 0
      used += Number(k.credits_used) || 0
      size += Number(k.credits_size) || 0
      const at = Number(k.credits_at) || 0
      if (at > latest) latest = at
    }

    const ratio = size > 0 ? remain / size : 0
    const pctNum = Math.min(100, Math.max(0, ratio * 100))
    const unit = keys.find((k) => k.credits_unit)?.credits_unit || 'credits'

    out[p.id] = {
      remain,
      used,
      size,
      count: keys.length,
      pctNum,
      pct: size > 0 ? `${pctNum.toFixed(1)}%` : '—',
      remainText: remain.toLocaleString('en-US'),
      sizeText: size.toLocaleString('en-US'),
      cls: size <= 0 ? '' : ratio < 0.1 ? 'low' : ratio < 0.3 ? 'mid' : '',
      tip: [
        `${p.name}：剩余 ${remain.toLocaleString('en-US')} / ${size.toLocaleString('en-US')} ${unit}`,
        `已用 ${used.toLocaleString('en-US')}`,
        `${keys.length} 个账号合计`,
        latest ? `数据更新于 ${new Date(latest).toLocaleString()}（${agoText(latest)}）` : '尚未查询过额度'
      ].join(' · ')
    }
  }
  return out
})

// 「几分钟前」比绝对时间更适合描述余额新鲜度 —— 人关心的是这个数还准不准
function agoText(ts) {
  const min = Math.round((Date.now() - Number(ts)) / 60000)
  if (!Number.isFinite(min) || min < 0) return '刚刚'
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}

async function exportProviders() {
  try {
    const blob = await api.exportProviders()
    // 顺手数一下账号池里有多少条，好在提示里说清楚这份文件的分量。
    // blob 本身只是个字节流，没有额外字段可读，所以自己 parse 一遍。
    let accountCount = 0
    try {
      const parsed = JSON.parse(await blob.text())
      accountCount = Array.isArray(parsed?.chatgpt_accounts?.items)
        ? parsed.chatgpt_accounts.items.length
        : Array.isArray(parsed?.chatgpt_accounts)
          ? parsed.chatgpt_accounts.length
          : 0
    } catch {
      /* 数不出来不影响下载，只是提示少一句 */
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `providers_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    // Key 在导出时已脱敏（只留前后 4 位）——备份文件常被转手，
    // 明文凭据等于把账号送人。要迁移凭据得回页面里逐个复制。
    // 但账号池是完整导出的（不带 token 的备份换机器时没用），
    // 所以这句话得说清楚，别让人以为整份文件都安全。
    ElMessage.success(
      accountCount > 0
        ? `导出成功（平台 Key 已脱敏；含 ${accountCount} 个账号的完整凭证，此文件等同密码，勿外传）`
        : '导出成功（Key 已脱敏，仅留前后 4 位）'
    )
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
    const parsed = JSON.parse(text)
    // 新格式是 { providers: [...], chatgpt_accounts: {...} }，老格式是裸数组。
    // 两种都得认：用户的历史下载里有老文件，不能一升级就导不进去。
    const data = Array.isArray(parsed) ? parsed : parsed?.providers
    if (!Array.isArray(data)) {
      throw new Error('文件格式错误：需要平台数组，或含 providers 数组的备份对象')
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

    const backupAccounts = Array.isArray(parsed?.chatgpt_accounts?.items)
      ? parsed.chatgpt_accounts.items
      : Array.isArray(parsed?.chatgpt_accounts)
        ? parsed.chatgpt_accounts
        : []

    const scope = backupAccounts.length
      ? `${data.length} 个平台、${keyCount} 个 Key、${backupAccounts.length} 个 ChatGPT 账号`
      : `${data.length} 个平台、${keyCount} 个 Key`

    ElMessageBox.confirm(
      `确定导入 ${scope} 吗？`,
      '确认导入',
      { type: 'warning' }
    ).then(async () => {
      const result = await api.importProviders(data, backupAccounts, parsed?.chatgpt_accounts?.provider_id)
      ElMessage.success(`成功导入 ${result.imported} 个平台`)
      // 账号池是「合并」不是「覆盖」：重复导入不会炸号，也不会删掉现有账号。
      // 所以这里只说结果，不说「覆盖」，免得用户以为要先清空。
      const acc = result.accounts
      if (acc) {
        const bits = []
        if (acc.added) bits.push(`新增 ${acc.added}`)
        if (acc.skipped) bits.push(`已存在跳过 ${acc.skipped}`)
        if (bits.length) {
          ElMessage.success(`账号池：${bits.join('，')}`)
        } else {
          ElMessage.info('账号池：没有需要新增的账号')
        }
      }
      for (const err of result.account_errors || []) {
        ElMessage.warning({ message: `账号池写回失败：${err}`, duration: 10000, showClose: true })
      }
      // 脱敏文件再导入：凭据被置空的 Key 逐个点名，
      // 别让用户以为导入完就能用，一调用全是空 Key 报错
      const masked = result.masked_keys || []
      if (masked.length > 0) {
        ElMessage.warning({
          message: `以下 ${masked.length} 个 Key 的凭据在导出时已脱敏，需重新填写：${masked.join('、')}`,
          duration: 10000,
          showClose: true
        })
      }
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
  // 额度要「现在还剩多少」：刚发完一次对话就得看到数字掉下去。
  // 30 秒一轮，只在本页存活期间跑，离开即停。
  creditsTimer = setInterval(() => refreshWorkbuddyCredits(), CREDITS_POLL_MS)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (creditsTimer) clearInterval(creditsTimer)
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

/* WorkBuddy 登录入口版本选择。说明文字必须另起一行：挤在按钮旁边
   会把「开始授权」顶下去，而那个按钮才是这一步的主操作。 */
.realm-pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--rule-soft);
}

.realm-pick .realm-label {
  font-size: 13px;
  color: var(--ink-2);
}

/* 登录入口域名。只读展示（版本是平台属性，不在这里切换），
   用等宽字体让它和正文区分开——这是个地址，不是一句话。 */
.realm-pick .realm-value {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink);
  padding: 2px 7px;
  background: var(--surface-2);
  border: 1px solid var(--rule-soft);
  border-radius: 3px;
}

.realm-pick .grok-note {
  flex: 1 0 100%;
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink-2);
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

/* WorkBuddy 登录态 JSON 批量导入：工具条 / 预览列表 / 结果列表。
   条目布局复用 key-item 的视觉语法（徽章 + 名称 + 灰色备注 + 尾部操作），
   让「预览」和「结果」看起来就是即将进入 / 已经进入 Key 列表的那些行。 */
.wb-json-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 10px;
}
.wb-json-files {
  font-size: 12.5px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-json-actions {
  display: flex;
  gap: 8px;
  margin: 10px 0 4px;
}
.wb-json-preview,
.wb-json-results {
  margin-top: 12px;
  border-top: 1px solid var(--rule-soft);
  padding-top: 10px;
}
.wb-json-preview .section-title,
.wb-json-results .section-title {
  margin-bottom: 8px;
}
.wb-json-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
  flex-wrap: wrap;
}
.wb-json-entry .key-name { font-weight: 600; }
.wb-json-entry .mask { font-size: 12px; }
.wb-json-error {
  width: 100%;
  font-size: 12.5px;
  color: var(--danger, #c0392b);
  margin-top: 2px;
}
</style>
