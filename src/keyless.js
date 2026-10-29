/**
 * Keyless (no-login) enhancement backends.
 *
 * Only backends that answered WITHOUT a credential from this machine are wired in.
 * Each adapter is OpenAI-shaped at its edge and returns the same contract so the
 * route can fall back across them.
 *
 * @module src/keyless
 */

import { languageInstruction, matchesLanguage } from './language.js'

/** Thrown when a backend refuses because its anonymous quota is spent, not because it broke. */
export class QuotaError extends Error {
  constructor(message, retryAfterMs) {
    super(message)
    this.name = 'QuotaError'
    this.retryAfterMs = retryAfterMs
  }
}

/** Per-backend cool-down after a quota refusal, so a click storm cannot hammer a limited channel. */
const cooldownUntil = new Map()

/** Remaining cool-down milliseconds for a backend. */
export function cooling(backend, now = Date.now()) {
  const until = cooldownUntil.get(backend)
  return until === undefined || until <= now ? 0 : until - now
}

/** Arm a cool-down for a backend. */
export function cool(backend, ms, now = Date.now()) {
  cooldownUntil.set(backend, now + ms)
}

/** The shared rewrite contract used by every keyless backend. */
export const ENHANCE_SYSTEM = [
  'You rewrite a single user prompt for an AI coding assistant. Output ONLY the rewritten prompt text.',
  'Keep the original intent, every concrete detail (paths, names, numbers, identifiers) and the language the user wrote in.',
  'Make the goal explicit and add missing structure (context, constraints, expected output) only where it helps. Never answer the prompt, never explain, never wrap in quotes or code fences.',
].join(' ')

/** Pull the assistant text out of an OpenAI-shaped response. */
function textOf(payload) {
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message
  if (message === undefined || message === null) return ''
  return typeof message.content === 'string' ? message.content.trim() : ''
}

/** POST one OpenAI-shaped chat completion. */
async function chatCompletion(url, body, signal, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  const raw = await response.text()
  if (response.status === 402 || response.status === 429) {
    let wait = 30_000
    const stated = raw.match(/Retry after (\d+)\s*s/i)
    if (stated !== null && stated !== undefined) wait = Number(stated[1]) * 1000
    const header = Number(response.headers.get('retry-after') ?? 0)
    if (Number.isFinite(header) && header > 0) wait = header * 1000
    throw new QuotaError((raw || '').slice(0, 160) || 'free quota reached', wait)
  }
  if (!response.ok) throw new Error('backend HTTP ' + response.status + ': ' + raw.slice(0, 120))
  try { return JSON.parse(raw) } catch { throw new Error('backend returned non-JSON') }
}

/**
 * Pollinations text API. No account, no key, no registration.
 *
 * Anonymous tier is deliberately narrow: one text model and one reply per 30 s
 * per IP (observed live). It is a last resort, never a primary path.
 */
async function pollinations(text, signal, language) {
  const payload = await chatCompletion(
    'https://text.pollinations.ai/openai',
    {
      model: 'openai-fast',
      messages: [
        { role: 'system', content: ENHANCE_SYSTEM + ' ' + languageInstruction(language) },
        { role: 'user', content: text },
      ],
    },
    signal,
    { referer: 'https://duck.ai/' },
  )
  const out = textOf(payload)
  if (out === '') throw new Error('pollinations returned no text')
  return out
}

/** Registered backends. */
export const KEYLESS_BACKENDS = Object.freeze({
  pollinations: { id: 'pollinations', label: 'Pollinations (免登录)', tight: true, enhance: pollinations },
})

/**
 * Try keyless backends in order, skipping any still cooling down.
 * @param text - the draft to rewrite.
 * @param order - backend ids to attempt.
 * @param signal - caller cancellation / deadline.
 * @param language - required output language detected from the draft.
 * @returns the rewritten text and the backend that produced it.
 */
export async function enhanceKeyless(text, order, signal, language) {
  const failures = []
  let quotaExhausted = false
  let quotaWaitMs = 30_000
  for (const id of order) {
    const backend = KEYLESS_BACKENDS[id]
    if (backend === undefined) continue
    if (cooling(id) > 0) { failures.push(id + ': 冷却中'); continue }
    try {
      const out = await backend.enhance(text, signal, language)
      // A wrong-language answer is a failure: let the caller try the next lane.
      if (!matchesLanguage(out, language)) throw new Error('wrong language: ' + language)
      return { text: out, backend: id }
    } catch (error) {
      if (error instanceof QuotaError) {
        cool(id, Math.max(error.retryAfterMs, 30_000))
        quotaExhausted = true
        quotaWaitMs = Math.max(quotaWaitMs, error.retryAfterMs || 0)
      }
      failures.push(id + ': ' + (error && error.message ? error.message : error))
      if (signal && signal.aborted === true) throw error
    }
  }
  const message = failures.length === 0 ? '没有可用的免登录后端' : failures.join('; ')
  // Every backend refused because the anonymous quota is closed: preserve the
  // QuotaError class so the caller can arm its local 30 s window and fall back
  // to the conversation model instead of re-hitting the upstream every click.
  if (quotaExhausted) {
    throw new QuotaError(message, quotaWaitMs)
  }
  throw new Error(message)
}
