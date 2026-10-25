// 系统更新测试
//
// 覆盖两层：
// 1) 纯函数层：sha 归一、工作区脏判定、git 输出解析、影响面推断、步骤编排
// 2) 真实 git 层：在临时目录里搭一对「裸库当远程 + 工作库当部署目录」，
//    走完整链路验证比对、拒绝更新、快进合并。全程离线，不碰网络也不碰 systemd。
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 先钉死环境：这三条必须在 import update.js 之前设好，
// 尤其 UPDATE_NO_RESTART —— 测试绝不允许真的去重启服务器上的服务。
const SANDBOX = mkdtempSync(join(tmpdir(), 'gw-update-sandbox-'))

// deployedRecordPath() 优先读 process.env.DATA_DIR，其次才回落到 repoDir()/data。
// 所以切仓库目录时两者必须成对切：只改 UPDATE_REPO_DIR 的话，DATA_DIR 仍跟着外部
// 环境走，上一个用例 merge 成功写下的部署记录会被下一个用例读到，up_to_date 与
// readDeployed 一起崩。本地没设 DATA_DIR 才侥幸全绿，容器/CI 里一设就必炸。
// 让 DATA_DIR 恒等于 repoDir()/data，两个口径就再也分不开了。
function useRepo(dir) {
  process.env.UPDATE_REPO_DIR = dir
  process.env.DATA_DIR = join(dir, 'data')
}
useRepo(SANDBOX)
process.env.UPDATE_BRANCH = 'main'
process.env.UPDATE_SERVICE = 'gw-update-test'
process.env.UPDATE_NO_RESTART = '1'

// 属主体检这一步只在「扫出外来 owner」时才记进步骤日志。夹具目录天然属于
// 跑测试的这个用户（Windows 上是管理员、CI 里是 runner、开发机上是本人），
// 而 serviceUser() 默认是部署账号 ai-gateway —— 两者对不上，Linux 上这一步
// 就会凭空多出来，步骤列表断言随即假失败（Windows 因无 POSIX 属主而幸免，
// 所以本地一直看不出问题）。把服务账号钉成当前用户，夹具的属主就真的是
// 「一致」的，两种平台行为也就统一了。
process.env.UPDATE_SERVICE_USER =
  process.platform === 'win32' ? 'ai-gateway' : os.userInfo().username

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
async function fixture(name, extra = null) {
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
  // extra 里的文件进第一个提交：这样它们不会出现在后续 diff 里，
  // 也就不会误触发「本次改了 package.json 要装依赖」。
  for (const [rel, content] of Object.entries(extra || {})) {
    const target = join(work, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
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
      'docs/DEPLOYMENT.md'
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
    useRepo(plain)
    up.clearUpdateCache()
    try {
      const r = await up.checkUpdate({ force: true })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'not-a-git-repo')
      assert.match(r.message, /complete-deploy\.sh/)
    } finally {
      useRepo(SANDBOX)
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

    useRepo(f.work)
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

    useRepo(SANDBOX)
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

    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.has_update, true)
    assert.deepEqual(r.plan, { installServer: true, installWeb: false, buildWeb: true })
    const keys = r.areas.map((a) => a.key).sort()
    assert.deepEqual(keys, ['server', 'web'])

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })

  test('已是最新时 has_update 为 false 且没有提交列表', async () => {
    const f = await fixture('up-to-date')
    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.ok, true)
    assert.equal(r.has_update, false)
    assert.equal(r.behind, 0)
    assert.equal(r.can_update, false)
    assert.deepEqual(r.commits, [])

    useRepo(SANDBOX)
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

    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.has_update, true)
    assert.equal(r.can_update, false)
    assert.match(r.blocked_reason, /README\.md/)
    assert.deepEqual(r.current.dirty, ['README.md'])

    useRepo(SANDBOX)
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

    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, false)
    assert.match(r.message, /未提交的改动/)
    assert.equal(r.steps.at(-1).ok, false)
    // 中止发生在合并之前：不能声称代码已经更新
    assert.equal(r.merged_to, null)
    // 中止了就不能把上游的文件带进来
    assert.equal(existsSync(join(f.work, 'server', 'new.js')), false)

    useRepo(SANDBOX)
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

    useRepo(f.work)
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

    useRepo(SANDBOX)
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

    useRepo(f.work)
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

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })

  test('已是最新时不产生任何改动，也不去重启', async () => {
    const f = await fixture('apply-noop')
    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.applyUpdate()

    assert.equal(r.ok, true)
    assert.equal(r.up_to_date, true)
    assert.equal(r.from, r.to)
    assert.deepEqual(r.steps.map((s) => s.name), ['拉取远程代码', '比对版本'])
    assert.equal(r.restart.mode, 'none')

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })
})

// ---------------------------------------------------------------------------
// 失败要能被诊断
//
// 这一组是补上一个真实的坑：线上构建失败时，界面只显示了
// 「Command failed: /root/.nvm/.../npm-cli.js run build --prefix web」，
// 真正的原因（vite 跑在了 node v12 上，SyntaxError）在 stderr 里，被整段丢掉了。
// ---------------------------------------------------------------------------

describe('commandError：失败原因要能被诊断，不能只剩一行命令行', () => {
  test('把 stderr 带出来', () => {
    const err = Object.assign(
      new Error('Command failed: /root/.nvm/versions/node/v20.20.2/bin/node npm-cli.js run build --prefix web'),
      { stderr: 'file:///opt/ai-gateway/web/node_modules/vite/bin/vite.js:7\n    await import("source-map-support")\n    ^^^^^\n\nSyntaxError: Unexpected reserved word\n' }
    )
    const text = up.commandError(err)
    assert.match(text, /SyntaxError: Unexpected reserved word/)
    assert.doesNotMatch(text, /^Command failed/)
  })

  test('stdout 也要带上——有些工具把报错写在 stdout', () => {
    const err = Object.assign(new Error('Command failed: npm run build'), { stdout: 'sh: vite: command not found' })
    assert.match(up.commandError(err), /vite: command not found/)
  })

  test('两者都没有时退回 message 首行，不返回空串', () => {
    assert.equal(up.commandError(new Error('Command failed: git fetch\n第二行不该出现')), 'Command failed: git fetch')
  })

  test('超长输出只留尾部，因为构建报错总在最后', () => {
    const err = Object.assign(new Error('x'), { stderr: `${'填充内容'.repeat(1200)}\nTHE REAL ERROR` })
    const text = up.commandError(err)
    assert.ok(text.length <= 1501, `应被截断，实际长度 ${text.length}`)
    assert.match(text, /THE REAL ERROR/)
    assert.ok(text.startsWith('…'))
  })
})

// ---------------------------------------------------------------------------
// 部署记录：只靠 HEAD 判断要不要更新会把失败的部署卡死
// ---------------------------------------------------------------------------

/** 直接落一份部署记录，模拟「上一次成功部署停在哪个提交」 */
function writeDeployedRecord(work, revision) {
  mkdirSync(join(work, 'data'), { recursive: true })
  writeFileSync(join(work, 'data', 'deployed-revision.json'), JSON.stringify({ revision, at: new Date().toISOString() }))
}

describe('sameRevision：判的是同一次提交，不是同一串字符', () => {
  const FULL = 'b88624c9428ad8c4b1f89712da48e71880d3c7ef'

  test('完整 sha 与它的短 sha 是同一次提交', () => {
    assert.equal(up.sameRevision(FULL, 'b88624c'), true)
    assert.equal(up.sameRevision('b88624c', FULL), true)
    assert.equal(up.sameRevision(FULL, FULL), true)
  })

  test('不同提交一律判成不同', () => {
    assert.equal(up.sameRevision(FULL, 'b88624d'), false)
    assert.equal(up.sameRevision(FULL, '0000000' + FULL.slice(7)), false)
  })

  // 这条就是线上踩到的：手工部署脚本按 git rev-parse --short 写了 7 位 sha，
  // 于是「已经跑完的部署」被永久误报成「上次没跑完」，按钮变成多余的补做重建
  test('短 sha 与长 sha 不再被判成两次提交', () => {
    assert.equal(up.sameRevision('b88624c', FULL), true)
    assert.equal(up.sameRevision(FULL, 'b88624c9428'), true)
  })

  test('短到 7 位以下不认，宁可判成不同也不能误判成同一个', () => {
    assert.equal(up.sameRevision(FULL, 'b886'), false)
    assert.equal(up.sameRevision(FULL, 'b88624c94'), true)
  })

  test('没有记录时不假装相同', () => {
    assert.equal(up.sameRevision(null, FULL), false)
    assert.equal(up.sameRevision(FULL, ''), false)
    assert.equal(up.sameRevision(null, null), false)
  })
})

describe('readDeployed：没有记录就不做任何断言', () => {
  test('文件不存在 / 内容损坏 / revision 不是字符串 → 一律返回 null', async () => {
    const f = await fixture('deployed-record')
    useRepo(f.work)

    assert.equal(up.readDeployed(), null, '没有记录')

    mkdirSync(join(f.work, 'data'), { recursive: true })
    writeFileSync(up.deployedRecordPath(), '{ 这不是 json')
    assert.equal(up.readDeployed(), null, '内容损坏')

    writeFileSync(up.deployedRecordPath(), JSON.stringify({ revision: 42 }))
    assert.equal(up.readDeployed(), null, 'revision 不是字符串')

    writeFileSync(up.deployedRecordPath(), JSON.stringify({ revision: 'abc123' }))
    assert.equal(up.readDeployed().revision, 'abc123')

    useRepo(SANDBOX)
  })
})

describe('合并成功但部署没跑完：不能让界面显示「已是最新」把人卡死', () => {
  test('checkUpdate 仍然报告需要更新，并按 deployed..HEAD 给出要补做的步骤', async () => {
    const f = await fixture('stale-detect')
    mkdirSync(join(f.work, 'web', 'src'), { recursive: true })
    writeFileSync(join(f.work, 'web', 'src', 'App.vue'), '<template><div/></template>\n')
    await commit(f.work, 'feat: 改前端')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    // 代码已经合并进去了，但上一次成功部署还停在第一个提交
    writeDeployedRecord(f.work, f.first)

    useRepo(f.work)
    up.clearUpdateCache()
    const r = await up.checkUpdate({ force: true })

    assert.equal(r.behind, 0, 'HEAD 确实已经等于上游')
    assert.equal(r.stale_deploy, true)
    assert.equal(r.has_update, true, 'behind 是 0 也不能说「已是最新」')
    assert.equal(r.can_update, true)
    assert.equal(r.deployed_revision, f.first)
    // 关键：计划必须来自 deployed..HEAD。若照 HEAD..上游 算，这里是空的，
    // 界面会显示「无需任何步骤」，而实际执行时却要重新构建。
    assert.equal(r.plan.buildWeb, true, '补做部署时仍然要构建前端')
    assert.equal(r.files.total, 1)
    assert.deepEqual(r.files.paths, ['web/src/App.vue'])
    assert.equal(r.commits.length, 1, '已合并未部署的提交也要能看到')
    assert.equal(r.commits[0].subject, 'feat: 改前端')

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })

  test('补做部署：不重复合并，跑完把记录补上，之后就不再报有更新', async () => {
    const f = await fixture('stale-resume')
    mkdirSync(join(f.work, 'docs'), { recursive: true })
    writeFileSync(join(f.work, 'docs', 'note.md'), 'x\n')
    await commit(f.work, 'docs: 只动文档')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    writeDeployedRecord(f.work, f.first)

    const headBefore = await gitAt(['rev-parse', 'HEAD'], f.work)
    useRepo(f.work)
    up.clearUpdateCache()

    const r = await up.applyUpdate()

    assert.equal(r.ok, true)
    assert.equal(r.resumed, true, '要认出这是补做部署而不是新更新')
    assert.equal(r.deployed_recorded, true)
    assert.equal(r.up_to_date, undefined)
    assert.equal(r.steps.some((s) => s.name === '合并代码'), false, '没有东西可合并就不该有合并这一步')
    assert.match(r.steps.find((s) => s.name === '比对版本').detail, /补做后续步骤/)
    assert.equal(await gitAt(['rev-parse', 'HEAD'], f.work), headBefore, 'HEAD 不该被动过')

    // 记录补上了，再查一次就该是「已是最新」——不会永远卡在「部署未完成」
    up.clearUpdateCache()
    const after = await up.checkUpdate({ force: true })
    assert.equal(after.stale_deploy, false)
    assert.equal(after.has_update, false)
    assert.equal(after.deployed_revision, headBefore)

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })

  test('中止的更新不写部署记录——记录只代表「真的部署成功过」', async () => {
    const f = await fixture('stale-fail')
    writeFileSync(join(f.work, 'README.md'), '# 本地改动\n')
    useRepo(f.work)
    up.clearUpdateCache()

    const r = await up.applyUpdate()

    assert.equal(r.ok, false)
    assert.match(r.steps[0].detail, /未提交的改动/)
    assert.equal(existsSync(join(f.work, 'data', 'deployed-revision.json')), false)

    useRepo(SANDBOX)
    up.clearUpdateCache()
  })
})

// ---------------------------------------------------------------------------
// npm 必须和跑网关的是同一个 node
//
// 线上真实故障：systemd 服务的 PATH 里没有 nvm 的 bin 目录，npm 拉起的 vite
// 靠 shebang `#!/usr/bin/env node` 找到了系统自带的 node v12，顶层 await 直接
// 语法错误。这里只能验证「PATH 被顶到了最前面」，端到端验证在服务器上做的。
// ---------------------------------------------------------------------------

describe('npm 的环境：脚本必须解析到和网关同一个 node', () => {
  test('构建步骤里的 node 就是跑网关的那个，而不是 PATH 上碰巧找到的旧版本', async () => {
    // package.json 进第一个提交，避免触发装依赖；探针脚本随更新一起进来，
    // 于是这次更新只会跑「构建管理界面」这一步
    const f = await fixture('npm-path', {
      'web/package.json': JSON.stringify({ name: 'probe', version: '1.0.0', private: true, scripts: { build: 'node probe.mjs' } }, null, 2)
    })
    mkdirSync(join(f.work, 'web'), { recursive: true })
    writeFileSync(join(f.work, 'web', 'probe.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.PROBE_OUT, process.execPath)\n")
    await commit(f.work, 'feat: 加个探针')
    await gitAt(['push', '-q', 'origin', 'main'], f.work)
    await gitAt(['reset', '--hard', '-q', f.first], f.work)

    const probeOut = join(f.work, 'probe-out.txt')
    process.env.PROBE_OUT = probeOut
    useRepo(f.work)
    up.clearUpdateCache()

    // 削成 systemd 服务那种「PATH 上没有 node」的样子。Windows 上不能这么干——
    // npm 找不到 cmd.exe 直接起不来，何况那里的 PATH 本来也只有同一个 node。
    const savedPath = process.env.PATH
    if (process.platform !== 'win32') {
      process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }

    try {
      const r = await up.applyUpdate()

      assert.equal(r.ok, true, `更新应当成功：${JSON.stringify(r.steps)}`)
      assert.equal(r.steps.find((s) => s.name === '构建管理界面').ok, true)
      assert.equal(existsSync(probeOut), true, '探针没跑起来，构建步骤等于没验证')
      assert.equal(
        readFileSync(probeOut, 'utf8').trim(),
        process.execPath,
        'npm 拉起的脚本必须解析到和网关同一个 node'
      )
    } finally {
      process.env.PATH = savedPath
      delete process.env.PROBE_OUT
      useRepo(SANDBOX)
      up.clearUpdateCache()
    }
  })

  test('缓存目录钉在仓库内，不能用服务用户的 home', () => {
    // 部署脚本给的服务单元带 ProtectHome=true，服务用户连自己的 home 都读不到
    // （实测 `ls ~` 报 Permission denied），而 npm 默认缓存就在 ~/.npm。
    // 于是 npm 直接以「Your cache folder contains root-owned files」中止 ——
    // 只要这次更新动了 package.json，装依赖那一步就必然失败。
    // 缓存落进仓库内就没有这个问题：仓库对服务用户可写。
    useRepo(SANDBOX)
    const dir = up.npmCacheDir()
    assert.equal(dir, join(SANDBOX, '.npm-cache'))
    assert.ok(dir.startsWith(SANDBOX), '缓存必须在仓库内，否则服务用户写不了')
  })
})

// ---------------------------------------------------------------------------
// 强制更新（force）
// ---------------------------------------------------------------------------

describe('normalizeForceMode：档位取值必须严格', () => {
  test('三个档位名原样接受，大小写与空白可容忍', () => {
    assert.equal(up.normalizeForceMode('soft'), 'soft')
    assert.equal(up.normalizeForceMode('NORMAL'), 'normal')
    assert.equal(up.normalizeForceMode('  hard  '), 'hard')
  })

  test('布尔式开关一律映射到 normal（不默认最狠的一档）', () => {
    for (const v of ['1', 'true', 'yes', 'on', true]) {
      assert.equal(up.normalizeForceMode(v), 'normal', `${v} 应映射到 normal`)
    }
  })

  test('关闭态与非值返回 null', () => {
    for (const v of ['', '0', 'false', 'no', 'off', null, undefined, false]) {
      assert.equal(up.normalizeForceMode(v), null, `${String(v)} 应视为不强制`)
    }
  })

  // 静默降级成常规更新最危险：用户以为「强制过了」，实际什么都没丢，下次照旧卡死。
  test('拼错的档位返回 null，绝不猜成相近的那档', () => {
    assert.equal(up.normalizeForceMode('sof'), null)
    assert.equal(up.normalizeForceMode('har'), null)
    assert.equal(up.normalizeForceMode('nuke'), null)
    assert.equal(up.normalizeForceMode('super'), null)
  })
})

describe('forceModeEffects：每一档丢什么必须说得清楚', () => {
  test('soft 只丢工作区改动，不丢提交、不删未跟踪文件', () => {
    const e = up.forceModeEffects('soft')
    assert.equal(e.discardTracked, true)
    assert.equal(e.discardCommits, false)
    assert.equal(e.cleanUntracked, false)
    assert.equal(e.risks.length, 1)
  })

  test('normal 再丢本地未推提交', () => {
    const e = up.forceModeEffects('normal')
    assert.equal(e.discardCommits, true)
    assert.equal(e.cleanUntracked, false)
    assert.equal(e.risks.length, 2)
  })

  // hard 的 clean -fd 是最容易被低估的一步：残留脚本、旧产物都会没。
  test('hard 额外清未跟踪文件，并且明确写出运行时目录不受影响', () => {
    const e = up.forceModeEffects('hard')
    assert.equal(e.cleanUntracked, true)
    assert.equal(e.risks.length, 3)
    assert.ok(e.risks.some((r) => /未跟踪/.test(r)))
    assert.ok(e.risks.some((r) => /\.gitignore/.test(r)), '必须讲明 .gitignore 里的运行时目录不会被删')
  })

  test('非法档位退回「常规更新」语义，什么都不丢', () => {
    const e = up.forceModeEffects('nuke')
    assert.equal(e.mode, null)
    assert.equal(e.discardTracked, false)
    assert.deepEqual(e.risks, [])
  })
})

describe('forceResolvedBlockers：越过什么要说出来', () => {
  test('没有档位时不解阻挡（常规更新仍按原规则拒绝）', () => {
    assert.deepEqual(up.forceResolvedBlockers({ dirty: ['a.js'] }, null, { ahead: 3 }), [])
  })

  test('只丢工作区改动时，只报那一条', () => {
    const out = up.forceResolvedBlockers({ dirty: ['server/a.js', 'web/b.js'] }, 'soft', { ahead: 0 })
    assert.equal(out.length, 1)
    assert.match(out[0], /2 个已跟踪文件的改动将被丢弃/)
  })

  // soft 档不丢提交，所以有未推提交时它解不了阻挡 —— 这条由上层的 available 判断，
  // 这里确认它不会虚报「已解决」。
  test('soft 档不会把本地未推提交算成已解决', () => {
    const out = up.forceResolvedBlockers({ dirty: [] }, 'soft', { ahead: 2 })
    assert.deepEqual(out, [])
  })

  test('normal / hard 会把未推提交一并报出来', () => {
    for (const mode of ['normal', 'hard']) {
      const out = up.forceResolvedBlockers({ dirty: [] }, mode, { ahead: 2 })
      assert.equal(out.length, 1, `${mode} 应报未推提交`)
      assert.match(out[0], /2 个未推送的提交将被丢弃/)
    }
  })
})

describe('强制更新：真的能越过阻挡把代码对齐到上游', () => {
  test('工作区脏：常规拒绝，soft 丢掉改动后更新成功', async () => {
    const { work, origin } = await fixture('force-dirty')
    useRepo(work)
    up.clearUpdateCache()

    // 上游推一个新提交
    const clone = join(SANDBOX, 'force-dirty', 'upstream')
    await gitAt(['clone', '-q', origin, clone])
    await gitAt(['config', 'user.email', 'test@example.com'], clone)
    await gitAt(['config', 'user.name', 'Test'], clone)
    writeFileSync(join(clone, 'NEW.md'), 'upstream\n')
    await commit(clone, 'upstream: add NEW.md')
    await gitAt(['push', '-q', 'origin', 'main'], clone)

    // 本地把 README 改脏
    writeFileSync(join(work, 'README.md'), '# local edit that must be discarded\n')

    const normal = await up.applyUpdate()
    assert.equal(normal.ok, false, '常规更新必须拒绝脏工作区')
    assert.match(normal.message, /未提交的改动/)

    const forced = await up.applyUpdate({ force: 'soft' })
    assert.equal(forced.ok, true, `强制更新应成功：${JSON.stringify(forced.steps)}`)
    assert.equal(forced.force_mode, 'soft')
    // 本地改动被还原成上游内容
    assert.equal(readFileSync(join(work, 'README.md'), 'utf8'), '# fixture\n')
    assert.equal(existsSync(join(work, 'NEW.md')), true)
    assert.ok(forced.steps.some((s) => s.name === '丢弃本地改动'))
    assert.ok(forced.steps.some((s) => s.name === '备份当前版本'), '强制更新必须先留回滚点')
  })

  test('本地有未推提交：soft 档做不到，normal 档硬对齐上游', async () => {
    const { work, origin } = await fixture('force-ahead')
    useRepo(work)
    up.clearUpdateCache()

    const clone = join(SANDBOX, 'force-ahead', 'upstream')
    await gitAt(['clone', '-q', origin, clone])
    await gitAt(['config', 'user.email', 'test@example.com'], clone)
    await gitAt(['config', 'user.name', 'Test'], clone)
    writeFileSync(join(clone, 'UP.md'), 'up\n')
    await commit(clone, 'upstream: add UP.md')
    await gitAt(['push', '-q', 'origin', 'main'], clone)

    // 本地制造一个未推提交
    writeFileSync(join(work, 'LOCAL.md'), 'local only\n')
    const localSha = await commit(work, 'local: never pushed')

    const soft = await up.applyUpdate({ force: 'soft' })
    assert.equal(soft.ok, false, 'soft 档不丢提交，历史没法快进时必须失败')

    const forced = await up.applyUpdate({ force: 'normal' })
    assert.equal(forced.ok, true, `normal 档应成功：${JSON.stringify(forced.steps)}`)
    assert.equal(forced.force_mode, 'normal')

    // 本地提交被丢弃：HEAD 与上游一致，LOCAL.md 不在了
    const head = await gitAt(['rev-parse', 'HEAD'], work)
    const upstreamHead = await gitAt(['rev-parse', 'HEAD'], clone)
    assert.equal(head, upstreamHead, 'normal 档必须把 HEAD 对齐到上游')
    assert.equal(existsSync(join(work, 'LOCAL.md')), false, '本地未推提交里的文件必须消失')

    // 但备份引用还在，能救回来
    const refs = await gitAt(['for-each-ref', '--format=%(refname)', 'refs/force-backup/'], work)
    assert.ok(refs.includes('refs/force-backup/'), '必须留下备份引用')
    const backupSha = await gitAt(['rev-parse', 'refs/force-backup/'.replace(/\/$/, '') + '/' + refs.split('refs/force-backup/')[1].split('/')[0]], work)
    assert.equal(backupSha, localSha, '备份引用必须指向被丢弃的那个提交')
  })

  test('hard 档清掉未跟踪文件，但不碰 .gitignore 里的运行时目录', async () => {
    const { work, origin } = await fixture('force-hard')
    useRepo(work)
    up.clearUpdateCache()

    const clone = join(SANDBOX, 'force-hard', 'upstream')
    await gitAt(['clone', '-q', origin, clone])
    await gitAt(['config', 'user.email', 'test@example.com'], clone)
    await gitAt(['config', 'user.name', 'Test'], clone)
    writeFileSync(join(clone, 'UP.md'), 'up\n')
    await commit(clone, 'upstream: add UP.md')
    await gitAt(['push', '-q', 'origin', 'main'], clone)

    // 未跟踪的残渣 + 一个被 ignore 的运行时目录
    writeFileSync(join(work, 'stale-script.sh'), 'echo old\n')
    writeFileSync(join(work, '.gitignore'), 'data/\n')
    await commit(work, 'chore: add gitignore')
    await gitAt(['push', '-q', 'origin', 'main'], work)
    mkdirSync(join(work, 'junkdir'), { recursive: true })
    writeFileSync(join(work, 'junkdir', 'x.txt'), 'junk\n')
    mkdirSync(join(work, 'data'), { recursive: true })
    writeFileSync(join(work, 'data', 'gateway.json'), '{"keep":true}\n')

    const forced = await up.applyUpdate({ force: 'hard' })
    assert.equal(forced.ok, true, `hard 档应成功：${JSON.stringify(forced.steps)}`)
    assert.ok(forced.steps.some((s) => s.name === '清理未跟踪文件'))
    assert.equal(existsSync(join(work, 'junkdir')), false, '未跟踪目录必须被删')
    assert.equal(existsSync(join(work, 'data', 'gateway.json')), true, '.gitignore 里的运行时数据绝不能被删')
  })

  test('非法档位等同常规更新，不会偷偷把本地改动扔掉', async () => {
    const { work } = await fixture('force-invalid')
    useRepo(work)
    up.clearUpdateCache()

    writeFileSync(join(work, 'README.md'), '# keep me\n')
    const r = await up.applyUpdate({ force: 'nuke' })
    // 没有新提交，所以是 up_to_date；关键是本地改动还在
    assert.equal(readFileSync(join(work, 'README.md'), 'utf8'), '# keep me\n', '非法档位绝不能丢东西')
    assert.equal(r.force_mode ?? null, null)
  })

  // git 看着干净、但产物坏了（web/dist 被手工动过、上次构建跑一半、依赖装坏）：
  // 这时 behind = 0、has_update = false，而人恰恰最需要「硬对齐 + 重跑一遍」。
  // 强制更新因此不能绑在 has_update 上。
  test('已是最新时强制更新仍然真的重部署，而不是报「无需更新」', async () => {
    const { work } = await fixture('force-redeploy', {
      'server/package.json': JSON.stringify({ name: 'srv', version: '1.0.0' }),
      'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0' })
    })
    useRepo(work)
    up.clearUpdateCache()

    // 本地把已跟踪文件改脏（模拟产物被手工动过）
    writeFileSync(join(work, 'server', 'package.json'), JSON.stringify({ name: 'srv', version: 'HAND-EDITED' }))

    const r = await up.applyUpdate({ force: 'normal' })
    assert.equal(r.ok, true, `强制重部署应成功：${JSON.stringify(r.steps)}`)
    assert.equal(r.up_to_date, undefined, '不能报「无需更新」')
    assert.ok(r.steps.some((s) => s.name === '强制重部署'), '必须走重部署分支')
    assert.ok(r.steps.some((s) => s.name === '构建管理界面'), '重部署必须重跑构建')
    // 手工改动被打回上游内容
    assert.equal(readFileSync(join(work, 'server', 'package.json'), 'utf8'), JSON.stringify({ name: 'srv', version: '1.0.0' }))
  })
})

describe('自重启：不提权，靠 Restart=on-failure', () => {
  // 这些用例只钉「判定逻辑」，绝不真的退出进程 —— 测试进程本身不能死。

  test('UPDATE_NO_RESTART=1 时明确跳过，并告诉人怎么手动重启', async () => {
    process.env.UPDATE_NO_RESTART = '1'
    useRepo(SANDBOX)
    const r = await up.triggerRestartForTest()
    assert.equal(r.ok, false)
    assert.equal(r.mode, 'skipped')
    assert.match(r.message, /systemctl restart gw-update-test/)
  })

  test('systemd 不可用（或单元没配 on-failure）时退回人工重启，绝不自退出', async () => {
    // 用不存在的单元名 → systemctl show 失败 → 判定不可自重启。
    // 这条最关键：判错方向就会把服务直接打死，而不是重启。
    delete process.env.UPDATE_NO_RESTART
    process.env.UPDATE_SERVICE = 'gw-nonexistent-unit-xyz'
    try {
      const r = await up.triggerRestartForTest()
      assert.equal(r.ok, false, '查不到单元时不能声称重启成功')
      assert.equal(r.mode, 'manual')
      assert.match(r.message, /请手动重启|不支持自动重启/)
    } finally {
      process.env.UPDATE_SERVICE = 'gw-update-test'
      process.env.UPDATE_NO_RESTART = '1'
    }
  })
})
