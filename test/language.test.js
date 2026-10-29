/**
 * Language-behaviour tests for the enhance lane.
 *
 * Run: node --test test/
 *
 * The regression this suite exists for: a Chinese draft was rewritten in
 * Japanese. Detection, the pinned instruction, and the mismatch guard are all
 * asserted here, plus the requirement that code, paths, identifiers and numbers
 * survive untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectLanguage, languageInstruction, matchesLanguage, preserveTokens, stripNonProse } from '../src/language.js'

/** Drafts grouped by the language they are written in. */
const DRAFTS = {
  zh: [
    '帮我优化这个提示词：做个登录页面',
    '你好，请帮我写个待办工具',
    '修复 `getUser()` 在 src/auth.js 里的 bug，返回 401',
    '用 React 和 Tailwind 做个登录页',
  ],
  en: [
    'Build a login page with React and Tailwind',
    'Refactor the auth middleware in src/auth.js to return 401 instead of 500',
    'Write a unit test for getUserById()',
  ],
  ja: [
    'ログインページを作ってください',
    '日本語でログインページの作り方を教えて',
    'このコードをリファクタリングしてください',
  ],
  ko: [
    '로그인 페이지를 만들어 주세요',
    '이 코드를 리팩터링해 주세요',
  ],
}

test('detectLanguage classifies every draft by its own script', () => {
  for (const [language, drafts] of Object.entries(DRAFTS)) {
    for (const draft of drafts) {
      assert.equal(detectLanguage(draft), language, `expected ${language} for ${JSON.stringify(draft)}`)
    }
  }
})

test('detection ignores code, paths, identifiers and numbers', () => {
  const chinese = '修复 `getUser()` 在 src/auth.js 里的 bug，返回 401'
  assert.equal(detectLanguage(chinese), 'zh')
  assert.equal(detectLanguage('```js\nconst value = 1\n```'), 'unknown')
  assert.equal(detectLanguage('src/auth.js getUserById --verbose'), 'en')
  assert.equal(detectLanguage('   '), 'unknown')
})

test('stripNonProse removes code, paths and identifiers but leaves prose', () => {
  const prose = stripNonProse('修复 `getUser()` 在 src/auth.js 里的 bug，返回 401')
  assert.equal(prose.includes('getUser'), false)
  assert.equal(prose.includes('auth.js'), false)
  assert.equal(prose.includes('修复'), true)
})

test('languageInstruction names the required language and forbids the drift', () => {
  for (const language of ['zh', 'en', 'ja', 'ko']) {
    const instruction = languageInstruction(language)
    assert.match(instruction, /OUTPUT LANGUAGE:/)
  }
  const zh = languageInstruction('zh')
  assert.match(zh, /Chinese/i)
  assert.match(zh, /Never answer in Japanese/i)
  const ja = languageInstruction('ja')
  assert.match(ja, /Japanese/i)
  const en = languageInstruction('en')
  assert.match(en, /English/i)
})

test('Chinese draft that names English libraries still reads as Chinese', () => {
  assert.equal(detectLanguage('用 React 和 Tailwind 做个登录页'), 'zh')
})

test('matchesLanguage accepts the required language', () => {
  assert.equal(matchesLanguage('请开发一个登录页面，包含用户名和密码输入框。', 'zh'), true)
  assert.equal(matchesLanguage('Build a login page with a username and password field.', 'en'), true)
  assert.equal(matchesLanguage('ログインページを作成してください。', 'ja'), true)
  assert.equal(matchesLanguage('로그인 페이지를 만들어 주세요.', 'ko'), true)
})

test('REGRESSION: a Chinese draft must never be answered in Japanese', () => {
  const draft = '帮我做个登录页面'
  assert.equal(detectLanguage(draft), 'zh')
  // The exact failure that was reported: Chinese in, Japanese out.
  const wrong = 'ログインページを作成してください。ユーザー名とパスワードの入力欄を含めてください。'
  assert.equal(detectLanguage(wrong), 'ja')
  assert.equal(matchesLanguage(wrong, 'zh'), false, 'Japanese output for a Chinese draft must be rejected')
  // And the correct answer passes.
  const right = '请创建一个登录页面，包含用户名和密码输入框。'
  assert.equal(matchesLanguage(right, 'zh'), true)
})

test('REGRESSION: Chinese stays Chinese even when the draft mentions Japanese', () => {
  // A Chinese sentence ABOUT Japanese must still be answered in Chinese.
  const draft = '把这段中文说明翻译成日语的说法，然后告诉我怎么用'
  const japanese = 'この説明を日本語に翻訳して、使い方を教えてください。'
  const chinese = '请把这段中文说明改写成日语的说法，并说明使用方法。'
  assert.equal(matchesLanguage(japanese, 'zh'), false)
  assert.equal(matchesLanguage(chinese, 'zh'), true)
  assert.equal(languageInstruction('zh').includes('Japanese'), true)
})

test('an English draft answered in Chinese is rejected', () => {
  assert.equal(matchesLanguage('请创建一个登录页面。', 'en'), false)
})

test('preserveTokens keeps code, paths, identifiers and versions', () => {
  const draft = '修复 `getUser()` 在 src/auth.js 的 bug，返回 401，版本 v2.1.3，用 getUserById 和 --verbose'
  const tokens = preserveTokens(draft)
  assert.ok(tokens.includes('`getUser()`'))
  assert.ok(tokens.includes('src/auth.js'))
  assert.ok(tokens.includes('401'))
  assert.ok(tokens.includes('v2.1.3'))
  assert.ok(tokens.includes('getUserById'))
})

test('an ambiguous answer is not treated as a language failure', () => {
  // No prose signal at all: callers must not discard whatever came back.
  assert.equal(matchesLanguage('a = 1', 'zh'), true)
  assert.equal(matchesLanguage('', 'zh'), true)
})
