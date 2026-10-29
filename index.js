/**
 * dsh-prompt-enhance — Host half.
 *
 * Exposes one same-origin JSON route, `POST /api/prompt-enhance/enhance`, that
 * rewrites a draft prompt through the Session's current model route (the exact
 * provider/model the next message would use; falls back to the configured
 * default model for a fresh session). The browser half is a composer button.
 *
 * Every harness facility is reached through `ctx` — no `@deepseek-ai/*` import,
 * so the bundle resolves from any profile directory.
 *
 * @module index.js
 */
import { randomUUID } from 'node:crypto'
import { enhanceKeyless } from './src/keyless.js'
import { detectLanguage, languageInstruction, matchesLanguage, preserveTokens } from './src/language.js'
import { keylessWaitMs, noteKeylessCall, readProvider, saveProvider, snapshot } from './src/settings.js'

export const name = 'prompt-enhance'

/** Required Host services; `webServer` and `agentDefaultModel` are resolved lazily so a partial composition degrades one feature instead of failing the plugin. */
export const inject = ['llm', 'sessions']

const DEFAULTS = {
  /** Drafts longer than this are refused rather than silently truncated. */
  maxInputChars: 20_000,
  maxOutputTokens: 2_048,
  /** End-to-end budget for one enhancement call. */
  timeoutMs: 90_000,
  /**
   * Which lane answers the rewrite. `keyless` costs nothing and needs no
   * credential but is rate-limited (one reply / 30 s / IP); `model` uses the
   * Session's own route and bills tokens. `auto` tries keyless, then the model.
   */
  provider: 'auto',
}

/** The rewrite contract. Kept as one system prompt so the user draft stays a single user message. */
const SYSTEM_PROMPT = [
  'You are a prompt enhancer for an AI coding assistant. Rewrite the user\'s draft prompt so a coding agent can execute it better.',
  '- Make the goal explicit; add useful structure (context, constraints, expected output, acceptance) only where it is missing.',
  '- Preserve the original intent, every concrete detail (paths, names, numbers, code identifiers), and the language the user wrote in.',
  '- Fix ambiguity, typos and grammar; tighten wording. Do not inflate.',
  '- Never answer the prompt, never add commentary, greetings, quotes or Markdown fences: output ONLY the rewritten prompt as plain text.',
].join('\n')

/** Read a capped JSON request body. @returns parsed object, or undefined on any protocol failure (response already sent). */
async function readJson(req, res, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '请求体过大' }))
      return undefined
    }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object') throw new Error('not an object')
    return value
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
    return undefined
  }
}

/**
 * Register the enhance button's Host backend.
 * @param ctx - profile context with the LLM runtime and session store.
 * @param config - optional overrides of the DEFAULTS execution controls.
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const logger = ctx.logger ?? console
  /** One in-flight enhancement per session keeps a stuck model from being fanned out by repeated clicks. */
  const inflight = new Set()
  /** Why the last click skipped the keyless lane; null when it did not skip it. */
  let lastFallback = null
  /** Which lane actually produced the last answer: 'keyless' or 'model'. */
  let usedLane = 'model'

  /**
   * The route the Session would send its next message with.
   * @param {string | undefined} sessionId - the composer's session, when one is open.
   * @returns {{provider: string, model: string} | undefined} the route, or undefined when none is configured yet.
   */
  function resolveRoute(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const header = ctx.sessions.get(sessionId)?.requestHeader?.()
      const logged = header?.config
      if (typeof logged?.provider === 'string' && typeof logged?.model === 'string') {
        return { provider: logged.provider, model: logged.model }
      }
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
      return { provider: fallback.provider, model: fallback.model }
    }
    return undefined
  }

  /**
   * One rewrite through the resolved route.
   * @param {string} text - the raw draft.
   * @param {string | undefined} sessionId - attribution and route source.
   * @param {import('./src/language.js').Language} language - detected language of the draft.
   * @returns {Promise<string>} the enhanced prompt text.
   */
  async function enhance(text, sessionId, language) {
    // The saved choice wins over the entry's config, so a settings change applies to the next click.
    const provider = await readProvider(options.provider)
    usedLane = 'model'
    lastFallback = null
    if (provider === 'keyless' || provider === 'auto') {
      const wait = keylessWaitMs()
      // While the anonymous quota cools down, a keyless request would be refused
      // anyway, so the click falls back to the conversation model instead of
      // failing with an error the user can do nothing about. Once the 30 s
      // window reopens, the keyless lane is selected again automatically.
      if (wait === 0) {
        const budget = AbortSignal.timeout(options.timeoutMs)
        try {
          const result = await enhanceKeyless(text, ['pollinations'], budget, language)
          await noteKeylessCall()
          usedLane = 'keyless'
          return result.text
        } catch (error) {
          // A refused keyless call falls through to the model lane; only the
          // caller's own deadline is allowed to propagate.
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error
          if (error?.name === 'QuotaError') {
            // The upstream quota really is closed: arm the local 30 s window so the
            // next clicks skip straight to the conversation model, then auto-return.
            await noteKeylessCall()
          }
          lastFallback = {
            reason: 'keyless-refused',
            detail: String(error?.message ?? error),
            message: 'Pollinations 通道本次不可用（可能是 30 秒限制），自动改用对话模型改写。',
          }
        }
      } else {
        lastFallback = {
          reason: 'cooldown',
          waitMs: wait,
          message: `Pollinations 免登录通道正在冷却（剩 ${Math.ceil(wait / 1000)} 秒），本次自动改用对话模型改写，冷却结束后会自动切回。`,
        }
      }
    }
    const route = resolveRoute(sessionId)
    if (route === undefined) throw Object.assign(new Error('尚未选择模型：请先在设置里配置默认模型'), { status: 409 })
    const signal = AbortSignal.timeout(options.timeoutMs)
    const call = await ctx.llm.prepareCall({ ...route, maxTokens: options.maxOutputTokens }, signal)
    const messages = [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `Rewrite the following user prompt.\n${languageInstruction(language)}\nKeep this JSON string's language, and keep every path, identifier and number inside it unchanged:\n${JSON.stringify(text)}` }],
      source: { kind: 'dsh-prompt-enhance' },
    }]
    let output = ''
    /** @type {{kind: string, failure?: {message?: string}} | undefined} */
    let finish
    for await (const chunk of call.stream({
      ...call.config,
      messages,
      system: `${SYSTEM_PROMPT}\n${languageInstruction(language)}`,
      ...(sessionId === undefined ? {} : { sessionId }),
      purpose: 'prompt-enhance',
      signal,
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish === undefined) throw Object.assign(new Error('模型没有返回结束状态'), { status: 502 })
    if (finish.kind === 'aborted') throw Object.assign(new Error('增强超时，请稍后重试'), { status: 504 })
    if (finish.kind !== 'stop') throw Object.assign(new Error(finish.failure?.message ?? '模型调用失败'), { status: 502 })
    const enhanced = output.trim()
    if (enhanced === '') throw Object.assign(new Error('模型没有产出内容'), { status: 502 })
    if (!matchesLanguage(enhanced, language)) throw Object.assign(new Error(`语言不一致：草稿是 ${language}，结果不是。请重试。`), { status: 502 })
    return enhanced
  }

  /** Route handler for the `/api/prompt-enhance` prefix. */
  async function handler(req, res) {
    const path = new URL(req.url ?? '/', 'http://prompt-enhance.local').pathname
    // No local authentication test: this route lives on the Desktop Host's
    // loopback listener, whose Web carrier already fences untrusted requests
    // and authenticates the rendered page before any handler runs. Re-testing
    // Origin here only risked rejecting the shell's own rewritten origin.

    // Settings surface: GET reads the current channel, POST saves a new one.
    if (path.endsWith('/settings')) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ...snapshot() }))
        return
      }
      if (req.method === 'POST') {
        const saved = await readJson(req, res, 4096)
        if (saved === undefined) return
        try {
          const state = await saveProvider(saved.provider)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, ...state }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
        }
        return
      }
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    if (req.method !== 'POST' || !path.endsWith('/enhance')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }
    const body = await readJson(req, res, options.maxInputChars * 4 + 4096)
    if (body === undefined) return
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    if (text === '') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '草稿为空' }))
      return
    }
    if (text.length > options.maxInputChars) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `草稿超过 ${options.maxInputChars} 字符` }))
      return
    }
    const key = sessionId ?? '(no-session)'
    if (inflight.has(key)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '上一次增强仍在进行' }))
      return
    }
    inflight.add(key)
    try {
      const language = detectLanguage(text)
      const enhanced = await enhance(text, sessionId, language)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, enhanced, lane: usedLane, ...(lastFallback === null ? {} : { fallback: lastFallback }) }))
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      if (status === 500) logger.warn?.(`prompt-enhance: ${String(error?.message ?? error)}`)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? '增强失败') }))
    } finally {
      inflight.delete(key)
    }
  }

  // The route lives in its own fiber so a composition without an HTTP server cannot take the plugin down.
  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/prompt-enhance', handler }),
      'prompt-enhance: api routes',
    )
    logger.info?.('prompt-enhance: enhance API mounted at /api/prompt-enhance')
  })
}
