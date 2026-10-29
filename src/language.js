/**
 * Language detection for the enhance lane.
 *
 * The enhancer must answer in the user's own language. Models otherwise drift to
 * whatever language dominates their training data — CJK scripts are the risk,
 * because a Chinese draft has been answered in Japanese. Detection therefore runs
 * on the draft BEFORE generation and its result is pinned into the prompt.
 *
 * Detection is script-based, not dictionary-based: it counts characters in the
 * Unicode ranges that distinguish Chinese, Japanese and Korean, plus Latin script
 * for European languages. Code, paths, identifiers and numbers are stripped first
 * so they cannot vote, which also keeps them byte-identical in the rewrite.
 *
 * @module src/language
 */

/** @typedef {'zh' | 'ja' | 'ko' | 'en' | 'unknown'} Language */

/** Human-readable language names for the pinned instruction. */
export const LANGUAGE_NAMES = Object.freeze({
  zh: 'Chinese (Simplified Chinese, 简体中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  en: 'English',
  unknown: 'the same language as the user draft',
})

/** CJK ranges. Hiragana and Katakana are Japanese-only; Hangul is Korean-only. */
const RANGES = [
  { script: 'ja', re: /[\u3040-\u309F]/gu },
  { script: 'ja', re: /[\u30A0-\u30FF]/gu },
  { script: 'ko', re: /[\uAC00-\uD7AF\u1100-\u11FF]/gu },
  { script: 'cjk', re: /[\u4E00-\u9FFF\u3400-\u4DBF]/gu },
  { script: 'latin', re: /[A-Za-z\u00C0-\u024F]/gu },
]

/** Fenced and inline code, which must not influence detection. */
const CODE_BLOCKS = [
  /```[\s\S]*?```/gu,
  /~~~[\s\S]*?~~~/gu,
  /`[^`\n]+`/gu,
]

/** Digits, whitespace, punctuation and symbols appear in every language. */
const NEUTRAL = /[0-9\s\p{P}\p{S}]/gu

/**
 * Blank the parts of a draft that must survive verbatim and must not vote:
 * fenced/inline code, URLs, file paths, and identifier-like tokens.
 * @param text - the raw draft.
 * @returns the prose-only remainder.
 */
export function stripNonProse(text) {
  let out = text
  for (const re of CODE_BLOCKS) out = out.replace(re, ' ')
  out = out.replace(/https?:\/\/\S+/gu, ' ')
  out = out.replace(/[A-Za-z]:\\\S*/gu, ' ')
  // Any token carrying a path separator is a path, not prose.
  out = out.replace(/\S*\/\S*/gu, ' ')
  // File names with a known extension.
  out = out.replace(/\b[\w.-]+\.(?:js|mjs|cjs|ts|jsx|tsx|py|go|rs|java|kt|json|ya?ml|md|css|html|txt|sh|ps1|exe|dll|toml|ini|env|sql|xml)\b/giu, ' ')
  // Function calls, dotted member access, flags, snake_case and camelCase identifiers.
  out = out.replace(/\b[\w$]+\s*\([^)]*\)/gu, ' ')
  out = out.replace(/\b[\w$]+(?:\.[\w$]+)+\b/gu, ' ')
  out = out.replace(/\b[\w$]+(?:_[\w$]+)+\b/gu, ' ')
  out = out.replace(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/gu, ' ')
  out = out.replace(/\b--?[\w-]+\b/gu, ' ')
  out = out.replace(/\b\d+(?:\.\d+){1,3}\b/gu, ' ')
  return out
}

/**
 * Detect the dominant language of a draft.
 *
 * Kana outvotes ideographs: Japanese prose mixes Hiragana/Katakana with Kanji,
 * while Chinese prose contains no kana. Any kana therefore settles a CJK draft
 * as Japanese, and Hangul settles it as Korean; a pure-ideograph draft is Chinese.
 *
 * @param text - the raw draft.
 * @returns the detected language, `unknown` when there is no prose signal.
 */
export function detectLanguage(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'unknown'
  const prose = stripNonProse(text).replace(NEUTRAL, '')
  const counts = { ja: 0, ko: 0, cjk: 0, latin: 0 }
  for (const { script, re } of RANGES) counts[script] += (prose.match(re) ?? []).length
  const cjkTotal = counts.cjk + counts.ja + counts.ko
  if (cjkTotal === 0 && counts.latin === 0) return 'unknown'
  // Kana/Hangul settle the draft outright: they cannot appear in Chinese prose.
  if (counts.ja > 0) return 'ja'
  if (counts.ko > 0) return 'ko'
  // Ideographs with no kana are Chinese, unless Latin prose clearly dominates.
  // One ideograph carries roughly a word's worth of content, so it is weighted
  // against raw Latin character count; a Chinese draft that names an English
  // library must still read as Chinese.
  const ideographWeight = 2.5
  if (counts.cjk > 0 && counts.cjk * ideographWeight >= counts.latin) return 'zh'
  if (counts.latin > 0) return 'en'
  return counts.cjk > 0 ? 'zh' : 'unknown'
}

/**
 * The instruction pinned into a generation prompt so the answer cannot drift.
 * @param language - detected language.
 * @returns one imperative line naming the required output language.
 */
export function languageInstruction(language) {
  if (language === 'zh') return 'OUTPUT LANGUAGE: Chinese (简体中文). The user draft is Chinese — write the improved prompt in Simplified Chinese only. Never answer in Japanese, Korean or English, even if the topic or the model default suggests another language.'
  if (language === 'ja') return 'OUTPUT LANGUAGE: Japanese (日本語). The user draft is Japanese — write the improved prompt in Japanese only, using kanji, hiragana and katakana. Never answer in Chinese, Korean or English.'
  if (language === 'ko') return 'OUTPUT LANGUAGE: Korean (한국어). The user draft is Korean — write the improved prompt in Korean (Hangul) only. Never answer in Chinese, Japanese or English.'
  if (language === 'en') return 'OUTPUT LANGUAGE: English. The user draft is English — write the improved prompt in English only. Never answer in Chinese, Japanese, Korean or any other language.'
  return 'OUTPUT LANGUAGE: keep the exact language of the user draft. Never switch to another language.'
}

/**
 * Whether generated text is written in the required language.
 *
 * A mismatch is reported only when the answer has clear evidence of another
 * script; an empty or ambiguous answer is not a language failure, so callers
 * never discard usable text on a weak signal.
 *
 * @param text - the generated prompt.
 * @param language - the required language.
 * @returns true when the text matches the requirement (or cannot be judged).
 */
export function matchesLanguage(text, language) {
  if (typeof text !== 'string' || text.trim() === '') return true
  const prose = stripNonProse(text).replace(NEUTRAL, '').trim()
  // A technical leftover such as `a = 1` has no prose to judge; never reject it.
  if (prose.length < 2) return true
  const actual = detectLanguage(text)
  if (actual === 'unknown') return true
  return actual === language
}

/** Tokens in the draft that must survive the rewrite unchanged. */
export function preserveTokens(text) {
  const tokens = new Set()
  const add = (value) => { const v = value.trim(); if (v !== '') tokens.add(v) }
  // Code spans and URLs first: they are the units a rewrite must not touch.
  for (const match of text.match(/`[^`\n]+`/gu) ?? []) add(match)
  for (const match of text.match(/https?:\/\/\S+/gu) ?? []) add(match)
  for (const match of text.match(/[A-Za-z]:\\\S*/gu) ?? []) add(match)
  // Relative paths, with or without a leading separator.
  for (const match of text.match(/(?:^|[\s("'`])((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:js|mjs|cjs|ts|jsx|tsx|py|go|rs|java|kt|json|ya?ml|md|css|html|txt|sh|ps1|toml|ini|env|sql|xml))\b/giu) ?? []) {
    add(match.replace(/^[\s("'`]+/u, ''))
  }
  for (const match of text.match(/\b[\w$]+(?:_[\w$]+)+\b/gu) ?? []) add(match)
  for (const match of text.match(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/gu) ?? []) add(match)
  for (const match of text.match(/\bv?\d+(?:\.\d+){1,3}\b/gu) ?? []) add(match)
  for (const match of text.match(/\b\d+\b/gu) ?? []) add(match)
  return [...tokens]
}
