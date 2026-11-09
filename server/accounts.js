// 账号系统：用户名 + 密码登录、角色、无状态会话令牌。
//
// 设计取舍（都为了守住项目「一份 JSON、零外部服务」这条底线）：
// 1) 账号直接存在 state.accounts 里，随 config.json 一起原子落盘；不引数据库。
// 2) 密码用 Node 内置 crypto.scryptSync 加盐摘要，明文永不落盘、永不进响应。
// 3) 会话是 HMAC-SHA256 签名的自包含令牌，服务端不存会话表：重启不丢登录态、
//    天然带过期。令牌里带账号的 password_version，改密/重置后旧令牌立即全体失效。
// 4) 每次请求都回查账号的 enabled 与 password_version —— 停用账号、改密码
//    无需等令牌过期就能把人踢下去。
import crypto from 'node:crypto'
import { state, persistImmediate, genId, getAdminKey } from './store.js'

// scrypt 参数：N=2^14、r=8、p=1，单次约 40ms，是自托管场景里成本与爆破难度
// 的平衡点。maxmem 显式放大，避免不同 Node 版本的默认上限把这组参数拒掉。
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64

export const PASSWORD_MIN = 8
const PASSWORD_MAX = 128
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) > 0
  ? Number(process.env.SESSION_TTL_HOURS)
  : 168) * 60 * 60 * 1000
const SESSION_TTL_HOURS = Math.round(SESSION_TTL_MS / (60 * 60 * 1000))
const TOKEN_PREFIX = 'gwst_'

// 登录失败限流：同一个 IP + 用户名，60 秒内错 5 次就锁到窗口结束。
// 只放内存即可 —— 它是防在线爆破的节流阀，不是审计账本，重启清空没有副作用。
const MAX_FAILURES = 5
const LOCK_MS = 60 * 1000
const failures = new Map()

export function fail(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function accountsArray() {
  if (!Array.isArray(state.accounts)) state.accounts = []
  return state.accounts
}

// ---------------------------------------------------------------------------
// 密码与用户名
// ---------------------------------------------------------------------------

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase()
}

// Unicode 字母/数字 + . _ -，2~32 字。中文用户名可用（管理员常见诉求）。
const USERNAME_RE = /^[\p{L}\p{N}._-]{2,32}$/u

export function validateUsername(value) {
  const name = normalizeUsername(value)
  if (!USERNAME_RE.test(name)) {
    throw fail(400, '用户名需 2–32 位，只能用中英文、数字、点、下划线或连字符')
  }
  return name
}

export function validatePassword(value) {
  const password = String(value ?? '')
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw fail(400, `密码长度需 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`)
  }
  return password
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024
  }).toString('hex')
  return { salt, hash }
}

export function verifyPassword(password, salt, expectedHex) {
  const expected = Buffer.from(String(expectedHex || ''), 'hex')
  if (!expected.length || expected.length !== KEYLEN) return false
  const actual = crypto.scryptSync(String(password ?? ''), String(salt || ''), KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024
  })
  return crypto.timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// 会话令牌
// ---------------------------------------------------------------------------

function sessionSecret() {
  // 老配置在 store.load() 里已被补齐；这里的兜底只防「有人手工删了字段」。
  return String(state.session_secret || getAdminKey() || 'ai-gateway-session-fallback')
}

function sign(body) {
  return crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url')
}

export function createSession(account) {
  const now = Date.now()
  const payload = {
    v: 1,
    uid: account.id,
    pv: Number(account.password_version) || 1,
    role: account.role,
    iat: now,
    exp: now + SESSION_TTL_MS
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${TOKEN_PREFIX}${body}.${sign(body)}`
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null
  const rest = token.slice(TOKEN_PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot < 1) return null
  const body = rest.slice(0, dot)
  const sig = rest.slice(dot + 1)
  const expected = Buffer.from(sign(body))
  const actual = Buffer.from(sig)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || payload.v !== 1 || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null

  const account = accountsArray().find((a) => a.id === payload.uid)
  if (!account || !account.enabled) return null
  // 签名里的 role 只作提示，以库中当前角色为准（管理员被降级后旧令牌不能继续越权）
  if ((Number(account.password_version) || 1) !== (Number(payload.pv) || 1)) return null
  return { account, role: account.role }
}

// ---------------------------------------------------------------------------
// 序列化（密码摘要绝不出现在任何响应里）
// ---------------------------------------------------------------------------

export function serializeAccount(a) {
  return {
    id: a.id,
    username: a.username,
    role: a.role === 'admin' ? 'admin' : 'user',
    enabled: a.enabled !== false,
    note: String(a.note || ''),
    // 余额微点：用户面板展示、管理员充值都用这一个整数口径，见 billing.js
    balance_micro: Math.trunc(Number(a.balance_micro) || 0),
    created_at: Number(a.created_at) || 0,
    last_login_at: Number(a.last_login_at) || 0,
    password_version: Number(a.password_version) || 1
  }
}

export function authStatus() {
  return {
    initialized: accountsArray().length > 0,
    password_min_length: PASSWORD_MIN,
    password_max_length: PASSWORD_MAX,
    session_ttl_hours: SESSION_TTL_HOURS,
    roles: ['admin', 'user'],
    // 保留通道：现有部署脚本、文档与 CI 全部用 X-Admin-Key，升级后继续有效
    admin_key_fallback: true
  }
}

function activeAdminCount() {
  return accountsArray().filter((a) => a.role === 'admin' && a.enabled !== false).length
}

function findAccount(id) {
  const a = accountsArray().find((x) => x.id === id)
  if (!a) throw fail(404, '账号不存在')
  return a
}

// ---------------------------------------------------------------------------
// 首次引导：用现有管理密钥「认领」第一个管理员
//
// 为什么必须带管理密钥：网关常直接暴露在公网，若首次访问者能免密注册管理员，
// 等于把整台机器送给第一个扫到端口的人。复用已存在且只在服务端/日志里的
// admin_api_key 作认领凭证，老部署无需改任何环境变量即可平滑升级。
// ---------------------------------------------------------------------------

export function setupAdmin({ username, password, adminKey }) {
  if (authStatus().initialized) throw fail(409, '管理员账号已初始化，请直接登录')
  if (!adminKey || !safeEqual(adminKey, getAdminKey())) {
    throw fail(401, '管理密钥不正确，请在服务端启动日志或 config.json 的 admin_api_key 中查看')
  }
  const name = validateUsername(username)
  const pw = validatePassword(password)
  const { salt, hash } = hashPassword(pw)
  const account = {
    id: genId(),
    username: name,
    password_salt: salt,
    password_hash: hash,
    password_version: 1,
    role: 'admin',
    enabled: true,
    note: '初始化管理员',
    balance_micro: 0,
    created_at: Date.now(),
    last_login_at: Date.now()
  }
  accountsArray().push(account)
  persistImmediate()
  return { token: createSession(account), account: serializeAccount(account) }
}

// ---------------------------------------------------------------------------
// 登录 / 改密
// ---------------------------------------------------------------------------

function rateKey(ip, name) {
  return `${String(ip || '?')}|${name}`
}

function checkRateLimit(key) {
  const now = Date.now()
  const rec = failures.get(key)
  if (!rec) return
  if (now >= rec.resetAt) { failures.delete(key); return }
  if (rec.count >= MAX_FAILURES) {
    throw fail(429, `登录失败次数过多，请 ${Math.ceil((rec.resetAt - now) / 1000)} 秒后重试`)
  }
}

function recordFailure(key) {
  const now = Date.now()
  let rec = failures.get(key)
  if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + LOCK_MS }
  rec.count += 1
  failures.set(key, rec)
}

export function login({ username, password }, clientIp) {
  const name = normalizeUsername(username)
  const key = rateKey(clientIp, name)
  checkRateLimit(key)

  const account = accountsArray().find((a) => a.username === name)
  const ok = account && account.enabled !== false &&
    verifyPassword(String(password ?? ''), account.password_salt, account.password_hash)
  if (!ok) {
    recordFailure(key)
    throw fail(401, '用户名或密码错误，或账号已停用')
  }

  failures.delete(key)
  account.last_login_at = Date.now()
  persistImmediate()
  return { token: createSession(account), account: serializeAccount(account), session_ttl_hours: SESSION_TTL_HOURS }
}

export function changeOwnPassword(accountId, { oldPassword, newPassword }) {
  const account = findAccount(accountId)
  if (!verifyPassword(String(oldPassword ?? ''), account.password_salt, account.password_hash)) {
    throw fail(401, '当前密码不正确')
  }
  const pw = validatePassword(newPassword)
  const { salt, hash } = hashPassword(pw)
  account.password_salt = salt
  account.password_hash = hash
  account.password_version = (Number(account.password_version) || 1) + 1
  persistImmediate()
  // 返回一个新令牌，避免「改完密码自己被踢下线还要再登一次」
  return { token: createSession(account), account: serializeAccount(account) }
}

// ---------------------------------------------------------------------------
// 管理员对账号的增删改
// ---------------------------------------------------------------------------

export function listAccounts() {
  return accountsArray().map(serializeAccount)
}

export function createAccount({ username, password, role = 'user', note = '' }) {
  const name = validateUsername(username)
  const pw = validatePassword(password)
  if (!['admin', 'user'].includes(role)) throw fail(400, '角色只能是 admin 或 user')
  if (accountsArray().some((a) => a.username === name)) throw fail(409, `用户名「${name}」已存在`)

  const { salt, hash } = hashPassword(pw)
  const account = {
    id: genId(),
    username: name,
    password_salt: salt,
    password_hash: hash,
    password_version: 1,
    role,
    enabled: true,
    note: String(note || '').slice(0, 200),
    // 新账号初始余额为 0、初始无密钥：用户面板显示空态，充值并生成密钥后才能调用
    balance_micro: 0,
    created_at: Date.now(),
    last_login_at: 0
  }
  accountsArray().push(account)
  persistImmediate()
  return serializeAccount(account)
}

export function updateAccount(id, patch, actorId) {
  const account = findAccount(id)
  const wasActiveAdmin = account.role === 'admin' && account.enabled !== false
  const nextRole = patch.role === undefined ? account.role : patch.role
  const nextEnabled = patch.enabled === undefined ? account.enabled !== false : Boolean(patch.enabled)
  if (!['admin', 'user'].includes(nextRole)) throw fail(400, '角色只能是 admin 或 user')

  // 不能把自己降级：否则当前会话下一次请求就 403，界面直接锁死
  if (actorId === id && nextRole !== 'admin') throw fail(400, '不能把自己的账号改为普通用户')
  // 系统里必须始终留一个可用的管理员，否则整套管理界面再也进不去
  if (wasActiveAdmin && (nextRole !== 'admin' || !nextEnabled) && activeAdminCount() <= 1) {
    throw fail(400, '至少保留一个启用中的管理员账号')
  }

  account.role = nextRole
  account.enabled = nextEnabled
  if (patch.note !== undefined) account.note = String(patch.note || '').slice(0, 200)
  persistImmediate()
  return serializeAccount(account)
}

export function deleteAccount(id, actorId) {
  const account = findAccount(id)
  if (actorId === id) throw fail(400, '不能删除当前登录的账号')
  if (account.role === 'admin' && account.enabled !== false && activeAdminCount() <= 1) {
    throw fail(400, '至少保留一个启用中的管理员账号')
  }
  const idx = accountsArray().findIndex((a) => a.id === id)
  accountsArray().splice(idx, 1)
  persistImmediate()
  return { ok: true }
}

export function resetAccountPassword(id, newPassword) {
  const account = findAccount(id)
  const pw = validatePassword(newPassword)
  const { salt, hash } = hashPassword(pw)
  account.password_salt = salt
  account.password_hash = hash
  account.password_version = (Number(account.password_version) || 1) + 1
  persistImmediate()
  return serializeAccount(account)
}
