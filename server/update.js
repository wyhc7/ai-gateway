// 系统更新：检查上游仓库有没有新提交，并把「更新内容」原样呈现到管理界面。
//
// 三个取舍：
// 1) 版本基准用本仓库的 git HEAD，不另立版本号——手写的版本号一定会忘记改，
//    而 HEAD 天然回答「这份代码是从哪个提交来的」。
// 2) 比对走 git fetch + git log/diff，不走 GitHub API：API 有速率限制、私有仓库
//    还要 token，而 git 这条路对任何远程（自建镜像、内网 Gitea）行为一致。
// 3) 更新只做快进合并（--ff-only），永不 reset --hard——网页上的一个按钮不该有
//    把服务器本地改动冲掉的能力；工作区有未提交改动时直接拒绝，交回给人决定。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export const CHECK_TTL_MS = 60 * 1000
export const GIT_TIMEOUT_MS = 20 * 1000
export const NPM_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_COMMITS = 50

/** 仓库根目录。默认取 server/ 的上一级；测试用 UPDATE_REPO_DIR 指向临时仓库。 */
export function repoDir() {
  return resolve(process.env.UPDATE_REPO_DIR || join(HERE, '..'))
}

export function updateBranch() {
  return process.env.UPDATE_BRANCH || 'main'
}

export function serviceUnit() {
  return process.env.UPDATE_SERVICE || 'ai-gateway'
}

// ---------------------------------------------------------------------------
// 纯函数：不碰磁盘与网络，全部可单测
// ---------------------------------------------------------------------------

/** 界面上指代一个版本一律用 7 位短 sha，和 git 自己的习惯一致。 */
export function shortSha(sha) {
  return String(sha || '').trim().slice(0, 7)
}

/**
 * 从 `git status --porcelain` 里挑出「已跟踪文件被改动」的路径。
 *
 * 必须忽略 `??` 未跟踪项：部署目录里天然存在 data/、web/dist/、web/dist.bak.*
 * 这些运行时产物，把它们算成「工作区脏」会让更新永远被自己拒绝。
 * 只有已跟踪文件被改才真正影响快进合并。
 */
export function dirtyTrackedPaths(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '' && !line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

/** 解析 `git log -z --format=%H%x1f%h%x1f%cI%x1f%an%x1f%s`。 */
export function parseCommitLog(stdout) {
  return String(stdout || '')
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [revision = '', short = '', date = '', author = '', subject = ''] = record.split('\x1f')
      return { revision, short, date, author, subject }
    })
    .filter((c) => c.revision)
}

/** 解析 `git diff --name-only -z`。用 -z 是因为文件名里可能有空格。 */
export function parseChangedFiles(stdout) {
  return String(stdout || '')
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean)
}

const AREA_RULES = [
  { key: 'server', label: '后端', test: (p) => p.startsWith('server/') },
  { key: 'web', label: '管理界面', test: (p) => p.startsWith('web/') },
  { key: 'deploy', label: '部署脚本', test: (p) => p.startsWith('deploy/') },
  { key: 'docs', label: '文档', test: (p) => p.startsWith('docs/') || /\.md$/i.test(p) }
]

/** 把变更文件按「改了哪一块」归类，界面上一眼看出这次更新动了什么。 */
export function summarizeAreas(paths) {
  const list = Array.isArray(paths) ? paths : []
  const out = []
  const claimed = new Set()
  for (const rule of AREA_RULES) {
    const hit = list.filter((p) => rule.test(p))
    hit.forEach((p) => claimed.add(p))
    if (hit.length) out.push({ key: rule.key, label: rule.label, count: hit.length })
  }
  const rest = list.length - claimed.size
  if (rest > 0) out.push({ key: 'other', label: '其它', count: rest })
  return out
}

/**
 * 由变更文件推断这次更新要做哪些重活。
 *
 * 只改后端 JS 时跳过前端构建，一次更新从一分钟压到几秒；但依赖清单变了就必须
 * 重装——否则新代码 import 不到新包，服务重启后直接起不来，比不更新更糟。
 */
export function planSteps(paths) {
  const list = Array.isArray(paths) ? paths : []
  const touches = (re) => list.some((p) => re.test(p))
  return {
    installServer: touches(/^server\/package(-lock)?\.json$/),
    installWeb: touches(/^web\/package(-lock)?\.json$/),
    buildWeb: touches(/^web\//)
  }
}

// ---------------------------------------------------------------------------
// git / npm 调用层
// ---------------------------------------------------------------------------

/**
 * 统一的 git 调用入口。
 *
 * GIT_TERMINAL_PROMPT=0 是必须的：服务器上没有凭据助手，私有仓库或断网时 git
 * 会停下来等输入用户名密码，把一次「检查更新」挂成永久 pending。
 * safe.directory 是为了绕过「仓库属主与进程用户不一致」时 git 的拒绝执行——
 * 部署脚本 chown 给 ai-gateway，而手工排障时可能以 root 跑。
 */
async function git(args, { timeout = GIT_TIMEOUT_MS } = {}) {
  const dir = repoDir()
  const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${dir}`, '-C', dir, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  })
  return stdout
}

/**
 * npm 的启动方式。
 *
 * 直接跑 npm 的 JS 入口（node + npm-cli.js），而不是它的 .cmd / .sh 外壳，两个原因：
 * 1) Windows 上 Node 从 CVE-2024-27980 起拒绝不经 shell 直接 spawn .cmd，会抛 EINVAL；
 * 2) 走 node 本体还顺带钉死了 npm 版本与正在跑网关的 node 一致，不会因为 PATH 上
 *    串进另一个 node 而用错版本装依赖。
 */
function npmCommand() {
  const isWin = process.platform === 'win32'
  const dir = dirname(process.execPath)
  // 标准安装：<node>/lib/node_modules/npm（POSIX）· <node>/node_modules/npm（Windows）
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ]
  for (const cli of candidates) {
    if (existsSync(cli)) return { command: process.execPath, args: [cli] }
  }
  // 退路：交给 PATH 上的 npm（Windows 下必须开 shell，否则又是 EINVAL）
  return { command: isWin ? 'npm.cmd' : 'npm', args: [], shell: isWin }
}

function systemctlBin() {
  for (const p of ['/usr/bin/systemctl', '/bin/systemctl']) {
    if (existsSync(p)) return p
  }
  return 'systemctl'
}

async function runNpm(args) {
  const { command, args: prefix, shell } = npmCommand()
  const { stdout, stderr } = await execFileAsync(command, [...prefix, ...args], {
    cwd: repoDir(),
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    shell,
    // 把 running node 的目录顶到 PATH 最前面。npm 自己是用 process.execPath 跑的，
    // 但它拉起的脚本（vite 等）是靠 shebang `#!/usr/bin/env node` 找 node 的，
    // 而 systemd 服务的 PATH 里通常没有 nvm 的 bin 目录——实测会落到系统自带的
    // node v12 上，vite 的顶层 await 直接语法错误。既然用哪个 node 跑 npm，
    // 就必须让脚本也解析到同一个 node。
    env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) }
  })
  return `${stdout || ''}${stderr || ''}`.trim()
}

async function isShallow() {
  try {
    return (await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true'
  } catch {
    return false
  }
}

/** 拉取远程分支。浅克隆要先补全历史，否则快进合并缺少 merge base 会失败。 */
async function fetchRemote(branch) {
  const shallow = await isShallow()
  const base = ['fetch', '--quiet', '--no-tags']
  try {
    await git(shallow ? [...base, '--unshallow', 'origin', branch] : [...base, 'origin', branch])
  } catch (err) {
    // 补全过的浅克隆再跑 --unshallow 会报错，退回普通 fetch
    if (!shallow) throw err
    await git([...base, 'origin', branch])
  }
}

// ---------------------------------------------------------------------------
// 读取本地版本
// ---------------------------------------------------------------------------

export async function readLocal() {
  const dir = repoDir()
  if (!existsSync(join(dir, '.git'))) {
    return { isRepo: false, dir }
  }

  let revision = ''
  try {
    revision = (await git(['rev-parse', 'HEAD'])).trim()
  } catch (err) {
    // 空仓库（还没有任何提交）也会走到这里
    return { isRepo: false, dir, reason: 'no-head', message: err.message }
  }

  const meta = await git(['log', '-1', '--format=%cI%x1f%an%x1f%s'])
  const [date = '', author = '', subject = ''] = meta.trim().split('\x1f')

  const dirty = dirtyTrackedPaths(await git(['status', '--porcelain']))

  let branch = ''
  try {
    branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    /* 分离头指针时取不到分支名，不影响比对 */
  }

  let remote = ''
  try {
    remote = (await git(['remote', 'get-url', 'origin'])).trim()
  } catch {
    /* 没有 origin 时下面会明确拒绝更新 */
  }

  return {
    isRepo: true,
    dir,
    revision,
    short: shortSha(revision),
    date,
    author,
    subject,
    branch,
    remote,
    dirty,
    shallow: await isShallow()
  }
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 上次成功部署到哪个提交
//
// 只靠「HEAD 是否等于上游」判断要不要更新是不够的：合并成功、构建失败时 HEAD 已经
// 等于上游了，界面会显示「已是最新」，而实际跑的仍是旧产物——那样就再也点不动更新，
// 只能上服务器手工修。所以额外记一笔「上次真正部署成功的是哪个提交」。
// 这份记录只在一次完整成功的部署之后写入；没有记录就不做任何断言，不误报。
// ---------------------------------------------------------------------------

export function deployedRecordPath() {
  const dir = process.env.DATA_DIR || join(repoDir(), 'data')
  return join(dir, 'deployed-revision.json')
}

export function readDeployed() {
  try {
    const parsed = JSON.parse(readFileSync(deployedRecordPath(), 'utf8'))
    return typeof parsed?.revision === 'string' && parsed.revision ? parsed : null
  } catch {
    return null
  }
}

function writeDeployed(revision) {
  try {
    const file = deployedRecordPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ revision, at: new Date().toISOString() }, null, 2))
    return true
  } catch {
    // 记录写不进去不该让一次已经成功的部署变成失败，只是下次少了这层保护
    return false
  }
}

let cache = { at: 0, value: null }

/** 测试与「立即更新」后复用：丢掉缓存，强制下次重新比对。 */
export function clearUpdateCache() {
  cache = { at: 0, value: null }
}

export async function checkUpdate({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value && now - cache.at < CHECK_TTL_MS) {
    return { ...cache.value, cached: true }
  }
  const value = await computeCheck()
  cache = { at: now, value }
  return { ...value, cached: false }
}

async function computeCheck() {
  const branch = updateBranch()
  let local
  try {
    local = await readLocal()
  } catch (err) {
    return { ok: false, reason: 'git-unavailable', message: `无法读取本地版本：${err.message}` }
  }

  if (!local.isRepo) {
    return {
      ok: false,
      reason: 'not-a-git-repo',
      message: '当前部署目录不是 git 仓库，无法自动比对与更新。请用 deploy/linux/complete-deploy.sh --update 更新。',
      repo_dir: local.dir,
      current: { short: '未知', dirty: [] }
    }
  }

  const base = {
    ok: true,
    repo_dir: local.dir,
    branch,
    remote: local.remote,
    current: {
      revision: local.revision,
      short: local.short,
      date: local.date,
      author: local.author,
      subject: local.subject,
      branch: local.branch,
      dirty: local.dirty,
      shallow: local.shallow
    }
  }

  if (!local.remote) {
    return { ...base, ok: false, reason: 'no-remote', message: '仓库没有配置 origin 远程，无法比对上游。' }
  }

  try {
    await fetchRemote(branch)
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: 'fetch-failed',
      message: `拉取远程失败：${commandError(err)}`
    }
  }

  const remoteSha = (await git(['rev-parse', 'FETCH_HEAD'])).trim()
  const behind = Number((await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim()) || 0
  const ahead = Number((await git(['rev-list', '--count', 'FETCH_HEAD..HEAD'])).trim()) || 0

  const remoteMeta = (await git(['log', '-1', '--format=%cI%x1f%an%x1f%s', remoteSha])).trim()
  const [remoteDate = '', remoteAuthor = '', remoteSubject = ''] = remoteMeta.split('\x1f')

  // 上一次部署没跑完（合并成功、构建失败）时，HEAD 已经等于上游，光看 behind
  // 会显示「已是最新」而实际跑的是旧产物，用户再也点不动更新。
  const deployedRevision = readDeployed()?.revision || null
  const staleDeploy = Boolean(deployedRevision && deployedRevision !== local.revision)
  const hasUpdate = behind > 0 || staleDeploy

  // 变更面：正常情况下是「本地 HEAD → 上游」；补做部署时是「上次部署成功的提交 → HEAD」。
  // 后者不能漏——这时 diff(HEAD, 上游) 是空的，界面会显示「无需任何步骤」，
  // 而实际执行时却要重新构建。两处必须同源。
  const resuming = staleDeploy && behind === 0
  const diffFrom = resuming ? deployedRevision : 'HEAD'
  const diffTo = resuming ? 'HEAD' : remoteSha

  // 最新的排在前面，界面上先看到刚加的
  let commits = []
  let paths = []
  try {
    commits = parseCommitLog(
      await git(['log', '-z', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%cI%x1f%an%x1f%s', `${diffFrom}..${diffTo}`])
    ).reverse()
    paths = parseChangedFiles(await git(['diff', '--name-only', '-z', diffFrom, diffTo]))
  } catch {
    // 记录里的提交已经不在仓库里了（例如被强推覆盖），退回按「本地 → 上游」比对
    commits = parseCommitLog(
      await git(['log', '-z', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%cI%x1f%an%x1f%s', 'HEAD..FETCH_HEAD'])
    ).reverse()
    paths = parseChangedFiles(await git(['diff', '--name-only', '-z', 'HEAD', remoteSha]))
  }

  const blockers = []
  if (local.dirty.length) {
    blockers.push(`工作区有 ${local.dirty.length} 个已跟踪文件被改动（${local.dirty.slice(0, 3).join('、')}${local.dirty.length > 3 ? ' 等' : ''}），为避免覆盖已中止`)
  }
  if (ahead > 0) {
    blockers.push(`本地有 ${ahead} 个未推送的提交，快进合并会失败`)
  }

  return {
    ...base,
    latest: {
      revision: remoteSha,
      short: shortSha(remoteSha),
      date: remoteDate,
      author: remoteAuthor,
      subject: remoteSubject
    },
    has_update: hasUpdate,
    stale_deploy: staleDeploy,
    deployed_revision: deployedRevision,
    behind,
    ahead,
    commits,
    truncated: behind > commits.length,
    files: { total: paths.length, paths: paths.slice(0, 200) },
    areas: summarizeAreas(paths),
    plan: planSteps(paths),
    can_update: hasUpdate && blockers.length === 0,
    blocked_reason: blockers.length ? blockers.join('；') : null,
    restart: { unit: serviceUnit(), auto: process.env.UPDATE_NO_RESTART !== '1' }
  }
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) || '未知错误'
}

/**
 * 把子进程的错误压成一段能诊断的文字。
 *
 * err.message 只有「Command failed: <命令行>」，真正说明原因的报错在 stderr 里。
 * 只取 message 的第一行等于把「为什么失败」整段丢掉——实测就因此把一个 node
 * 版本导致的 SyntaxError 藏了起来，只剩下一行看不出所以然的命令。取尾部是因为
 * 构建类错误总在最后。
 */
export function commandError(err) {
  const detail = [String(err?.stdout || ''), String(err?.stderr || '')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  const text = detail || firstLine(err?.message)
  const MAX = 1500
  return text.length > MAX ? `…${text.slice(-MAX)}` : text
}

// ---------------------------------------------------------------------------
// 执行更新
// ---------------------------------------------------------------------------

/**
 * 通知 systemd 重启本服务。
 *
 * --no-block 是关键：同步等待的话，systemd 停止本服务时会向本进程发 SIGTERM，
 * 我们自己发起的那次重启会在半路被打断，服务停在停止状态起不来。
 * 加上 --no-block，任务交给 PID 1 托管，本进程随后被杀也不影响它跑完。
 */
async function triggerRestart() {
  const unit = serviceUnit()
  if (process.env.UPDATE_NO_RESTART === '1') {
    return { ok: false, mode: 'skipped', unit, message: `已配置为不自动重启（UPDATE_NO_RESTART=1），请手动执行 systemctl restart ${unit}` }
  }
  try {
    await execFileAsync(systemctlBin(), ['--no-block', 'restart', unit], { timeout: 10 * 1000, windowsHide: true })
    return { ok: true, mode: 'systemd', unit, message: `已通知 systemd 重启 ${unit}` }
  } catch (err) {
    return {
      ok: false,
      mode: 'manual',
      unit,
      message: `自动重启失败（${commandError(err)}）。代码已更新，请手动执行 systemctl restart ${unit} 让新版本生效。`
    }
  }
}

/**
 * 执行一次更新。
 *
 * 失败时也返回 HTTP 200：请求本身没出错，出错的是更新过程，而前端需要拿到完整
 * 的步骤日志才能指出卡在哪一步——走 error.message 通道会把细节全丢掉。
 */
export async function applyUpdate() {
  const steps = []
  // 合并成功之后才可能失败在装依赖/构建上。这时代码已经进来了，只是新版本的
  // 运行条件没备齐——把这一点单独告诉前端，人才知道该「修完重试」而不是「重头再来」。
  let mergedTo = null
  const done = (name, detail) => steps.push({ name, ok: true, detail })
  const fail = (name, detail) => {
    steps.push({ name, ok: false, detail })
    return { ok: false, message: detail, steps, merged_to: mergedTo }
  }

  clearUpdateCache()

  let local
  try {
    local = await readLocal()
  } catch (err) {
    return fail('读取本地版本', `无法读取本地版本：${err.message}`)
  }

  if (!local.isRepo) {
    return fail('读取本地版本', '当前部署目录不是 git 仓库，无法自动更新。请用 deploy/linux/complete-deploy.sh --update。')
  }
  if (local.dirty.length) {
    return fail('检查工作区', `工作区有未提交的改动（${local.dirty.slice(0, 5).join('、')}），已中止以免覆盖。请先提交或还原后再更新。`)
  }
  if (!local.remote) {
    return fail('检查远程', '仓库没有配置 origin 远程，无法拉取更新。')
  }

  const branch = updateBranch()
  const before = local.revision
  const deployedRevision = readDeployed()?.revision || null

  try {
    await fetchRemote(branch)
    done('拉取远程代码', `origin/${branch}`)
  } catch (err) {
    return fail('拉取远程代码', `拉取失败：${commandError(err)}`)
  }

  const target = (await git(['rev-parse', 'FETCH_HEAD'])).trim()
  const behind = Number((await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim()) || 0

  // 上一次部署没跑完：代码已经合并进来了，但依赖/构建那几步失败了。
  // 这时没有东西可以合并，该做的是把没跑完的步骤补上，而不是报「已是最新」。
  const resumeDeploy = !behind && Boolean(deployedRevision && deployedRevision !== before)

  if (!behind && !resumeDeploy) {
    done('比对版本', '已是最新，无需更新')
    return { ok: true, up_to_date: true, from: shortSha(before), to: shortSha(before), steps, restart: { ok: true, mode: 'none', message: '未做任何改动' } }
  }

  // 变更面：正常更新看「合并前 → 目标」；补做部署看「上次部署成功的提交 → 当前 HEAD」。
  // 后者能精确算出还欠哪几步，不至于每次都全量重装。
  const diffFrom = resumeDeploy ? deployedRevision : before
  const diffTo = resumeDeploy ? before : target
  let paths = []
  let commits = []
  let plan = { installServer: true, installWeb: true, buildWeb: true }
  let comparable = true
  try {
    await git(['cat-file', '-e', `${diffFrom}^{commit}`])
    paths = parseChangedFiles(await git(['diff', '--name-only', '-z', diffFrom, diffTo]))
    commits = parseCommitLog(
      await git(['log', '-z', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%cI%x1f%an%x1f%s', `${diffFrom}..${diffTo}`])
    ).reverse()
    plan = planSteps(paths)
  } catch {
    // 记录里的提交已经不在仓库里了（例如被强推覆盖），无法比对，改为全量重跑
    comparable = false
  }

  if (resumeDeploy) {
    mergedTo = shortSha(before)
    done('比对版本', comparable
      ? `上次部署停在 ${shortSha(deployedRevision)}，补做后续步骤（${paths.length} 个文件）`
      : `无法比对到 ${shortSha(diffFrom)}，改为全量重跑`)
  } else {
    try {
      await git(['merge', '--ff-only', target])
      mergedTo = shortSha(target)
      done('合并代码', `${shortSha(before)} → ${mergedTo}（${paths.length} 个文件）`)
    } catch (err) {
      return fail('合并代码', `快进合并失败：${commandError(err)}`)
    }
  }

  if (plan.installServer) {
    try {
      await runNpm(['install', '--prefix', 'server', '--omit=dev'])
      done('安装后端依赖', 'server/package.json 有变动')
    } catch (err) {
      return fail('安装后端依赖', `npm install 失败：${commandError(err)}`)
    }
  }

  if (plan.installWeb) {
    try {
      await runNpm(['install', '--prefix', 'web'])
      done('安装前端依赖', 'web/package.json 有变动')
    } catch (err) {
      return fail('安装前端依赖', `npm install 失败：${commandError(err)}`)
    }
  }

  if (plan.buildWeb) {
    try {
      await runNpm(['run', 'build', '--prefix', 'web'])
      done('构建管理界面', 'web/ 有变动')
    } catch (err) {
      return fail('构建管理界面', `前端构建失败：${commandError(err)}`)
    }
  } else {
    done('构建管理界面', '本次未改动前端，已跳过')
  }

  const restart = await triggerRestart()
  steps.push({ name: '重启服务', ok: restart.ok, detail: restart.message })

  // 只有全部步骤都跑完才记这一笔——它同时是「下次还要不要更新」的判据。
  // 上面任何一步提前 return 都不会走到这里，于是下次检查会如实报告「部署未完成」。
  const recorded = writeDeployed(target)

  return {
    ok: true,
    from: shortSha(before),
    to: shortSha(target),
    resumed: resumeDeploy,
    deployed_recorded: recorded,
    commits,
    files: paths.length,
    steps,
    restart
  }
}
