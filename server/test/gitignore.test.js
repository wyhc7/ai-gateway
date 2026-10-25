// .gitignore 里 *cred* / *secret* 这种裸通配会把源码一起挡掉。
//
// 真实事故：web/src/components/CreditsPanel.vue 被 `*cred*` 忽略，
// `git add -A` 之后 git status 里看不到它，diff 也没有 —— commit 只进了
// Dashboard.vue 的 5 行，新组件根本没进去，部署到服务器后页面渲染不出来，
// 回头翻 .gitignore 才发现是规则自己吃掉了源码。
//
// 注释里写的是「凡是名字里带 pass/login/cred/secret/keepass 的 dotfile 一律挡掉」，
// 意图是 dotfile，但规则没限制点号开头 —— 这是那类「注释和实现对不上」的典型。
//
// 这组用例钉两件事：
//   1. 源码文件名带 cred/secret 是正常命名，不能被忽略
//   2. 真凭据文件的各种常见形态必须仍然被忽略（修规则时不能顺手放宽）

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/**
 * 问 git 某个路径是否被忽略。
 * `git check-ignore` 命中退出码 0，未命中退出码 1 —— 后者是正常结果不是错误，
 * 所以不能用 execFileSync 的默认行为（非零就抛），要自己接住。
 */
function isIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch (err) {
    if (err.status === 1) return false
    // git 不存在或不是仓库：跳过断言，别让环境问题伪装成规则问题
    return null
  }
}

describe('.gitignore：源码不能被凭据通配误伤', () => {
  const sourceFiles = [
    'web/src/components/CreditsPanel.vue',
    'web/src/views/Credits.vue',
    'web/src/components/SecretCard.vue',
    'server/secret-util.js',
    'server/credentials.js',
    'scripts/check-secrets.mjs'
  ]

  for (const f of sourceFiles) {
    test(`源码 ${f} 不被忽略`, () => {
      const got = isIgnored(f)
      if (got === null) return // 无 git 环境，跳过
      assert.equal(got, false, `${f} 被 .gitignore 忽略了。检查是否有 *cred* / *secret* 这类裸通配。`)
    })
  }
})

describe('.gitignore：真凭据文件必须仍然被拦住', () => {
  // 覆盖实际会出现的几种形态：点号开头的、带扩展名的、名字里带 cred/secret 的
  const credentialFiles = [
    'credentials.json',
    '.credentials',
    'aws-credential.txt',
    'keys-cred.json',
    'id_cred.pem',
    '.secrets',
    'secrets.json',
    'secret-key.pem',
    'vendor-secret.key',
    '.sshpass.bat',
    'sshlogin.bat',
    '.keepass.txt',
    // 运行时数据目录里有网关 Key 与平台 Key
    'server/data/config.json'
  ]

  for (const f of credentialFiles) {
    test(`凭据 ${f} 被忽略`, () => {
      const got = isIgnored(f)
      if (got === null) return
      assert.equal(got, true, `${f} 没有被忽略 —— 放宽凭据规则时漏了这种形态。`)
    })
  }
})

describe('.gitignore：构建产物与依赖仍然被排除', () => {
  const excluded = ['node_modules/lodash/index.js', 'dist/index.js', 'web/auto-imports.d.ts', '.env', 'data/config.json']

  for (const f of excluded) {
    test(`${f} 被排除`, () => {
      const got = isIgnored(f)
      if (got === null) return
      assert.equal(got, true, `${f} 没有被排除`)
    })
  }
})
