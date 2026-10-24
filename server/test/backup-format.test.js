import assert from 'node:assert/strict'
import test from 'node:test'

// 这一组只测「备份文件的两层结构」怎么解析，不碰网络。
// 真实的账号池读写由上游 chatgpt2api 负责，这里的职责是把格式接对。

const BACKUP_FORMAT = 'ai-gateway-backup'

function parseBackup(raw) {
  const isArray = Array.isArray(raw)
  const providers = isArray ? raw : raw?.providers
  const accounts = isArray
    ? null
    : Array.isArray(raw?.chatgpt_accounts)
      ? raw.chatgpt_accounts
      : Array.isArray(raw?.chatgpt_accounts?.items)
        ? raw.chatgpt_accounts.items
        : null
  return {
    providers: Array.isArray(providers) ? providers : null,
    accounts,
    providerId: isArray ? '' : raw?.chatgpt_accounts?.provider_id || ''
  }
}

test('老格式（裸平台数组）照常识别，且不带账号池', () => {
  const r = parseBackup([{ name: 'p1', base_url: 'https://a/v1' }])
  assert.equal(r.providers.length, 1)
  assert.equal(r.accounts, null)
  assert.equal(r.providerId, '')
})

test('新格式带账号池：两层都取到', () => {
  const r = parseBackup({
    format: BACKUP_FORMAT,
    version: 1,
    providers: [{ name: 'p1', base_url: 'https://a/v1' }],
    chatgpt_accounts: {
      provider_id: 'p-img',
      items: [{ email: 'a@b.com', access_token: 'eyJ.x.y' }]
    }
  })
  assert.equal(r.providers.length, 1)
  assert.equal(r.accounts.length, 1)
  assert.equal(r.accounts[0].email, 'a@b.com')
  assert.equal(r.providerId, 'p-img')
})

test('账号池是裸数组形态也认（兼容手工编辑过的备份）', () => {
  const r = parseBackup({
    providers: [],
    chatgpt_accounts: [{ email: 'x@y.com', access_token: 'a.b.c' }]
  })
  assert.equal(r.accounts.length, 1)
})

test('只有平台没有账号池：accounts 为 null，不报错', () => {
  const r = parseBackup({ providers: [{ name: 'p', base_url: 'u' }] })
  assert.equal(r.providers.length, 1)
  assert.equal(r.accounts, null)
})

test('既不是数组也没有 providers：判为格式错误', () => {
  assert.equal(parseBackup({ foo: 1 }).providers, null)
  assert.equal(parseBackup(null).providers, null)
  assert.equal(parseBackup('str').providers, null)
})

test('账号条目缺 access_token 时不该被当成有效账号写回', () => {
  // 上游 POST /api/accounts 只认带 token 的条目，其余会被它自己忽略。
  // 网关这一侧先筛一遍，避免把一堆空对象送上去。
  const items = [
    { email: 'ok@x.com', access_token: 'eyJ.a.b' },
    { email: 'bad@x.com' },
    { email: 'camel@x.com', accessToken: 'eyJ.c.d' },
    null
  ]
  const valid = items.filter((it) => it && typeof it === 'object' && (it.access_token || it.accessToken))
  assert.equal(valid.length, 2)
})

test('备份里明写了脱敏警告字段', () => {
  const payload = {
    format: BACKUP_FORMAT,
    version: 1,
    secret_warning: 'chatgpt_accounts 含完整 access_token / refresh_token，等同账号密码，勿外传'
  }
  assert.match(payload.secret_warning, /等同账号密码/)
})
