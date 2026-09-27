import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import terminalCss from '@xterm/xterm/css/xterm.css'

const { useCallback, useEffect, useRef, useState } = React
const h = React.createElement
const CHANNEL = '/dsh-terminal-pane'
const STYLE_ID = 'dsh-terminal-pane-style'
const CSS = `
  .dtp-root { width: 100%; max-width: 1100px; box-sizing: border-box; margin: 8px auto; border: 1px solid #e0e3e9; border-radius: 12px; overflow: hidden; background: #fff; color: #000; }
  .dtp-toolbar { display: flex; align-items: center; gap: 6px; min-height: 42px; padding: 5px 8px; background: #f5f6f8; border-bottom: 1px solid #e0e3e9; }
  .dtp-tabs { display: flex; gap: 6px; overflow-x: auto; }
  .dtp-tab { display: flex; align-items: center; gap: 16px; border: 1px solid transparent; border-radius: 9px; color: #586074; }
  .dtp-tab-active { border-color: #e0e3e9; background: #fff; color: #202534; }
  .dtp-tab button, .dtp-action { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; }
  .dtp-tab-label { display: flex; align-items: center; gap: 8px; padding: 7px 10px; white-space: nowrap; font-size: 13px; }
  .dtp-close { padding: 6px 10px 6px 0; font-size: 18px; color: #7d8594 !important; }
  .dtp-action { width: 30px; height: 30px; border-radius: 6px; color: #657085; font-size: 20px; }
  .dtp-action:hover { background: #e7eaf0; }
  .dtp-action:focus-visible, .dtp-tab button:focus-visible { outline: 2px solid #717c91; outline-offset: -2px; }
  .dtp-spacer { flex: 1; }
  .dtp-collapsed { font-size: 13px; padding: 6px; width: auto; }
  .dtp-screen { height: 320px; min-height: 320px; padding: 12px 14px; box-sizing: border-box; background: #fff; }
  .dtp-screen .xterm { height: 100%; }
  .dtp-screen .xterm .scrollbar .slider { border-radius: 2px; }
  .dtp-error { padding: 8px 14px; color: #b42318; font-size: 12px; background: #fff; }
`

/** Use the authenticated harness carrier for terminal operations. */
async function rpc(ctx, endpoint, payload) {
  const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload)
  if (!result?.ok) throw new Error(result?.error?.message || 'Terminal connection failed')
  return result.value
}

/** Own one emulator and PTY; relay raw input and incremental output. */
function TerminalView({ ctx, tab, active, rename }) {
  const container = useRef(null)
  const terminal = useRef(null)
  const fitRef = useRef(null)
  const activeRef = useRef(active)
  const [error, setError] = useState(null)
  activeRef.current = active

  useEffect(() => {
    let disposed = false
    let ready = false
    let cursor = 0
    let timer
    let writes = Promise.resolve()
    const term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      overviewRuler: { width: 5 },
      theme: { background: '#ffffff', foreground: '#000000', cursor: '#000000', cursorAccent: '#ffffff', selectionBackground: '#dce5f5' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container.current)
    fit.fit()
    terminal.current = term
    fitRef.current = fit

    const fail = (cause) => {
      if (disposed) return
      ready = false
      term.options.disableStdin = true
      setError(cause.message)
    }
    const input = term.onData((text) => {
      if (!ready) return
      writes = writes.then(() => {
        if (!disposed && ready) return rpc(ctx, 'write', { key: tab.id, text })
      }).catch(fail)
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (ready) void rpc(ctx, 'resize', { key: tab.id, cols, rows }).catch(fail)
    })
    const observer = new ResizeObserver(() => {
      if (activeRef.current && container.current?.clientWidth) fit.fit()
    })
    observer.observe(container.current)

    const poll = async () => {
      if (disposed || !ready) return
      try {
        const value = await rpc(ctx, 'read', { key: tab.id, cursor })
        if (disposed) return
        if (value.reset) term.reset()
        if (value.text) term.write(value.text)
        cursor = value.cursor
        timer = setTimeout(poll, activeRef.current ? 80 : 500)
      } catch (cause) {
        fail(cause)
      }
    }
    void rpc(ctx, 'open', { key: tab.id, cols: term.cols, rows: term.rows }).then((value) => {
      if (disposed) {
        void rpc(ctx, 'close', { key: tab.id }).catch(() => {})
        return
      }
      cursor = value.cursor
      term.write(value.text)
      rename(tab.id, value.cwd.split(/[\\/]/).filter(Boolean).pop() || 'Terminal')
      ready = true
      term.options.disableStdin = false
      if (activeRef.current) {
        fit.fit()
        term.focus()
      }
      void poll()
    }).catch(fail)

    return () => {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      input.dispose()
      resize.dispose()
      term.dispose()
      terminal.current = null
      fitRef.current = null
      if (ready) void rpc(ctx, 'close', { key: tab.id }).catch(() => {})
    }
  }, [ctx, tab.id, rename])

  useEffect(() => {
    if (active && terminal.current) {
      fitRef.current.fit()
      terminal.current.focus()
    }
  }, [active])

  return h('div', { style: { display: active ? 'block' : 'none' } },
    error ? h('div', { className: 'dtp-error', role: 'alert' }, error) : null,
    h('div', { className: 'dtp-screen', ref: container, 'aria-label': `${tab.title} terminal` }),
  )
}

/** Render Codex-style terminal tabs with input directly at the shell cursor. */
function TerminalPane({ ctx }) {
  const [open, setOpen] = useState(false)
  const [tabs, setTabs] = useState([])
  const [selected, setSelected] = useState(null)
  const rename = useCallback((id, title) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, title } : tab))
  }, [])

  const add = () => {
    const id = crypto.randomUUID()
    setTabs((current) => [...current, { id, title: 'Terminal' }])
    setSelected(id)
    setOpen(true)
  }
  const close = (id) => {
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    if (selected === id) setSelected(remaining.at(-1)?.id ?? null)
    if (!remaining.length) setOpen(false)
  }
  const toggle = () => {
    if (!tabs.length) add()
    else setOpen((value) => !value)
  }

  return h('div', { className: 'dtp-root' },
    h('div', { className: 'dtp-toolbar' },
      open ? h('div', { className: 'dtp-tabs', role: 'tablist', 'aria-label': 'Terminals' },
        ...tabs.map((tab) => h('div', { key: tab.id, className: `dtp-tab${selected === tab.id ? ' dtp-tab-active' : ''}` },
          h('button', { className: 'dtp-tab-label', role: 'tab', 'aria-selected': selected === tab.id, onClick: () => setSelected(tab.id) },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
              h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 }),
              h('path', { d: 'm7 8 3 3-3 3m6 1h4' }),
            ), tab.title),
          h('button', { className: 'dtp-close', 'aria-label': `Close ${tab.title} terminal`, onClick: () => close(tab.id) }, '×'),
        )),
      ) : h('button', { className: 'dtp-action dtp-collapsed', onClick: toggle }, 'Terminal'),
      h('button', { className: 'dtp-action', 'aria-label': 'New terminal', onClick: add, disabled: tabs.length >= 8 }, '+'),
      h('span', { className: 'dtp-spacer' }),
      h('button', { className: 'dtp-action', 'aria-label': open ? 'Collapse terminal' : 'Expand terminal', 'aria-expanded': open, onClick: toggle }, open ? '⌄' : '⌃'),
    ),
    ...tabs.map((tab) => h(TerminalView, { key: tab.id, ctx, tab, active: open && selected === tab.id, rename })),
  )
}

export default {
  inject: ['connection', 'slots'],
  apply(ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = terminalCss + CSS
      document.head.appendChild(style)
    }
    ctx.slots.inject('conversation.composer.dock', () =>
      ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'terminal-pane', order: 10 },
        (props) => h(TerminalPane, { ...props, ctx }),
      ),
    )
  },
}
