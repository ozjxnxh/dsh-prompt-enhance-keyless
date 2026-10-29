/**
 * Persisted choice of enhancement channel.
 *
 * Two channels exist: the Session's own conversational model, and the keyless
 * Pollinations endpoint. Which one answers is a user preference, so it lives in
 * one small JSON file next to the plugin and is read on every request — saving
 * takes effect immediately, with no Host restart.
 *
 * The keyless channel enforces one reply per 30 seconds per IP upstream. That
 * limit is recorded here as a timestamp so this plugin can honour it locally
 * instead of spending a call to discover it.
 *
 * @module src/settings
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The two channels a user may choose between. */
export const CHANNELS = Object.freeze(['model', 'keyless', 'auto'])

/** Channels offered by the settings UI, in display order. */
export const CHANNEL_OPTIONS = Object.freeze([
  {
    value: 'model',
    title: '对话模型',
    description: '使用当前会话所选的模型改写提示词。质量最高，按模型额度计费。',
  },
  {
    value: 'keyless',
    title: 'Pollinations 免登录通道',
    description: '无需登录、不消耗模型额度；每 30 秒限 1 次，冷却期自动改用对话模型，冷却结束自动切回。',
  },
])

/** Upstream anonymous quota: one reply per 30 s per IP (observed live). */
export const KEYLESS_MIN_INTERVAL_MS = 30_000

/** Plugin directory — the settings file lives beside the code. */
const PLUGIN_DIR = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/** Runtime state directory (created on first write). */
const STATE_DIR = path.join(PLUGIN_DIR, '.runtime')

/** The persisted state file. */
const STATE_FILE = path.join(STATE_DIR, 'settings.json')

/** Shape written to disk. */
const DEFAULTS = Object.freeze({
  provider: 'auto',
  /** Epoch milliseconds of the last keyless call, honoured as a local rate limit. */
  keylessLastAt: 0,
})

/** In-memory mirror of the file, so a request never waits on disk twice. */
const cache = { provider: undefined, keylessLastAt: 0 }

/** Validate the stored channel, falling back to the default. */
function normalizeProvider(value, fallback) {
  return CHANNELS.includes(value) ? value : fallback
}

/**
 * Read the current choice, seeding it from the Cordis config on first run.
 * @param configured - the entry's `provider` config, when the profile sets one.
 * @returns the effective channel.
 */
export async function readProvider(configured) {
  if (cache.provider !== undefined) return cache.provider
  const fallback = normalizeProvider(configured, DEFAULTS.provider)
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8')
    const stored = JSON.parse(raw)
    cache.provider = normalizeProvider(stored?.provider, fallback)
    cache.keylessLastAt = Number.isFinite(stored?.keylessLastAt) ? stored.keylessLastAt : 0
  } catch {
    cache.provider = fallback
  }
  return cache.provider
}

/** Serialized write chain: concurrent saves commit in submission order. */
let writeQueue = Promise.resolve()

/**
 * Write the whole state atomically.
 *
 * Each write uses its own temp name and every write joins one promise chain,
 * so two concurrent saves can never delete each other's temp file, and a
 * half-written document is never observable at the final path.
 */
async function persist() {
  const payload = { provider: cache.provider, keylessLastAt: cache.keylessLastAt }
  const run = async () => {
    const temp = STATE_FILE + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
    const attempt = async () => {
      await fs.mkdir(STATE_DIR, { recursive: true })
      await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      await fs.rename(temp, STATE_FILE)
    }
    try {
      await attempt()
    } catch (error) {
      // Another process may have removed the runtime directory between our
      // mkdir and the open (tests clean it concurrently). Re-create and retry
      // once; a genuine permission failure is reported as-is.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EPERM') {
        try {
          await fs.rm(temp, { force: true }).catch(() => {})
          await attempt()
          return
        } catch (retryError) {
          await fs.rm(temp, { force: true }).catch(() => {})
          throw retryError
        }
      }
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const next = writeQueue.then(run, run)
  writeQueue = next.catch(() => {})
  return next
}

/**
 * Save a new channel.
 * @param provider - the chosen channel.
 * @returns the state as the UI should show it.
 */
export async function saveProvider(provider) {
  if (!CHANNELS.includes(provider)) throw new Error('未知的通道: ' + String(provider))
  cache.provider = provider
  await persist()
  return snapshot()
}

/** Record that a keyless call was just spent, for local rate limiting. */
export async function noteKeylessCall(now = Date.now()) {
  cache.keylessLastAt = now
  try { await persist() } catch { /* a lost timestamp only costs one wasted call */ }
}

/**
 * Remaining wait before the keyless channel may be used again.
 * @returns milliseconds still to wait, zero when a call is allowed.
 */
export function keylessWaitMs(now = Date.now()) {
  const elapsed = now - cache.keylessLastAt
  const remaining = KEYLESS_MIN_INTERVAL_MS - elapsed
  return remaining > 0 ? remaining : 0
}

/** The state the settings UI renders. */
export function snapshot() {
  return {
    provider: cache.provider ?? DEFAULTS.provider,
    options: CHANNEL_OPTIONS,
    limits: { keylessMinIntervalMs: KEYLESS_MIN_INTERVAL_MS },
    keylessLastAt: cache.keylessLastAt,
    keylessWaitMs: keylessWaitMs(),
  }
}

/**
 * Drop every cached and persisted setting.
 *
 * The provider and quota timestamps are mirrored in memory so a request never
 * waits on disk; a test (or a host reset) that clears the file must clear that
 * mirror too, or a stale timestamp silently short-circuits the next lane choice.
 */
export async function resetRuntimeState() {
  cache.provider = undefined
  cache.keylessLastAt = 0
  try {
    await fs.rm(STATE_DIR, { recursive: true, force: true })
  } catch { /* an absent directory is already a clean state */ }
}

/** Absolute path of the settings file, for diagnostics. */
export function settingsPath() {
  return STATE_FILE
}
