import { ElMessage } from 'element-plus'

async function request(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      detail = data?.error?.message || data?.error || detail
    } catch {
      /* ignore */
    }
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
    const resp = await fetch('/api/providers/export')
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`
      try {
        const data = await resp.json()
        msg = data?.error?.message || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    return resp.blob()
  },
  importProviders: (data) => request('/api/providers/import', { method: 'POST', body: JSON.stringify(data) })
}

export function notifyError(err, fallback = '操作失败') {
  ElMessage.error(err?.message || fallback)
}

export default api
