import { ElMessage } from 'element-plus'

const ADMIN_KEY_STORAGE = 'admin-key'

export function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || ''
}

export function setAdminKey(key) {
  localStorage.setItem(ADMIN_KEY_STORAGE, key)
}

export function clearAdminKey() {
  localStorage.removeItem(ADMIN_KEY_STORAGE)
}

function adminHeaders() {
  const key = getAdminKey()
  return key ? { 'X-Admin-Key': key } : {}
}

function notifyUnauthorized() {
  window.dispatchEvent(new CustomEvent('gateway-unauthorized'))
}

async function request(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...adminHeaders(), ...(options.headers || {}) }
  })
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      detail = data?.error?.message || data?.error || detail
    } catch {
      /* ignore */
    }
    if (resp.status === 401) notifyUnauthorized()
    const err = new Error(detail)
    err.status = resp.status
    throw err
  }
  return resp.json()
}

export const api = {
  getStatus: () => request('/api/status'),
  getGateway: () => request('/api/gateway'),
  getTemplates: () => request('/api/templates'),
  getProviders: () => request('/api/providers'),
  createProvider: (data) => request('/api/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (id, data) => request(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProvider: (id) => request(`/api/providers/${id}`, { method: 'DELETE' }),
  previewModels: (data) => request('/api/providers/preview-models', { method: 'POST', body: JSON.stringify(data) }),
  refreshModels: (id) => request(`/api/providers/${id}/models/refresh`, { method: 'POST' }),
  addKey: (id, data) => request(`/api/providers/${id}/keys`, { method: 'POST', body: JSON.stringify(data) }),
  updateKey: (id, keyId, data) => request(`/api/providers/${id}/keys/${keyId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteKey: (id, keyId) => request(`/api/providers/${id}/keys/${keyId}`, { method: 'DELETE' }),
  resetKey: (id, keyId) => request(`/api/providers/${id}/keys/${keyId}/reset`, { method: 'POST' }),
  exportProviders: async () => {
    const resp = await fetch('/api/providers/export', { headers: adminHeaders() })
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`
      try {
        const data = await resp.json()
        msg = data?.error?.message || msg
      } catch { /* ignore */ }
      if (resp.status === 401) notifyUnauthorized()
      throw new Error(msg)
    }
    return resp.blob()
  },
  importProviders: (data) => request('/api/providers/import', { method: 'POST', body: JSON.stringify(data) }),
  getLogs: (query = '') => request(`/api/logs${query ? `?${query}` : ''}`),

  // Grok 订阅账号（OAuth 设备码授权）
  startGrokDevice: (data) => request('/api/oauth/grok/device/start', { method: 'POST', body: JSON.stringify(data || {}) }),
  pollGrokDevice: (sessionId) => request(`/api/oauth/grok/device/${sessionId}/poll`, { method: 'POST' }),
  cancelGrokDevice: (sessionId) => request(`/api/oauth/grok/device/${sessionId}`, { method: 'DELETE' }),
  refreshGrokAccount: (providerId, keyId) => request(`/api/oauth/grok/accounts/${providerId}/${keyId}/refresh`, { method: 'POST' }),
  // Codex 订阅账号（ChatGPT Plus/Pro 的设备码授权）
  startCodexDevice: (data) => request('/api/oauth/codex/device/start', { method: 'POST', body: JSON.stringify(data || {}) }),
  pollCodexDevice: (sessionId) => request(`/api/oauth/codex/device/${sessionId}/poll`, { method: 'POST' }),
  cancelCodexDevice: (sessionId) => request(`/api/oauth/codex/device/${sessionId}`, { method: 'DELETE' }),
  refreshCodexAccount: (providerId, keyId) => request(`/api/oauth/codex/accounts/${providerId}/${keyId}/refresh`, { method: 'POST' })
}

export function notifyError(err, fallback = '操作失败') {
  ElMessage.error(err?.message || fallback)
}

export default api
