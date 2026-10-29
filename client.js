/**
 * dsh-prompt-enhance — Client half.
 *
 * Contributes the 「增强提示词」 sparkle button to the composer toolbar
 * (slot `conversation.input.right`, the seat left of the model selector),
 * exactly where the reference screenshot shows it. Clicking it POSTs the
 * current draft to the plugin's Host route and replaces the draft with the
 * enhanced text; a transient 「撤销」 button restores the original.
 *
 * Hand-written ModuleLoader bundle: no build step. React comes from the
 * shell; Button / Tooltip / IconSparkleRegular from the primitives graph row
 * (declared in package.json dsh.client.inject, the same contract the official
 * voice-input plugin uses).
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Tooltip, IconSparkleRegular } = primitives

    const NS = 'prompt-enhance'
    const inject = ['slots', 'locale']

    // ── settings section (inlined from src/settings-view.js) ──

    const SETTINGS_CSS = ".pe-set{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6)}\n.pe-set-head{font-size:15px;font-weight:600}\n.pe-set-sub{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;line-height:1.6}\n.pe-card{border:1px solid var(--dsw-alias-border-l2,rgb(255 255 255 / 12%));border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}\n.pe-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c9ccd0)}\n.pe-opt{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:8px;border:1px solid transparent;cursor:pointer}\n.pe-opt:hover{background:var(--dsw-alias-bg-l3,rgb(255 255 255 / 6%))}\n.pe-opt-on{border-color:var(--dsw-alias-brand-primary,#f9fafb);background:var(--dsw-alias-bg-l3,rgb(255 255 255 / 6%))}\n.pe-radio{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2,rgb(255 255 255 / 30%));flex:0 0 auto;margin-top:2px;position:relative}\n.pe-radio-on{border-color:var(--dsw-alias-brand-primary,#f9fafb)}\n.pe-radio-on::after{content:'';position:absolute;inset:3px;border-radius:50%;background:var(--dsw-alias-brand-primary,#f9fafb)}\n.pe-opt-body{display:flex;flex-direction:column;gap:3px;min-width:0}\n.pe-opt-name{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n.pe-tag{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgb(255 255 255 / 20%));color:var(--dsw-alias-label-tertiary,#9aa0a6)}\n.pe-tag-warn{border-color:rgb(240 178 90 / 55%);color:#f0b25a}\n.pe-opt-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#9aa0a6)}\n.pe-note{border:1px solid rgb(240 178 90 / 35%);background:rgb(240 178 90 / 8%);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}\n.pe-note-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;color:#f0b25a}\n.pe-note-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#c9ccd0)}\n.pe-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.pe-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}\n.pe-ok{color:#54b47a}\n.pe-err{color:#e5484d}\n.pe-btn{font:inherit;font-size:12.5px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgb(255 255 255 / 20%));background:transparent;color:inherit;cursor:pointer}\n.pe-btn:hover{background:var(--dsw-alias-bg-l3,rgb(255 255 255 / 8%))}\n.pe-btn:disabled{opacity:.5;cursor:not-allowed}\n.pe-btn-primary{border-color:#f9fafb;background:#f9fafb;color:#111}\n.pe-btn-primary:hover{filter:brightness(.92)}\n.pe-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}"

    /** Same-origin settings route. */
    function settingsEndpoint() {
      try { return new URL('api/prompt-enhance/settings', document.baseURI).href } catch { return '/api/prompt-enhance/settings' }
    }

    /** Read the persisted state. @returns the Host snapshot, or null when unavailable. */
    async function loadSettings() {
      try {
        const response = await fetch(settingsEndpoint(), { headers: { accept: 'application/json' }, redirect: 'error' })
        const text = await response.text()
        const payload = text === '' ? {} : JSON.parse(text)
        return response.ok && payload.ok === true ? payload : null
      } catch { return null }
    }

    /** Save the chosen channel. @returns the new Host state. */
    async function saveSettings(provider) {
      const response = await fetch(settingsEndpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
        redirect: 'error',
      })
      const text = await response.text()
      const payload = text === '' ? {} : JSON.parse(text)
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
      return payload
    }

    /**
     * Build the section component from the shell's React and primitives.
     * @param deps - React and the primitives the section needs.
     * @returns the section component.
     */
    function createSettingsSection({ React, primitives }) {
      const h = React.createElement
      const { useState, useEffect } = React
      const { IconWarningOutlineRegular } = primitives

      const FALLBACK_OPTIONS = [
        { value: 'model', title: '对话模型', description: '使用当前会话所选的模型改写提示词。质量最高，按模型额度计费。' },
        { value: 'keyless', title: 'Pollinations 免登录通道', description: '无需登录、不消耗模型额度；每 30 秒限 1 次，冷却期自动改用对话模型，冷却结束自动切回。' },
      ]

      return function EnhanceSettingsSection({ t }) {
        const [state, setState] = useState(null)
        const [draft, setDraft] = useState(null)
        const [busy, setBusy] = useState(false)
        const [status, setStatus] = useState({ kind: 'idle', text: '' })

        useEffect(() => {
          let live = true
          void (async () => {
            const snapshot = await loadSettings()
            if (!live) return
            setState(snapshot)
            setDraft(snapshot === null ? 'auto' : snapshot.provider)
            if (snapshot === null) setStatus({ kind: 'error', text: '无法读取当前设置，请确认插件已加载。' })
          })()
          return () => { live = false }
        }, [])

        const options = (state && state.options) || FALLBACK_OPTIONS
        const saved = (state && state.provider) || 'auto'
        const dirty = draft !== null && draft !== saved
        const titleOf = (value) => {
          const hit = options.find((o) => o.value === value)
          return hit ? hit.title : value
        }

        const apply = async () => {
          if (draft === null || busy) return
          setBusy(true)
          setStatus({ kind: 'idle', text: '' })
          try {
            const next = await saveSettings(draft)
            setState(next)
            setStatus({ kind: 'ok', text: '已保存，下一次点击「增强提示词」立即生效。' })
          } catch (error) {
            setStatus({ kind: 'error', text: '保存失败：' + ((error && error.message) || String(error)) })
          } finally {
            setBusy(false)
          }
        }

        const choose = (value) => {
          if (busy) return
          setDraft(value)
          setStatus({ kind: 'idle', text: '' })
        }

        const rows = options.map((option) => {
          const on = draft === option.value
          return h('div', {
            key: option.value,
            className: 'pe-opt' + (on ? ' pe-opt-on' : ''),
            role: 'radio',
            'aria-checked': on,
            tabIndex: 0,
            onClick: () => choose(option.value),
            onKeyDown: (event) => {
              if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); choose(option.value) }
            },
          },
            h('span', { className: 'pe-radio' + (on ? ' pe-radio-on' : '') }),
            h('div', { className: 'pe-opt-body' },
              h('span', { className: 'pe-opt-name' },
                option.title,
                option.value === 'keyless' ? h('span', { key: 'a', className: 'pe-tag pe-tag-warn' }, '免登录') : null,
                option.value === 'keyless' ? h('span', { key: 'b', className: 'pe-tag' }, '30 秒 / 次') : null),
              h('span', { className: 'pe-opt-desc' }, option.description)))
        })

        return h('div', { className: 'pe-set' },
          h('div', { className: 'pe-set-head' }, '提示词增强'),
          h('div', { className: 'pe-set-sub' }, '选择改写草稿时使用的模型来源。选择保存在本机，修改后下一次点击「增强提示词」即刻生效。'),

          h('div', { className: 'pe-card' },
            h('div', { className: 'pe-card-title' }, '增强模型来源'),
            rows),

          h('div', { className: 'pe-note' },
            h('div', { className: 'pe-note-head' }, h(IconWarningOutlineRegular, { size: 14 }), 'Pollinations 免登录通道存在 30 秒请求限制'),
            h('ul', { className: 'pe-note-list' },
              h('li', null, '该通道为匿名免费通道，上游限制为每 30 秒只能请求 1 次（按 IP 计），无法解除。'),
              h('li', null, '影响与规则：冷却期间点击不会失败——插件自动改用当前对话模型完成改写；30 秒冷却结束后，下一次点击自动切回 Pollinations 免登录通道，无需手动切换。'),
              h('li', null, '插件在本地记录上次调用时间：剩余冷却时间会随返回结果注明本次由哪条通道完成，不会浪费任何一次请求。'),
              h('li', null, '建议：想省额度选「Pollinations 免登录通道」（冷却期自动转对话模型兜底）；持续高频改写可固定选「对话模型」。'))),

          h('div', { className: 'pe-row' },
            h('button', {
              className: 'pe-btn pe-btn-primary',
              type: 'button',
              disabled: busy || !dirty,
              onClick: () => { void apply() },
            }, busy ? '保存中…' : '保存'),
            h('button', {
              className: 'pe-btn',
              type: 'button',
              disabled: busy || !dirty,
              onClick: () => { setDraft(saved); setStatus({ kind: 'idle', text: '' }) },
            }, '还原'),
            h('span', { className: 'pe-status' + (status.kind === 'ok' ? ' pe-ok' : status.kind === 'error' ? ' pe-err' : '') },
              status.text !== '' ? status.text : dirty ? '有未保存的修改' : '当前生效：' + titleOf(saved))),

          h('div', { className: 'pe-meta' }, '当前选择：' + titleOf(saved) + '（' + saved + '）'),
        )
      }
    }




    const zh = {
      enhance: '增强提示词',
      busy: '增强中…',
      undo: '撤销',
      failed: '增强失败',
    }
    const en = {
      enhance: 'Enhance prompt',
      busy: 'Enhancing…',
      undo: 'Undo',
      failed: 'Enhancement failed',
    }

    const CSS = [
      '.pe-spin{animation:pe-spin-kf 1s linear infinite}',
      '@keyframes pe-spin-kf{to{transform:rotate(360deg)}}',
      '.pe-undo{font-size:12px;line-height:1;white-space:nowrap}',
      '.pe-error{color:var(--dsw-color-danger,#e5484d);font-size:12px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}',
    ].join('')

    /** Same-origin route, resolved against the page base so a proxied sub-path keeps working. */
    function endpoint() {
      try { return new URL('api/prompt-enhance/enhance', document.baseURI).href } catch { return '/api/prompt-enhance/enhance' }
    }

    /** One enhance request to the Host half. @returns the enhanced text. */
    async function requestEnhance(text, sessionId) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 100_000)
      try {
        const response = await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...(sessionId === void 0 ? {} : { sessionId }) }),
          redirect: 'error',
          signal: ctrl.signal,
        })
        const text0 = await response.text()
        let payload
        try { payload = text0 === '' ? {} : JSON.parse(text0) } catch { payload = { error: text0.slice(0, 160) } }
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? 'HTTP ' + response.status)
        if (typeof payload.enhanced !== 'string' || payload.enhanced === '') throw new Error('empty result')
        return payload.enhanced
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('请求超时')
        throw error instanceof Error ? error : new Error(String(error))
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * The composer button. Reads the draft through the standard `useInput`
     * hook and writes through `inputActions.setDraft`; both are provided by
     * the conversation UI to every session-scope slot component.
     */
    function EnhanceButton({ sessionId, inputActions, useInput, t }) {
      const draft = useInput((state) => state.draft)
      const phase = useInput((state) => state.phase)
      const [busy, setBusy] = useState(false)
      /** { before, after } while the undo offer is on screen. */
      const [undo, setUndo] = useState(null)
      const [error, setError] = useState('')
      const generation = useRef(0)
      const timer = useRef(undefined)
      const clearTimer = () => { if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined } }
      useEffect(() => () => { generation.current++; clearTimer() }, [])
      // Session switches drop any transient offer; a stale generation ignores late settlements.
      useEffect(() => { generation.current++; setUndo(null); setError(''); setBusy(false) }, [sessionId])

      const offerUndo = useCallback((before, after) => {
        setUndo({ before, after })
        clearTimer()
        timer.current = setTimeout(() => setUndo(null), 8000)
      }, [])
      const showFailure = useCallback((message) => {
        setError(message)
        clearTimer()
        timer.current = setTimeout(() => setError(''), 5000)
      }, [])

      const run = async () => {
        const text = (draft ?? '').trim()
        if (text === '' || busy || undo !== null) return
        const run0 = ++generation.current
        clearTimer()
        setUndo(null); setError(''); setBusy(true)
        try {
          const enhanced = await requestEnhance(text, sessionId)
          if (run0 !== generation.current) return
          inputActions.setDraft(enhanced)
          offerUndo(text, enhanced)
        } catch (failure) {
          if (run0 === generation.current) showFailure(failure?.message ?? String(failure))
        } finally {
          if (run0 === generation.current) setBusy(false)
        }
      }

      const locked = phase === 'submitting' || phase === 'adjudicating'

      if (undo !== null) {
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h(Button, {
            size: 'sm',
            type: 'button',
            className: 'pe-undo',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              generation.current++
              clearTimer()
              setUndo(null)
              // Restore only while the draft is still exactly what we wrote.
              if ((draft ?? '') === undo.after) inputActions.setDraft(undo.before)
            },
          }, t('undo')))
      }
      if (error !== '') {
        return h('button', {
          type: 'button',
          className: 'pe-error',
          title: error,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => { setError(''); run() },
        }, error)
      }
      return h(Tooltip, { label: t('enhance'), side: 'top', delayMs: 500, portal: true },
        h('span', null,
          h(Button, {
            size: 'sm',
            type: 'button',
            disabled: busy || locked || (draft ?? '').trim() === '',
            'aria-label': t('enhance'),
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => { void run() },
          }, h(IconSparkleRegular, { size: 18, className: busy ? 'pe-spin' : undefined }))))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-enhance: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-prompt-enhance')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'prompt-enhance: styles')
      // Settings section: appears in the settings sidebar beside Models/Plugins.
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-prompt-enhance-settings')
        style.textContent = SETTINGS_CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'prompt-enhance: settings styles')

      const SettingsSection = createSettingsSection({ React, primitives })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'prompt-enhance',
        order: 40,
        label: () => '提示词增强',
        locale: NS,
      }, SettingsSection))

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'prompt-enhance',
        order: 10,
        locale: NS,
      }, EnhanceButton))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'prompt-enhance'
    return module.exports
  },
})

