import pty from 'node-pty'
import Schema from '@deepseek-ai/schemastery'

/** Logical RPC channel this plugin owns on the browser Connection carrier. */
const CHANNEL = '/dsh-terminal-pane'

/** Concurrent browser panels allowed before the oldest shell is evicted. */
const MAX_SESSIONS = 8

/** How long output must stay quiet before a send is considered settled. */
const QUIET_MS = 250

/** Hard ceiling on one send, so a long command still returns control. */
const SETTLE_TIMEOUT_MS = 15_000

export const Config = Schema.object({
  shell: Schema.string().default(''),
  cwd: Schema.string().default(''),
  scrollbackLimit: Schema.number().default(200_000),
})

/**
 * Pick a login shell for the host platform.
 * @returns {string} The shell executable to spawn.
 */
function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/**
 * Merge user config over the host defaults.
 * @param {object} config - Validated plugin config.
 * @returns {object} Resolved shell, working directory, and scrollback ceiling.
 */
function resolveConfig(config = {}) {
  return {
    shell: config.shell || defaultShell(),
    cwd: config.cwd || process.cwd(),
    scrollbackLimit: config.scrollbackLimit > 0 ? config.scrollbackLimit : 200_000,
  }
}

/**
 * One live PTY plus the bounded scrollback the browser pane renders.
 * @param {object} settings - Resolved shell, cwd, and scrollback ceiling.
 * @returns {object} A tracked session record.
 */
function openSession(settings, cols, rows) {
  const env = { ...process.env, TERM: 'xterm-256color' }
  delete env.npm_config_prefix
  delete env.NPM_CONFIG_PREFIX
  const term = pty.spawn(settings.shell, process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(20, cols | 0),
    rows: Math.max(5, rows | 0),
    cwd: settings.cwd,
    env,
  })
  const session = { term, buffer: '', dropped: 0, listeners: new Set() }
  term.onData((chunk) => {
    session.buffer += chunk
    if (session.buffer.length > settings.scrollbackLimit) {
      const excess = session.buffer.length - settings.scrollbackLimit
      session.buffer = session.buffer.slice(excess)
      session.dropped += excess
    }
    for (const listener of [...session.listeners]) listener()
  })
  term.onExit(() => {
    session.buffer += '\r\n[process exited]\r\n'
  })
  return session
}

/**
 * Resolve once the PTY has been quiet for QUIET_MS, or the cap expires.
 * @param {object} session - Session whose pending output is being settled.
 * @returns {Promise<string>} Text produced since the call started.
 */
function settle(session) {
  const start = session.buffer.length
  return new Promise((resolve) => {
    let quiet
    const cap = setTimeout(() => finish(), SETTLE_TIMEOUT_MS)
    function finish() {
      clearTimeout(cap)
      clearTimeout(quiet)
      session.listeners.delete(onOutput)
      resolve(session.buffer.slice(start))
    }
    function onOutput() {
      clearTimeout(quiet)
      quiet = setTimeout(finish, QUIET_MS)
    }
    session.listeners.add(onOutput)
    quiet = setTimeout(finish, QUIET_MS)
  })
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Register the normal RPC carrier, with an authenticated web fallback for DSH 0.1.5. */
function registerRpc(ctx, handler) {
  try {
    return ctx.connection.rpc.handle(CHANNEL, handler)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'cannot get property "webServer" without inject') throw error
    ctx.logger.warn('[JOB:terminal-rpc] using authenticated web route for DSH injection bug')
  }
  return ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const path = new URL(req.url, 'http://dsh.internal').pathname
      const endpoint = path.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || !/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) {
          res.writeHead(413, { connection: 'close' })
          res.end('request too large')
          return
        }
        chunks.push(chunk)
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const valid = message?.type === 'client-request' && typeof message.rpcId === 'string'
        && message.method === endpoint
      const result = valid
        ? await handler(endpoint, message.payload)
        : failure('gateway/bad-request', 'invalid client-request message')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request',
        result,
      }))
    },
  })
}

/**
 * Plugin body: expose panel shell operations as one RPC channel and own every PTY.
 * @param {object} ctx - Host root context carrying the connection carrier.
 * @param {object} config - Validated plugin config.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  ctx.effect(() => {
    /** Client-minted key -> live session, so each browser panel owns its own shell. */
    const sessions = new Map()

    const endpoints = {
      open: async (payload) => {
        const key = String(payload.key ?? '')
        if (!key) throw new Error('open requires a key')
        if (sessions.has(key)) throw new Error('session already open')
        while (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value
          const evicted = sessions.get(oldest)
          sessions.delete(oldest)
          evicted.term.kill()
        }
        const session = openSession(settings, payload.cols ?? 120, payload.rows ?? 30)
        sessions.set(key, session)
        const delta = await settle(session)
        return { key, cwd: settings.cwd, delta, text: session.buffer, dropped: session.dropped, cursor: session.dropped + session.buffer.length }
      },
      send: async (payload) => {
        const session = sessions.get(String(payload.key ?? ''))
        if (!session) throw new Error('no such terminal session')
        session.term.write(`${payload.text ?? ''}${payload.submit === false ? '' : '\r'}`)
        const delta = await settle(session)
        return { delta, text: session.buffer, dropped: session.dropped }
      },
      read: async (payload) => {
        const session = sessions.get(String(payload.key ?? ''))
        if (!session) throw new Error('no such terminal session')
        const cursor = session.dropped + session.buffer.length
        const reset = payload.cursor < session.dropped
        const start = Number.isSafeInteger(payload.cursor) ? Math.max(0, payload.cursor - session.dropped) : 0
        return { text: session.buffer.slice(start), cursor, reset }
      },
      write: async (payload) => {
        const session = sessions.get(String(payload.key ?? ''))
        if (!session) throw new Error('no such terminal session')
        session.term.write(String(payload.text ?? ''))
        return { written: true }
      },
      interrupt: async (payload) => {
        const session = sessions.get(String(payload.key ?? ''))
        if (!session) throw new Error('no such terminal session')
        session.term.write('\x03')
        const delta = await settle(session)
        return { delta, text: session.buffer, dropped: session.dropped }
      },
      resize: async (payload) => {
        const session = sessions.get(String(payload.key ?? ''))
        if (!session) throw new Error('no such terminal session')
        session.term.resize(Math.max(20, payload.cols | 0), Math.max(5, payload.rows | 0))
        return { cols: session.term.cols, rows: session.term.rows }
      },
      close: async (payload) => {
        const key = String(payload.key ?? '')
        const session = sessions.get(key)
        if (!session) return { closed: false }
        sessions.delete(key)
        session.term.kill()
        return { closed: true }
      },
    }

    const dispose = registerRpc(ctx, async (endpoint, payload) => {
      const handler = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : undefined
      if (!handler) return failure('unknown_endpoint', `unknown endpoint: ${endpoint}`)
      const started = Date.now()
      const logTiming = !['read', 'write', 'resize'].includes(endpoint)
      if (logTiming) ctx.logger.info(`[JOB:terminal-rpc] ${endpoint} started`)
      try {
        const value = await handler(payload ?? {})
        if (logTiming) ctx.logger.info(`[JOB:terminal-rpc] ${endpoint} completed in ${Date.now() - started}ms`)
        return { ok: true, value }
      } catch (error) {
        ctx.logger.warn(`[JOB:terminal-rpc] ${endpoint} failed in ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`)
        return failure('terminal_failed', error instanceof Error ? error.message : String(error))
      }
    })

    return () => {
      for (const session of sessions.values()) session.term.kill()
      sessions.clear()
      void dispose()
    }
  }, 'terminal-pane: rpc')
}

/** Services required before the plugin body runs. */
export const inject = ['connection', 'webServer']

export default apply

apply.inject = inject
