/**
 * Settings tests: the saved channel must reach the generator, and the keyless
 * 30 s quota must be honoured locally instead of spending a request to find it.
 *
 * Run: node --test test/settings.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { apply } from '../index.js'
import { CHANNEL_OPTIONS, KEYLESS_MIN_INTERVAL_MS, keylessWaitMs, noteKeylessCall, resetRuntimeState, saveProvider, snapshot } from '../src/settings.js'

async function reset() {
  // Clears the file AND the in-memory provider/quota mirror: a stale timestamp
  // would silently short-circuit the lane choice of the next case.
  await resetRuntimeState()
}

function makeContext({ answer }) {
  const seen = { llm: 0 }
  const handler = { current: undefined }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: { register(route) { handler.current = route.handler; return () => {} } },
    sessions: { get: () => ({ requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) }) },
    get: (name) => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test-model' }) } : undefined,
    llm: {
      async prepareCall(config) {
        return { config, stream: async function* () {
          seen.llm += 1
          yield { type: 'text-delta', index: 0, text: await answer() }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } }
      },
    },
    effect: (fn) => { fn() },
    inject: (deps, callback) => callback(ctx),
  }
  return { ctx, seen, handler }
}

async function request(handler, { method = 'POST', url, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method, url, headers: {},
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let payload = ''
  const res = { writeHead(code) { status = code }, end(text) { payload = text } }
  await handler(req, res)
  return { status, body: JSON.parse(payload) }
}

test('the settings UI offers exactly the two required channels', () => {
  assert.deepEqual(CHANNEL_OPTIONS.map((option) => option.value), ['model', 'keyless'])
  assert.equal(CHANNEL_OPTIONS[0].title, '对话模型')
  assert.equal(CHANNEL_OPTIONS[1].title, 'Pollinations 免登录通道')
  for (const option of CHANNEL_OPTIONS) assert.ok(option.description.length > 0)
})

test('the 30 second keyless limit is published by the snapshot', () => {
  assert.equal(snapshot().limits.keylessMinIntervalMs, 30_000)
  assert.equal(KEYLESS_MIN_INTERVAL_MS, 30_000)
})

test('saving a channel persists it', async () => {
  await reset()
  await saveProvider('keyless')
  assert.equal(snapshot().provider, 'keyless')
  await saveProvider('model')
  assert.equal(snapshot().provider, 'model')
  const stored = JSON.parse(await fs.readFile(new URL('../.runtime/settings.json', import.meta.url), 'utf8'))
  assert.equal(stored.provider, 'model')
})

test('an unknown channel is refused', async () => {
  await reset()
  await assert.rejects(() => saveProvider('bogus'), /未知的通道/)
})

test('the keyless quota is enforced locally for 30 seconds', async () => {
  await reset()
  await noteKeylessCall(1_000)
  assert.equal(keylessWaitMs(1_000), 30_000)
  assert.equal(keylessWaitMs(30_000), 1_000)
  assert.equal(keylessWaitMs(31_000), 0)
})

test('GET /settings reports the saved channel and the limit', async () => {
  await reset()
  const { ctx, handler } = makeContext({ answer: async () => 'ok' })
  apply(ctx, {})
  await saveProvider('keyless')
  const result = await request(handler.current, { method: 'GET', url: '/api/prompt-enhance/settings' })
  assert.equal(result.status, 200)
  assert.equal(result.body.provider, 'keyless')
  assert.equal(result.body.limits.keylessMinIntervalMs, 30_000)
})

test('POST /settings saves the chosen channel', async () => {
  await reset()
  const { ctx, handler } = makeContext({ answer: async () => 'ok' })
  apply(ctx, {})
  const result = await request(handler.current, { method: 'POST', url: '/api/prompt-enhance/settings', body: { provider: 'model' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.provider, 'model')
})

test('POST /settings rejects an unknown channel', async () => {
  await reset()
  const { ctx, handler } = makeContext({ answer: async () => 'ok' })
  apply(ctx, {})
  const result = await request(handler.current, { method: 'POST', url: '/api/prompt-enhance/settings', body: { provider: 'nope' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.ok, false)
})

test('the saved keyless channel makes the keyless lane answer', async () => {
  await reset()
  const { ctx, handler } = makeContext({ answer: async () => '请创建一个登录页面。' })
  apply(ctx, {})
  const realFetch = globalThis.fetch
  let keylessCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('pollinations')) {
      keylessCalls += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: '请创建一个登录页面。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }
  try {
    await saveProvider('keyless')
    const result = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
    assert.equal(result.status, 200)
    assert.equal(keylessCalls, 1, 'the keyless lane must answer when it is the saved channel')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the saved model channel makes the model lane answer', async () => {
  await reset()
  const { ctx, seen, handler } = makeContext({ answer: async () => '请创建一个登录页面。' })
  apply(ctx, {})
  await saveProvider('model')
  const result = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
  assert.equal(result.status, 200)
  assert.equal(seen.llm, 1)
})

test('a keyless click during cooldown falls back to the conversation model', async () => {
  await reset()
  const { ctx, seen, handler } = makeContext({ answer: async () => '请创建一个登录页面，包含用户名和密码输入框。' })
  apply(ctx, {})
  await saveProvider('keyless')
  await noteKeylessCall(Date.now())   // cooldown just started
  const result = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
  // The click must still succeed (never 429) and must use the model lane.
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.lane, 'model')
  assert.equal(result.body.fallback.reason, 'cooldown')
  assert.ok(result.body.fallback.waitMs > 0)
  assert.equal(seen.llm, 1)
})

test('a keyless click after cooldown returns to the keyless lane automatically', async () => {
  await reset()
  const { ctx, handler } = makeContext({ answer: async () => '请创建一个登录页面。' })
  apply(ctx, {})
  await saveProvider('keyless')
  await noteKeylessCall(Date.now() - 31_000)  // cooldown already over
  const realFetch = globalThis.fetch
  let keylessCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('pollinations')) {
      keylessCalls += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: '请创建一个登录页面。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }
  try {
    const result = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
    assert.equal(result.status, 200)
    assert.equal(result.body.lane, 'keyless')
    assert.equal(keylessCalls, 1, 'after cooldown the keyless lane must answer again')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a quota refusal arms the local cooldown and falls back to the model', async () => {
  await reset()
  const { ctx, seen, handler } = makeContext({ answer: async () => '请创建一个登录页面。' })
  apply(ctx, {})
  await saveProvider('keyless')
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('pollinations')) {
      return new Response('{"error":{"message":"Free limit reached: 1 reply every 30 seconds per IP. Retry after 25s"}}', { status: 402, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }
  try {
    const first = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
    assert.equal(first.status, 200, 'quota refusal must still return an answer via the model lane')
    assert.equal(first.body.ok, true)
    assert.equal(first.body.lane, 'model')
    assert.equal(first.body.fallback.reason, 'keyless-refused')
    // The refusal closed the local window: the next click skips the upstream entirely.
    const second = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '第二个草稿' } })
    assert.equal(second.status, 200)
    assert.equal(second.body.fallback.reason, 'cooldown')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the model channel ignores the keyless cooldown entirely', async () => {
  await reset()
  const { ctx, seen, handler } = makeContext({ answer: async () => '请创建一个登录页面。' })
  apply(ctx, {})
  await saveProvider('model')
  await noteKeylessCall(Date.now())
  const result = await request(handler.current, { url: '/api/prompt-enhance/enhance', body: { text: '做个登录页面' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.lane, 'model')
  assert.equal(result.body.fallback, undefined, 'model-only mode never reports a keyless fallback')
  assert.equal(seen.llm, 1)
})
