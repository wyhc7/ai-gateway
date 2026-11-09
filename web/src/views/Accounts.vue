<template>
  <div>
    <div class="tool-row">
      <span class="label-micro">{{ accounts.length }} 个控制台账号</span>
      <div class="tool-actions">
        <el-button plain @click="load">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
          刷新列表
        </el-button>
        <el-button type="primary" @click="openCreate">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          创建账号
        </el-button>
      </div>
    </div>

    <div class="role-panel panel-tick">
      <div class="role-grid">
        <div class="role-item">
          <div class="role-name"><span class="badge badge-blue">admin</span> 管理员</div>
          <div class="role-desc">可进入完整控制台：平台、密钥、日志、系统更新，以及本页的账号管理。</div>
        </div>
        <div class="role-item">
          <div class="role-name"><span class="badge badge-purple">user</span> 普通用户</div>
          <div class="role-desc">账号与角色已建好，用户面板尚未开放。当前阶段普通用户登录后只能改自己的密码，进不了控制台。</div>
        </div>
      </div>
      <div class="role-foot">
        密码以 scrypt 加盐摘要存于 <code class="mono">config.json</code>，明文不落盘；会话令牌默认 {{ sessionTtlHours }} 小时有效，重置密码后该账号已签发的令牌立即全部失效。
      </div>
    </div>

    <div v-loading="loading">
      <div v-if="!loading && accounts.length === 0" class="empty-state">
        <div class="empty-mark">ID</div>
        <div class="empty-title">还没有任何控制台账号</div>
        <div class="empty-desc">
          创建第一个管理员后，即可用用户名与密码登录。<br />
          原有管理密钥通道继续有效，可作为忘记密码时的恢复入口。
        </div>
        <el-button type="primary" @click="openCreate">创建第一个账号</el-button>
      </div>

      <div v-else class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 170px">用户名</th>
              <th style="width: 118px">角色</th>
              <th style="width: 110px">状态</th>
              <th style="width: 132px">创建时间</th>
              <th style="width: 132px">最近登录</th>
              <th>备注</th>
              <th style="width: 288px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id">
              <td>
                <div class="cell-strong acc-name ellipsis" :title="a.username">{{ a.username }}</div>
                <div v-if="a.id === currentAccountId" class="acc-note">当前登录</div>
              </td>
              <td>
                <span :class="['badge', a.role === 'admin' ? 'badge-blue' : 'badge-purple']">{{ a.role }}</span>
              </td>
              <td>
                <span :class="['badge', a.enabled ? 'badge-green' : 'badge-gray']">
                  <span class="badge-dot" :class="a.enabled ? 'green' : 'gray'"></span>{{ a.enabled ? '启用中' : '已停用' }}
                </span>
              </td>
              <td class="acc-note">{{ formatTime(a.created_at) }}</td>
              <td class="acc-note">{{ a.last_login_at ? formatTime(a.last_login_at) : '从未登录' }}</td>
              <td><span class="acc-note ellipsis" :title="a.note">{{ a.note || '—' }}</span></td>
              <td>
                <div class="row-actions">
                  <el-button size="small" plain @click="openEdit(a)">编辑</el-button>
                  <el-button size="small" plain @click="toggleEnabled(a)" :disabled="a.id === currentAccountId">{{ a.enabled ? '停用' : '启用' }}</el-button>
                  <el-button size="small" plain @click="openReset(a)">重置密码</el-button>
                  <el-button size="small" plain type="danger" @click="remove(a)" :disabled="a.id === currentAccountId">删除</el-button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 创建 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="editing ? '编辑账号' : '创建账号'" width="520px" top="6vh" append-to-body>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="用户名">
          <el-input
            v-model="form.username"
            :disabled="Boolean(editing)"
            placeholder="2–32 位，中英文、数字、点、下划线或连字符"
            maxlength="32"
            autocomplete="off"
          />
          <div v-if="editing" class="field-note">用户名创建后不可修改。</div>
        </el-form-item>

        <el-form-item v-if="!editing" label="初始密码">
          <el-input v-model="form.password" type="password" :placeholder="`至少 ${passwordMin} 位`" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item v-if="!editing" label="确认密码">
          <el-input v-model="form.confirm" type="password" placeholder="再输一次" show-password autocomplete="new-password" />
        </el-form-item>

        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%" :disabled="editing?.id === currentAccountId">
            <el-option label="admin · 管理员（完整控制台）" value="admin" />
            <el-option label="user · 普通用户（面板待开放）" value="user" />
          </el-select>
          <div v-if="editing?.id === currentAccountId" class="field-note">不能把自己的账号降级为普通用户。</div>
        </el-form-item>

        <el-form-item label="状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" :disabled="editing?.id === currentAccountId" />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" placeholder="选填，例如这个账号是给谁用的" />
        </el-form-item>
      </el-form>

      <p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ editing ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="resetVisible" title="重置账号密码" width="440px" append-to-body>
      <p class="gate-hint">
        正在为 <strong>{{ resetTarget?.username }}</strong> 设置新密码。保存后该账号在其它设备上的登录状态立即失效；请把新密码单独告知本人。
      </p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="新密码">
          <el-input v-model="resetForm.password" type="password" :placeholder="`至少 ${passwordMin} 位`" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="resetForm.confirm" type="password" placeholder="再输一次" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>
      <p v-if="resetError" class="form-error" role="alert">{{ resetError }}</p>
      <template #footer>
        <el-button @click="resetVisible = false">取消</el-button>
        <el-button type="primary" :loading="resetting" @click="submitReset">保存新密码</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { notifyError } from '../api.js'

const loading = ref(false)
const saving = ref(false)
const resetting = ref(false)
const accounts = ref([])
const currentAccountId = ref('')
const passwordMin = ref(8)
const sessionTtlHours = ref(168)

const dialogVisible = ref(false)
const dialogError = ref('')
const editing = ref(null)
const form = ref({ username: '', password: '', confirm: '', role: 'user', enabled: true, note: '' })

const resetVisible = ref(false)
const resetError = ref('')
const resetTarget = ref(null)
const resetForm = ref({ password: '', confirm: '' })

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const [list, me, status] = await Promise.all([
      api.getAccounts(),
      api.authMe(),
      api.authStatus()
    ])
    accounts.value = list.accounts || []
    currentAccountId.value = me?.account?.id || ''
    passwordMin.value = Number(status?.password_min_length) || 8
    sessionTtlHours.value = Number(status?.session_ttl_hours) || 168
  } catch (e) {
    notifyError(e, '加载账号列表失败')
  } finally {
    loading.value = false
  }
}

function clearForm() {
  form.value = { username: '', password: '', confirm: '', role: 'user', enabled: true, note: '' }
  dialogError.value = ''
}

function openCreate() {
  editing.value = null
  clearForm()
  dialogVisible.value = true
}

function openEdit(a) {
  editing.value = a
  form.value = {
    username: a.username,
    password: '',
    confirm: '',
    role: a.role,
    enabled: a.enabled,
    note: a.note || ''
  }
  dialogError.value = ''
  dialogVisible.value = true
}

async function submit() {
  dialogError.value = ''
  const f = form.value
  if (!editing.value) {
    if (!f.username.trim()) { dialogError.value = '请填写用户名'; return }
    if (f.password.length < passwordMin.value) { dialogError.value = `密码至少 ${passwordMin.value} 位`; return }
    if (f.password !== f.confirm) { dialogError.value = '两次输入的密码不一致'; return }
  }
  saving.value = true
  try {
    if (editing.value) {
      await api.updateAccount(editing.value.id, { role: f.role, enabled: f.enabled, note: f.note.trim() })
      ElMessage.success('账号已更新')
    } else {
      await api.createAccount({ username: f.username.trim(), password: f.password, role: f.role, note: f.note.trim() })
      ElMessage.success('账号已创建')
    }
    dialogVisible.value = false
    await load()
  } catch (e) {
    dialogError.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(a) {
  try {
    await api.updateAccount(a.id, { enabled: !a.enabled })
    await load()
  } catch (e) {
    notifyError(e, '切换状态失败')
  }
}

function openReset(a) {
  resetTarget.value = a
  resetForm.value = { password: '', confirm: '' }
  resetError.value = ''
  resetVisible.value = true
}

async function submitReset() {
  resetError.value = ''
  const f = resetForm.value
  if (f.password.length < passwordMin.value) { resetError.value = `新密码至少 ${passwordMin.value} 位`; return }
  if (f.password !== f.confirm) { resetError.value = '两次输入的新密码不一致'; return }
  resetting.value = true
  try {
    await api.resetAccountPassword(resetTarget.value.id, f.password)
    resetVisible.value = false
    ElMessage.success(`${resetTarget.value.username} 的密码已重置`)
    await load()
  } catch (e) {
    resetError.value = e?.message || '重置失败'
  } finally {
    resetting.value = false
  }
}

async function remove(a) {
  try {
    await ElMessageBox.confirm(
      `删除「${a.username}」后，这个账号会立即无法登录；已签发的会话令牌也会因为账号消失而失效。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await api.deleteAccount(a.id)
    ElMessage.success('已删除')
    await load()
  } catch (e) {
    notifyError(e, '删除失败')
  }
}

onMounted(load)
</script>

<style scoped>
.data-table { min-width: 980px; }

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

.role-panel {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.role-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.role-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.role-desc {
  font-size: 12.5px;
  color: var(--ink-3);
  line-height: 1.7;
}
.role-foot {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--rule-soft);
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.7;
}

.acc-name { font-size: 13.5px; }
.acc-note { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; }
.ellipsis {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.row-actions { display: flex; gap: 6px; flex-wrap: nowrap; }
.row-actions .el-button + .el-button { margin-left: 0; }
.row-actions .el-button { padding: 5px 9px; }

.field-note { margin-top: 5px; font-size: 11.5px; line-height: 1.6; color: var(--ink-4); }
.gate-hint { margin: 0 0 16px; font-size: 13px; line-height: 1.75; color: var(--ink-3); }
.form-error {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  line-height: 1.6;
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
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
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.empty-title { font-size: 15.5px; font-weight: 600; margin-bottom: 8px; color: var(--ink); }
.empty-desc { color: var(--ink-3); font-size: 13px; line-height: 1.8; margin-bottom: 20px; }

@media (max-width: 767px) {
  .tool-row { flex-wrap: wrap; }
  .tool-actions { margin-left: 0; flex-basis: 100%; }
  .tool-actions .el-button { flex: 1; }
  .role-grid { grid-template-columns: 1fr; gap: 12px; }
}
</style>
