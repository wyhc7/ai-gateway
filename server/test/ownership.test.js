// 部署目录属主自愈的测试。
//
// 这个模块的存在理由是「一次 EACCES 会伪装成五花八门的失败」，所以断言集中在
// 三件事：能不能正确认出异常属主、认不出时会不会误伤、修不了时给不给得出命令。
//
// 注意：真正的 chown 需要 root，这里只测不碰权限的路径（Windows / 非 root）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SERVICE_USER,
  chownCommand,
  ensureOwnership,
  findForeignOwners,
  repairOwnership,
  serviceUser
} from '../ownership.js'

const IS_WIN = process.platform === 'win32'

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-'))
  mkdirSync(join(dir, 'web', 'dist', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'server'), { recursive: true })
  writeFileSync(join(dir, 'web', 'dist', 'assets', 'index-abc.css'), 'body{}')
  writeFileSync(join(dir, 'server', 'index.js'), 'export {}')
  return dir
}

test('serviceUser 默认是 ai-gateway，可用环境变量覆盖', () => {
  assert.equal(DEFAULT_SERVICE_USER, 'ai-gateway')
  const old = process.env.UPDATE_SERVICE_USER
  try {
    delete process.env.UPDATE_SERVICE_USER
    assert.equal(serviceUser(), 'ai-gateway')
    process.env.UPDATE_SERVICE_USER = 'someone'
    assert.equal(serviceUser(), 'someone')
  } finally {
    if (old === undefined) delete process.env.UPDATE_SERVICE_USER
    else process.env.UPDATE_SERVICE_USER = old
  }
})

test('chownCommand 生成的命令可读、可复制', () => {
  assert.equal(chownCommand('/opt/ai-gateway'), 'chown -R ai-gateway:ai-gateway /opt/ai-gateway')
  assert.equal(chownCommand('/srv/x', 'foo'), 'chown -R foo:foo /srv/x')
})

test('Windows 上不报属主异常（没有 POSIX 属主概念）', { skip: !IS_WIN }, async () => {
  const dir = tmpRepo()
  try {
    assert.deepEqual(findForeignOwners(dir, 'ai-gateway'), [])
    const r = await ensureOwnership(dir, 'ai-gateway')
    assert.equal(r.needed, false)
    assert.equal(r.repaired, false)
    const fixed = await repairOwnership(dir)
    assert.equal(fixed.ok, false)
    assert.equal(fixed.reason, 'windows')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('属主一致时不报异常（非 Windows 也走一遍）', { skip: IS_WIN }, async () => {
  const dir = tmpRepo()
  try {
    const r = await ensureOwnership(dir, serviceUser())
    assert.equal(r.needed, false)
    assert.match(r.detail, /属主正常/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 root 时修不了，但必须给出可执行的 chown 命令', { skip: IS_WIN }, async () => {
  if (process.getuid && process.getuid() === 0) return // root 下这条不适用
  const dir = tmpRepo()
  try {
    const fixed = await repairOwnership(dir)
    assert.equal(fixed.ok, false)
    assert.equal(fixed.reason, 'not-root')
    assert.match(fixed.message, /chown -R /)
    assert.match(fixed.message, /ai-gateway:ai-gateway/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureOwnership 在不存在的目录上不抛异常', async () => {
  // 更新流程开头就会调它，前面任何一步出错都不该让体检把整个更新炸掉
  const r = await ensureOwnership('/definitely/not/here', 'ai-gateway')
  assert.equal(typeof r.needed, 'boolean')
  assert.ok(Array.isArray(r.before))
  assert.ok(Array.isArray(r.after))
  assert.ok(typeof r.detail === 'string')
})
