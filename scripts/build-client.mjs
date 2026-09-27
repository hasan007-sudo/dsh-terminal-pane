import { build } from 'esbuild'

await build({
  entryPoints: ['src/client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['react'],
  loader: { '.css': 'text' },
  minify: true,
  legalComments: 'inline',
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-terminal-pane", factory(require) { const module = { exports: {} };' },
  footer: { js: 'return module.exports.default; } });' },
})
