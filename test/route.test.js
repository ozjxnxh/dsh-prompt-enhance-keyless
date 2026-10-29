/**
 * Route-level tests: the language decision must reach the generator and a
 * wrong-language answer must be refused, on both the keyless and model lanes.
 *
 * Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { resetRuntimeState, saveProvider } from '../src/settings.js'
import fs from 'node:fs/promises'
import { detectLanguage } from '../src/language.js'

/** Reset persisted settings, then pin the model channel for this case. */
async function useModelChannel() {
  await resetRuntimeState()
  await saveProvider('model')
}

/** Minimal Host context exposing only what the route touches. */
function makeContext({ sessionId = 's1', answer }) {
  const calls = { llm: [], keyless: [] }
  const handler = { current: undefined }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: { register(route) { handler.current = route.handler; return () => {} } },
    sessions: { get: (id) => id === sessionId ? { requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) } : undefined },
    get: () => undefined,
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* (options) {
            calls.llm.push(options)
            const text = await answer(options)
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    effect: (fn) => { fn() },
    inject: (deps, callback) => callback(ctx),
  }
  return { ctx, calls, handler }
}

/** Issue one request against the registered route. */
async function request(handler, body) {
  const chunks = [Buffer.from(JSON.stringify(body))]
  const req = {
    method: 'POST',
    url: '/api/prompt-enhance/enhance',
    headers: {},
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let payload = ''
  const res = { writeHead(code) { status = code }, end(text) { payload = text } }
  await handler(req, res)
  return { status, body: JSON.parse(payload) }
}

test('a Chinese draft sends a Chinese language instruction to the model', async () => {
  const { ctx, calls, handler } = makeContext({ answer: async () => '请创建一个登录页面，包含用户名和密码输入框。' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  const result = await request(handler.current, { text: '帮我做个登录页面', sessionId: 's1' })
  assert.equal(result.status, 200)
  assert.equal(detectLanguage(result.body.enhanced), 'zh')
  const sent = calls.llm[0]
  assert.match(sent.system, /OUTPUT LANGUAGE: Chinese/)
  assert.match(sent.system, /Never answer in Japanese/)
  assert.match(sent.messages[0].content[0].text, /OUTPUT LANGUAGE: Chinese/)
})

test('an English draft sends an English language instruction', async () => {
  const { ctx, calls, handler } = makeContext({ answer: async () => 'Create a login page with username and password inputs.' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  const result = await request(handler.current, { text: 'make a login page', sessionId: 's1' })
  assert.equal(result.status, 200)
  assert.match(calls.llm[0].system, /OUTPUT LANGUAGE: English/)
})

test('a Japanese draft sends a Japanese language instruction', async () => {
  const { ctx, calls, handler } = makeContext({ answer: async () => 'ログインページを作成してください。' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  const result = await request(handler.current, { text: 'ログインページを作ってください', sessionId: 's1' })
  assert.equal(result.status, 200)
  assert.match(calls.llm[0].system, /OUTPUT LANGUAGE: Japanese/)
})

test('REGRESSION: a Chinese draft answered in Japanese is refused, not returned', async () => {
  const { ctx, handler } = makeContext({ answer: async () => 'ログインページを作成してください。ユーザー名とパスワードの入力欄を含めてください。' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  const result = await request(handler.current, { text: '帮我做个登录页面', sessionId: 's1' })
  assert.equal(result.status, 502)
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /语言不一致/)
})

test('REGRESSION: a Chinese draft answered in English is refused too', async () => {
  const { ctx, handler } = makeContext({ answer: async () => 'Create a login page with username and password inputs.' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  const result = await request(handler.current, { text: '帮我做个登录页面', sessionId: 's1' })
  assert.equal(result.status, 502)
  assert.equal(result.body.ok, false)
})

test('the draft text itself is passed through unchanged', async () => {
  const draft = '修复 `getUser()` 在 src/auth.js 的 bug，返回 401'
  const { ctx, calls, handler } = makeContext({ answer: async () => '请修复 `getUser()` 在 src/auth.js 中的 bug，使其返回 401。' })
  apply(ctx, { provider: 'model' })
  await useModelChannel()
  await request(handler.current, { text: draft, sessionId: 's1' })
  // The draft travels as a JSON string inside the user message, so it survives verbatim.
  assert.ok(calls.llm[0].messages[0].content[0].text.includes(JSON.stringify(draft)))
})
