// 自动送回 callback 的工具函数测试。
//
// 这两函数决定「用户少粘一次 URL」能不能成，错了会引导到错误页面，
// 所以断言围绕：能不能从各种粘贴形态里认出 code/state、书签脚本是否合法。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBookmarklet, extractCodeAndState, looksLikeCallback } from '../../web/src/oauth-auto.js'

const REAL_CB = 'https://platform.openai.com/auth/callback?code=ac_abc123XYZ&state=cd69431e092d4755a23e1f223103490e.j9feD4AWEYtc9u7IRDcHFA'

test('extractCodeAndState：完整 URL', () => {
  const r = extractCodeAndState(REAL_CB)
  assert.equal(r.code, 'ac_abc123XYZ')
  assert.equal(r.state, 'cd69431e092d4755a23e1f223103490e.j9feD4AWEYtc9u7IRDcHFA')
})

test('extractCodeAndState：只有 query 串', () => {
  const r = extractCodeAndState('code=ac_abc123XYZ&state=sid.verifier')
  assert.equal(r.code, 'ac_abc123XYZ')
  assert.equal(r.state, 'sid.verifier')
})

test('extractCodeAndState：裸 code', () => {
  const r = extractCodeAndState('ac_abc123XYZ')
  assert.equal(r.code, 'ac_abc123XYZ')
  assert.equal(r.state, '')
})

test('extractCodeAndState：空与空白', () => {
  assert.deepEqual(extractCodeAndState(''), { code: '', state: '' })
  assert.deepEqual(extractCodeAndState('   '), { code: '', state: '' })
  assert.deepEqual(extractCodeAndState(null), { code: '', state: '' })
})

test('looksLikeCallback：认得真实回调，不误判普通文本', () => {
  assert.equal(looksLikeCallback(REAL_CB), true)
  assert.equal(looksLikeCallback('https://x.com/?code=1&state=2'), true)
  // 没有 code 的一律不算
  assert.equal(looksLikeCallback('https://platform.openai.com/auth/callback'), false)
  assert.equal(looksLikeCallback('随便一段文字'), false)
  assert.equal(looksLikeCallback(''), false)
  // code= 出现在无关上下文里也不算（必须带 state 或正确的 host）
  assert.equal(looksLikeCallback('在代码里写 code=1 这种'), false)
})

test('buildBookmarklet：以 javascript: 开头、单行、能拼出目标地址', () => {
  const bm = buildBookmarklet('https://gw.example.com', 'prov-1', 'sess-1')
  assert.ok(bm.startsWith('javascript:'), '必须是 javascript: 协议')
  assert.equal(bm.includes('\n'), false, '书签不能有换行')
  assert.ok(bm.includes('https://gw.example.com/api/chatgpt-accounts/oauth/callback'), '要指向回调端点')
  assert.ok(bm.includes('"prov-1"'), '要带平台 id')
  assert.ok(bm.includes('"sess-1"'), '要带 session_id')
  assert.ok(bm.includes('location.href'), '要读当前地址栏')
})

test('buildBookmarklet：结尾斜杠会被规整', () => {
  const bm = buildBookmarklet('https://gw.example.com///', 'p', 's')
  assert.ok(bm.includes('https://gw.example.com/api/chatgpt-accounts/oauth/callback'))
  assert.equal(bm.includes('///api'), false)
})

test('buildBookmarklet：参数里的引号不会破坏脚本', () => {
  // 平台 id 理论上可能是任意 uuid，这里故意塞引号验证能正确转义
  const bm = buildBookmarklet('https://gw.example.com', 'p"quote', 's\\back')
  assert.ok(bm.startsWith('javascript:'))
  // 转义后不应出现裸露的双引号打断 JSON 字符串
  assert.ok(bm.includes('p\\"quote') || bm.includes('"p\\"quote"'))
})
