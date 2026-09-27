# dsh-terminal-pane

An inline terminal panel docked under the composer of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI — a real PTY running on the machine that hosts the harness, driven from the browser tab.

> ⚠️ **Read the security section before you install this on a shared or remotely reachable host.**

## What it does

- Adds a collapsible **Terminal** panel directly under the message composer, so the shell sits in the same surface as the conversation instead of in a separate app.
- Backs the panel with a genuine PTY (`node-pty`) spawned by the plugin — full TTY behaviour: colours, `vim`, `top`, job control, `Ctrl+C`.
- Sessions are **persistent across commands**: `cd`, exported variables, and background processes survive between inputs, exactly like a normal terminal.
- The shell is **lazy**: nothing spawns until you first expand the panel.
- Rendering is line-oriented over the harness RPC channel, so the plugin needs no browser terminal emulator and adds no large client dependency.

```
┌──────────────────────────────────────────┐
│  conversation                           │
│                                          │
├──────────────────────────────────────────┤
│  [model selector]            [send]      │
├──────────────────────────────────────────┤
│  ▾ Terminal                              │  ← this plugin
│  ┌────────────────────────────────────┐  │
│  │ $ pwd                              │  │
│  │ /Users/you/project                 │  │
│  │ $ ▌                               │  │
│  └────────────────────────────────────┘  │
│  $ [ type a command            ready ]   │
└──────────────────────────────────────────┘
```

## Security

This plugin gives a browser tab a shell. Treat it as equivalent to handing someone a terminal on the host.

- **The shell runs as the user that runs the harness process**, with that user's full privileges. The plugin does **not** apply the harness sandbox policy that wraps agent `bash` tool calls.
- **The only access control is whatever protects the web GUI itself.** By default `dsh web` binds `127.0.0.1`, so the pane is reachable only from the host's own browser. If you bind the GUI to a network interface, or expose it through a proxy, VPN, or tunnel, then anyone who can reach that URL and authenticate can use this shell.
- **The browser session cookie becomes a shell credential.** Stealing it is materially worse with this plugin installed than without.
- Prefer loopback. If you must reach a remote host, use a private overlay network (Tailscale, WireGuard) rather than a public funnel, and keep the launch token out of shared channels and shell history.

Do not install this on a host whose browser session is reachable by untrusted parties, and do not enable it in a container that mounts sensitive host paths unless you intend exactly that.

## Install

From the DSH **Plugins** page: click **Add plugin**, enter `dsh-terminal-pane`, install, then enable it.

Or from the command line:

```sh
dsh plugin --profile web add dsh-terminal-pane
```

Restart `dsh web` afterwards. The panel appears under the composer on every conversation.

To uninstall:

```sh
dsh plugin --profile web remove dsh-terminal-pane
```

## Configuration

Add an entry to your profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: terminal-pane
  name: dsh-terminal-pane
  config:
    shell: /bin/zsh
    cwd: /Users/you/code
    scrollbackLimit: 400000
```

| Field | Default | Meaning |
|---|---|---|
| `shell` | `$SHELL` on POSIX, `%COMSPEC%` on Windows | Shell executable to spawn. Spawned as a login shell (`-l` on POSIX). |
| `cwd` | harness process working directory | Initial working directory of every panel. |
| `scrollbackLimit` | `200000` | Retained scrollback ceiling, in characters. Older output is dropped from the top. |

Your profile must use `patchReload: live` (the default for shipped profiles) for config edits to apply without a restart.

## Troubleshooting

### The panel opens but every command fails with a spawn error

You will see an empty panel and a status like `posix_spawnp failed.` or the pane never leaves "starting shell…".

`node-pty` ships a small native helper binary (`spawn-helper`) that must be marked executable. **npm 11+ and pnpm 10+ block dependency install scripts by default**, so that step is skipped and every shell spawn fails.

Approve the package's install script and rebuild:

```sh
# npm
npm install-scripts approve node-pty
npm rebuild node-pty

# pnpm
pnpm approve-builds        # select node-pty in the prompt
pnpm rebuild node-pty
```

If your package manager offers no approval command, the equivalent fix is to make the helper executable yourself:

```sh
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
```

Verify with `ls -l node_modules/node-pty/prebuilds/*/spawn-helper` — the mode must start with `rwx`, not `rw-`.

### Colours or escape codes render as raw text

Expected. The pane is line-oriented and does not implement escape-sequence rendering. Use it for running commands, not for TUI programs.

## Behaviour and limitations

- **Line-oriented, not a full terminal emulator.** The pane is accurate for ordinary shell use, but it does not implement escape-sequence rendering: colours arrive as raw ANSI codes, full-screen programs (`vim`, `less`, `top`) will not draw correctly. Use it for running commands, not for TUI work.
- **Settling is time-based.** A command's output is considered finished after 250 ms of silence, or 15 s maximum. A long-running foreground command returns control to the panel while it keeps running; press Enter for a fresh prompt or use **Ctrl+C** to interrupt.
- **Sessions are process-local.** They do not survive a harness restart, and at most 8 panels are held at once — opening a ninth evicts the oldest.
- **One shell per browser panel.** Reloading the page closes the panel's shell.

## How it works

The package ships both halves of a DSH plugin:

- `lib/index.js` — host half. Registers an RPC channel on the Connection carrier (`ctx.connection.rpc.handle`) with `open`, `send`, `read`, `interrupt`, `resize`, and `close` endpoints, and owns every PTY it spawns. All PTYs are killed when the plugin unloads.
- `lib/client.js` — browser half. Declared through `dsh.client` in `package.json`, served as a plugin bundle, and registered into the `conversation.composer.dock` slot.

It deliberately does **not** use the harness `ctx.terminals` service: that service is owner-scoped to registered agents, and each operation requires an `Agent` owner, so a human-driven browser panel has nothing to present. Owning the PTY directly keeps the plugin self-contained and avoids creating a throwaway session per panel.

## Development

```sh
npm install
npm run check        # node --check on both halves
```

Both halves are hand-authored ESM-compatible sources — there is no build step. The client half is emitted directly in the `window.__ModuleLoader__` bundle format the DSH shell loads, and takes React from the shell's frozen module table.

## License

MIT
