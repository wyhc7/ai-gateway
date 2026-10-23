// 部署目录属主自愈。
//
// 起因：手工排障时用 root 跑过 `git reset --hard` + `npm run build`，于是
// /opt/ai-gateway 下一批文件变成 root:root。而服务与「网页一键更新」都以
// ai-gateway 用户跑，结果是：
//
//   EACCES: permission denied, unlink '/opt/ai-gateway/web/dist/assets/index-xxx.css'
//   fatal: Unable to create '/opt/ai-gateway/.git/index.lock'
//
// 更坑的是这类失败是**一串**的：修好 dist，下一步装依赖又栽在 node_modules，
// 再下一步栽在 .git/index。用户看到的是「更新失败」，但根因只有一条。
//
// 所以更新流程在动手前先体检：扫出不属于服务账号的路径，趁还在 root 权限下
// （systemd 的 ExecStartPre 或用户显式 sudo）一次性 chown 回来，然后再 git
// 与 build。不能指望每次都由人来 chown。
//
// 边界：本模块只负责「找出问题、给出命令」，实际 chown 由调用方按权限决定，
// 因此纯函数部分完全可单测，不需要 root。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

// 服务账号。与 deploy/linux 里的 systemd 单元保持一致，可用环境变量覆盖。
export const DEFAULT_SERVICE_USER = 'ai-gateway'

// sudo 免密白名单里的命令路径。部署脚本会往 /etc/sudoers.d 写一条
// 「ai-gateway 可免密执行 chown -R ai-gateway:ai-gateway <仓库>」，
// 这里的路径必须和那条 NOPASSWD 规则里的完全一致，否则 sudo 会按规则不匹配拒绝。
export const SUDO_CHOWN = '/usr/bin/chown'

// 扫描深度上限：仓库是有限深度，超过就是不认识的深层产物，不值得为它遍历。
export const MAX_SCAN_DEPTH = 6

// 扫描时跳过的目录。node_modules 动辄几万文件，而它属于「装错了重装即可」，
// 真被 root 占了会由 npm install 那一步自己暴露，不值得拖慢体检。
const SKIP_DIRS = new Set(['node_modules', '.git/objects'])

export function serviceUser() {
  return process.env.UPDATE_SERVICE_USER || DEFAULT_SERVICE_USER
}

/**
 * 扫描目录，返回不属于 expectUser 的路径（相对仓库根）。
 *
 * 只扫目录自身与常规文件，符号链接按链接本身判断（不算跟随）。
 * 深度受限，且跳过 node_modules —— 目的是「快速判断有没有被 root 污染」，
 * 不是做完整性审计。
 *
 * Windows 直接返回空：那里没有 POSIX 属主，statSync 的 uid 恒为 0，
 * 照字面比较会把每个文件都判成「属主异常」。
 */
export function findForeignOwners(root, expectUser = serviceUser(), { maxDepth = MAX_SCAN_DEPTH } = {}) {
  if (process.platform === 'win32') return []
  const bad = []
  const walk = (dir, depth, rel) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 读不了本身就是一种异常（权限不对），记下来
      bad.push(rel || '.')
      return
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (SKIP_DIRS.has(ent.name)) continue
      const abs = join(dir, ent.name)
      let st
      try {
        st = statSync(abs, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (!st) continue
      if (st.uid !== undefined) {
        let owner = ''
        try {
          // 用 uid 反查用户名：数字 uid 对用户没有意义
          owner = ownerNameOf(st.uid)
        } catch {
          owner = String(st.uid)
        }
        if (owner !== expectUser) bad.push(childRel)
      }
      if (ent.isDirectory()) walk(abs, depth + 1, childRel)
    }
  }
  // 根目录自身也要判断：整个仓库被 root 占了时，子项扫下去全是坏点，
  // 但先报出根目录更利于定位。
  try {
    const st = statSync(root, { throwIfNoEntry: false })
    if (st && st.uid !== undefined && ownerNameOf(st.uid) !== expectUser) bad.unshift('.')
  } catch {
    /* 根都读不了，交给下面的 walk 报 */
  }
  walk(root, 0, '')
  return bad
}

// uid → owner 名的小缓存。一次更新会问几千次同一个 uid，不值得反复起进程。
const uidCache = new Map()

function ownerNameOf(uid) {
  if (uidCache.has(uid)) return uidCache.get(uid)
  let name
  try {
    // 同步读 /etc/passwd：比 spawn `id -nu <uid>` 快几个数量级，
    // 而且不依赖 PATH 上有 id。
    const line = passwdLines().find((l) => l.split(':')[2] === String(uid))
    name = line ? line.split(':')[0] : String(uid)
  } catch {
    name = String(uid)
  }
  uidCache.set(uid, name)
  return name
}

// /etc/passwd 只读一次。改名/加用户极少发生在一次更新的生命周期里。
let passwdCache = null
function passwdLines() {
  if (passwdCache === null) {
    passwdCache = readFileSync('/etc/passwd', 'utf8').split('\n').filter(Boolean)
  }
  return passwdCache
}

/**
 * 生成修复命令。界面与日志里展示给人看，也方便人工复核后再执行。
 */
export function chownCommand(root, user = serviceUser()) {
  return `chown -R ${user}:${user} ${root}`
}

/** 面板里走 sudo 的那条命令（与服务端实际执行的形式一致）。 */
export function sudoChownCommand(root, user = serviceUser()) {
  return `sudo -n ${SUDO_CHOWN} -R ${user}:${user} ${root}`
}

/**
 * 修正属主。
 *
 * 三条路径，按权限从高到低：
 *   1. 自己是 root  → 直接 chown
 *   2. 不是 root     → 试 `sudo -n`（部署脚本写了 NOPASSWD 白名单才能成）
 *   3. 都失败        → 不抛异常，返回 not-root 并把命令交给用户
 *
 * 第 3 条刻意不抛：体检失败不该把整次更新拦死，多数情况下 git 与 build
 * 仍然能跑完，让更新先进行比直接中止更有用。
 */
export async function repairOwnership(root, user = serviceUser()) {
  if (process.platform === 'win32') {
    return { ok: false, reason: 'windows', message: 'Windows 无 POSIX 属主概念，跳过' }
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const opts = { timeout: 120 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }

  if (isRoot) {
    try {
      await execFileAsync('chown', ['-R', `${user}:${user}`, root], opts)
      return { ok: true, via: 'root', message: `已把 ${root} 的属主修正为 ${user}:${user}` }
    } catch (e) {
      return {
        ok: false,
        reason: 'failed',
        message: `chown 失败：${String(e?.stderr || e?.message || e).slice(0, 500)}`
      }
    }
  }

  // 非 root：试免密 sudo。-n 是关键，没有它 sudo 会停下来等密码，
  // 把一次「网页点更新」挂成永久 pending —— 和 git 那侧的 GIT_TERMINAL_PROMPT=0 同理。
  try {
    await execFileAsync('sudo', ['-n', SUDO_CHOWN, '-R', `${user}:${user}`, root], opts)
    return { ok: true, via: 'sudo', message: `已通过 sudo 把 ${root} 的属主修正为 ${user}:${user}` }
  } catch (e) {
    const raw = String(e?.stderr || e?.message || e)
    // sudo 根本没装（容器里常见）：ENOENT，和权限不足要分开说
    if (e?.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'sudo-missing',
        message: `没装 sudo，无法自动修正属主。请手工执行：${chownCommand(root, user)}`
      }
    }
    const needsPasswd = /password is required|a terminal is required/i.test(raw)
    return {
      ok: false,
      reason: needsPasswd ? 'sudo-needs-password' : 'sudo-denied',
      message: needsPasswd
        ? `没有免密 sudo 权限，无法自动修正属主。请手工执行：${chownCommand(root, user)}；或按 docs/DEPLOY-OWNERSHIP.md 配好白名单`
        : `sudo 修正属主失败（${raw.slice(0, 200)}）。请手工执行：${chownCommand(root, user)}`
    }
  }
}

/**
 * 体检 + 自愈，更新流程开头调用。
 *
 * 返回：
 *   { needed, before, after, repaired, detail }
 * needed 表示本次是否发现并处理过属主问题；detail 直接进步骤日志。
 */
export async function ensureOwnership(root, user = serviceUser()) {
  const before = findForeignOwners(root, user)
  if (before.length === 0) {
    return { needed: false, before: [], after: [], repaired: false, detail: `属主正常（${user}）` }
  }
  const sample = before.slice(0, 3).join('、')
  const more = before.length > 3 ? ` 等 ${before.length} 个` : ''
  const fixed = await repairOwnership(root, user)
  if (!fixed.ok) {
    return {
      needed: true,
      before,
      after: before,
      repaired: false,
      detail: `发现 ${before.length} 个文件属主不是 ${user}（${sample}${more}），${fixed.message}`
    }
  }
  const after = findForeignOwners(root, user)
  return {
    needed: true,
    before,
    after,
    repaired: after.length === 0,
    detail: after.length === 0
      ? `已修正 ${before.length} 个文件的属主（${sample}${more}）为 ${user}:${user}`
      : `修正后仍有 ${after.length} 个文件属主异常，请手工检查`
  }
}
