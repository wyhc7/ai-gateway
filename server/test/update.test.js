// 系统更新测试
//
// 覆盖两层：
// 1) 纯函数层：sha 归一、工作区脏判定、git 输出解析、影响面推断、步骤编排
// 2) 真实 git 层：在临时目录里搭一对「裸库当远程 + 工作库当部署目录」，
//    走完整链路验证比对、拒绝更新、快进合并。全程离线，不碰网络也不碰 systemd。
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 先钉死环境：这三条必须在 import update.js 之前设好，
// 尤其 UPDATE_NO_RESTART —— 测试绝不允许真的去重启服务器上的服务。
const SANDBOX = mkdtempSync(join(tmpdir(), 'gw-update-sandbox-'))
process.env.UPDATE_REPO_DIR = SANDBOX
process.env.UPDATE_BRANCH = 'main'
process.env.UPDATE_SERVICE = 'gw-update-test'
process.env.UPDATE_NO_RESTART = '1'

let up = null

before(async () => {
  up = await import('../update.js')
})

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// git 夹具
// ---------------------------------------------------------------------------

async function gitAt(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  })
  return stdout.trim()
}

async function commit(work, message) {
  await gitAt(['add', '-A'], work)
  await gitAt(['commit', '-q', '-m', message], work)
  return gitAt(['rev-parse', 'HEAD'], work)
}

/**
 * 搭一套夹具：裸库 origin + 已推送第一个提交的工作库。
 * 工作库的 remote 是这个裸库，所以 fetch/merge 全走本地文件，不需要网络。
 */
async function fixture(name) {
  const root = join(SANDBOX, name)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  mkdirSync(root, { recursive: true })

  await gitAt(['init', '-q', '--bare', origin])
  await gitAt(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin)

  await gitAt(['init', '-q', work])
  await gitAt(['symbolic-ref', 'HEAD', 'refs/heads/main'], work)
  await gitAt(['config', 'user.email', 'test@example.com'], work)
  await gitAt(['config', 'user.name', 'Test'], work)
  await gitAt(['config', 'commit.gpgsign', 'false'], work)

  writeFileSync(join(work, 'README.md'), '# fixture\n')
  const first = await commit(work, 'init')

  await gitAt(['remote', 'add', 'origin', origin], work)
  await gitAt(['push', '-q', '-u', 'origin', 'main'], work)

  return { root, origin, work, first }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('shortSha：界面上一律用 7 位短 sha 指代版本', () => {
  test('截取前 7 位并容忍空值/空白', () => {
    assert.equal(up.shortSha('1941574abcdef1234567890abcdef1234567890a'), '1941574')
    assert.equal(up.shortSha('  abcdef1234  '), 'abcdef1')
    assert.equal(up.shortSha(''), '')
    assert.equal(up.shortSha(null), '')
    assert.equal(up.shortSha(undefined), '')
  })
})

describe('dirtyTrackedPaths：只认已跟踪文件的改动', () => {
  test('未跟踪的运行时产物不算脏（部署目录天然有 data/、web/dist.bak.*）', () => {
    const porcelain = [
      '?? data/',
      '?? web/dist.bak.20261007064437/',
      '?? server_bak_20260902125449/'
    ].join('\n')
    assert.deepEqual(up.dirtyTrackedPaths(porcelain), [])
  })

  test('已跟踪文件的改动会被挑出来，并去掉状态码前缀', () => {
    const porcelain = [' M server/index.js', 'M  web/src/api.js', '?? data/'].join('\n')
    assert.deepEqual(up.dirtyTrackedPaths(porcelain), ['server/index.js', 'web/src/api.js'])
  })

  test('带空格的文件名不会被截断', () => {
    assert.deepEqual(up.dirtyTrackedPaths(' M docs/some file.md'), ['docs/some file.md'])
  })

  test('空输出代表干净', () => {
    assert.deepEqual(up.dirtyTrackedPaths(''), [])
    assert.deepEqual(up.dirtyTrackedPaths('\n\n'), [])
  })
})

describe('parseCommitLog：解析 git log -z 的分隔格式', () => {
  test('按 \\0 切记录、按 \\x1f 切字段', () => {
    const raw = 'aaa\x1faaaaaaa\x1f2026-10-09T10:00:00+08:00\x1fwyhc7\x1ffeat: 新功能\0' +
                'bbb\x1fbbbbbbb\x1f2026-10-08T09:00:00+08:00\x1fother\x1ffix: 修问题\0'
    const out = up.parseCommitLog(raw)
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], {
      revision: 'aaa', short: 'aaaaaaa', date: '2026-10-09T10:00:00+08:00', author: 'wyhc7', subject: 'feat: 新功能'
    })
    assert.equal(out[1].subject, 'fix: 修问题')
  })

  test('空输入与尾部空记录都不产生条目', () => {
    assert.deepEqual(up.parseCommitLog(''), [])
    assert.deepEqual(up.parseCommitLog('\0'), [])
  })
})

describe('parseChangedFiles：解析 git diff -z', () => {
  test('保留带空格的文件名', () => {
    assert.deepEqual(
      up.parseChangedFiles('server/a.js\0docs/with space.md\0'),
      ['server/a.js', 'docs/with space.md']
    )
  })

  test('空输出代表没有文件变更', () => {
    assert.deepEqual(up.parseChangedFiles(''), [])
  })
})

describe('summarizeAreas：把变更归到「改了哪一块」', () => {
  test('按目录归类并给出计数', () => {
    const areas = up.summarizeAreas([
      'server/index.js',
      'server/update.js',
      'web/src/App.vue',
      'docs/OPENCODE-ZEN.md'
    ])
    assert.deepEqual(areas, [
      { key: 'server', label: '后端', count: 2 },
      { key: 'web', label: '管理界面', count: 1 },
      { key: 'docs', label: '文档', count: 1 }
    ])
  })

  test('归不进去的文件落到「其它」，且不会重复计数', () => {
    const areas = up.summarizeAreas(['package.json', 'server/a.js'])
    const total = areas.reduce((n, a) => n + a.count, 0)
    assert.equal(total, 2)
    assert.equal(areas.find((a) => a.key === 'other').count, 1)
  })

  test('没有变更时返回空数组', () => {
    assert.deepEqual(up.summarizeAreas([]), [])
    assert.deepEqual(up.summarizeAreas(null), [])
  })
})

describe('planSteps：只在必要时才安排重活', () => {
  test('只改后端 JS：不装依赖也不构建前端（一次更新从一分钟压到几秒）', () => {
    assert.deepEqual(up.planSteps(['server/index.js']), {
      installServer: false, installWeb: false, buildWeb: false
    })
  })

  test('改了前端源码：只构建，不重装依赖', () => {
    assert.deepEqual(up.planSteps(['web/src/App.vue']), {
      installServer: false, installWeb: false, buildWeb: true
    })
  })

  test('依赖清单变了就必须重装，否则新代码 import 不到新包，服务起不来', () => {
    assert.deepEqual(up.planSteps(['server/package.json']), {
      installServer: true, installWeb: false, buildWeb: false
    })
    assert.deepEqual(up.planSteps(['web/package-lock.json']), {
      installServer: false, installWeb: true, buildWeb: true
    })
  })

  test('文档改动不触发任何重活', () => {
    assert.deepEqual(up.planSteps(['README.md', 'docs/x.md']), {
      installServer: false, installWeb: false, buildWeb: false
    })
  })
})

// ---------------------------------------------------------------------------
// 真实 git 链路
// ---------------------------------------------------------------------------

describe('不是 git 仓库的部署：给出可操作的原因，而不是抛错', () => {
  test('目录里没有 .git 时明确回 not-a-git-repo', async () => {
    const plain = join(SANDBOX, 'plain-dir')
    mkdirSync(plain, { recursive: true })
    process.env.UPDATE_REPO_DIR = plain
    up.clearUpdateCache()
    try {
      const r = await up.checkUpdate({ force: true })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'not-a-git-repo')
      assert.match(r.message, /complete-deploy\.sh/)
    } finally {
      process.env.UPDATE_REPO_DIR = SANDBOX
      up.clearUpdateCache()
    }
  })
})

describe('检出上游新提交：提交列表、文件清单、影响面一次给全', () => {
  test('落后 1 个提交时给出全部界面所需信息', async () => {
    const f = await fixture('behind-one')
    mkdirSync(join(f.work, 'server'), { recursive: true })
    writeFileSync(join(f.work, 'server', 'new.js'), 'export const x = 1\n')
    const upstream = await commit(f.work, 'feat: 上游新增了一个后端文件')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    // 把本地退回到推送前的状态：origin 领先本地 1 个提交，工作区干净
    await gitAt(['reset', '--hard', '-q', f.first], f.work)

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.ok, true)
    assert.equal(r.has_update, true)
    assert.equal(r.behind, 1)
    assert.equal(r.ahead, 0)
    assert.equal(r.can_update, true)
    assert.equal(r.blocked_reason, null)

    assert.equal(r.current.short, up.shortSha(f.first))
    assert.equal(r.latest.short, up.shortSha(upstream))

    assert.equal(r.commits.length, 1)
    assert.equal(r.commits[0].subject, 'feat: 上游新增了一个后端文件')
    assert.equal(r.commits[0].short, up.shortSha(upstream))

    assert.deepEqual(r.files.paths, ['server/new.js'])
    assert.deepEqual(r.areas, [{ key: 'server', label: '后端', count: 1 }])

    // 只动后端 JS：不该触发依赖安装或前端构建
    assert.deepEqual(r.plan, { installServer: false, installWeb: false, buildWeb: false })
    // 测试环境钉死了 UPDATE_NO_RESTART，用来断言「不会自动重启」这条通路
    assert.equal(r.restart.auto, false)

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })

  test('改到前端时影响面里出现构建，改到依赖清单时出现安装', async () => {
    const f = await fixture('web-change')
    mkdirSync(join(f.work, 'web', 'src'), { recursive: true })
    mkdirSync(join(f.work, 'server'), { recursive: true })
    writeFileSync(join(f.work, 'web', 'src', 'App.vue'), '<template><div/></template>\n')
    writeFileSync(join(f.work, 'server', 'package.json'), '{}\n')
    await commit(f.work, 'feat: 动前端与依赖')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.has_update, true)
    assert.deepEqual(r.plan, { installServer: true, installWeb: false, buildWeb: true })
    const keys = r.areas.map((a) => a.key).sort()
    assert.deepEqual(keys, ['server', 'web'])

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })

  test('已是最新时 has_update 为 false 且没有提交列表', async () => {
    const f = await fixture('up-to-date')
    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.ok, true)
    assert.equal(r.has_update, false)
    assert.equal(r.behind, 0)
    assert.equal(r.can_update, false)
    assert.deepEqual(r.commits, [])

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })
})

describe('拒绝更新的情形：必须先说清楚为什么', () => {
  test('工作区有未提交改动时拒绝，并点名是哪几个文件', async () => {
    const f = await fixture('dirty')
    mkdirSync(join(f.work, 'server'), { recursive: true })
    writeFileSync(join(f.work, 'server', 'new.js'), 'export const x = 1\n')
    await commit(f.work, 'feat: 上游提交')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)
    // 制造一个已跟踪文件的本地改动
    writeFileSync(join(f.work, 'README.md'), '# 本地改过了\n')

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.has_update, true)
    assert.equal(r.can_update, false)
    assert.match(r.blocked_reason, /README\.md/)
    assert.deepEqual(r.current.dirty, ['README.md'])

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })

  test('applyUpdate 遇到脏工作区直接中止，不碰代码', async () => {
    const f = await fixture('dirty-apply')
    mkdirSync(join(f.work, 'server'), { recursive: true })
    writeFileSync(join(f.work, 'server', 'new.js'), 'export const x = 1\n')
    await commit(f.work, 'feat: 上游提交')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)
    writeFileSync(join(f.work, 'README.md'), '# 本地改过了\n')

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, false)
    assert.match(r.message, /未提交的改动/)
    assert.equal(r.steps.at(-1).ok, false)
    // 中止发生在合并之前：不能声称代码已经更新
    assert.equal(r.merged_to, null)
    // 中止了就不能把上游的文件带进来
    assert.equal(existsSync(join(f.work, 'server', 'new.js')), false)

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })

  test('合并之后才失败时如实标注 merged_to：代码进来了，只是没跑完', async () => {
    const f = await fixture('fail-after-merge')
    // 只动 web/ 源码：计划里只有构建，构建必然失败（夹具里没有 web/package.json）。
    // 这样就能稳定复现「合并成功、后续步骤失败」这条路径。
    mkdirSync(join(f.work, 'web', 'src'), { recursive: true })
    writeFileSync(join(f.work, 'web', 'src', 'thing.vue'), '<template><div/></template>\n')
    const upstream = await commit(f.work, 'feat: 只改前端')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, false)
    // 关键契约：代码确实合并了，必须让人知道「修完重试」而不是「重头再来」
    assert.equal(r.merged_to, up.shortSha(upstream))
    assert.equal(await gitAt(['rev-parse', 'HEAD'], f.work), upstream)
    assert.equal(existsSync(join(f.work, 'web', 'src', 'thing.vue')), true)

    const names = r.steps.map((s) => s.name)
    assert.deepEqual(names, ['拉取远程代码', '合并代码', '构建管理界面'])
    assert.equal(r.steps.find((s) => s.name === '合并代码').ok, true)
    assert.equal(r.steps.at(-1).ok, false)
    // 构建都没成功，就不该再去重启
    assert.ok(!names.includes('重启服务'))

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })
})

describe('applyUpdate：真的把部署目录快进到上游', () => {
  test('拉取 → 合并 → 文件落盘，步骤日志可读', async () => {
    const f = await fixture('apply-ok')
    mkdirSync(join(f.work, 'server'), { recursive: true })
    writeFileSync(join(f.work, 'server', 'from-upstream.js'), 'export const ok = true\n')
    const upstream = await commit(f.work, 'feat: 上游新增文件')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)
    assert.equal(existsSync(join(f.work, 'server', 'from-upstream.js')), false)

    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, true)
    assert.equal(r.up_to_date, undefined)
    assert.equal(r.from, up.shortSha(f.first))
    assert.equal(r.to, up.shortSha(upstream))
    assert.equal(r.files, 1)
    assert.equal(r.commits.length, 1)
    assert.equal(r.commits[0].subject, 'feat: 上游新增文件')

    // 步骤日志：每一步都要有名字和结果，前端照它渲染
    const names = r.steps.map((s) => s.name)
    assert.deepEqual(names, ['拉取远程代码', '合并代码', '构建管理界面', '重启服务'])
    assert.equal(r.steps.find((s) => s.name === '合并代码').ok, true)
    // 没动前端就不该构建
    assert.match(r.steps.find((s) => s.name === '构建管理界面').detail, /跳过/)
    // UPDATE_NO_RESTART=1：不该尝试重启，且要明确告诉人怎么手动重启
    assert.equal(r.restart.mode, 'skipped')
    assert.match(r.restart.message, /systemctl restart gw-update-test/)

    // 上游的文件真的落到部署目录了
    assert.equal(existsSync(join(f.work, 'server', 'from-upstream.js')), true)
    const head = await gitAt(['rev-parse', 'HEAD'], f.work)
    assert.equal(head, upstream)

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })

  test('已是最新时不产生任何改动，也不去重启', async () => {
    const f = await fixture('apply-noop')
    process.env.UPDATE_REPO_DIR = f.work
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, true)
    assert.equal(r.up_to_date, true)
    assert.equal(r.from, r.to)
    assert.deepEqual(r.steps.map((s) => s.name), ['拉取远程代码', '比对版本'])
    assert.equal(r.restart.mode, 'none')

    process.env.UPDATE_REPO_DIR = SANDBOX
    up.clearUpdateCache()
  })
})
