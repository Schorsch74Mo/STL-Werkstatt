// Baut alles zu EINER Datei (STL-Werkstatt.html), die man per Doppelklick im Browser öffnet.
import { build } from 'esbuild';
import fs from 'fs';

const r = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  loader: { '.wasm': 'binary' },
  define: { 'import.meta.url': 'location.href' },
  external: ['fs', 'path', 'module', 'url', 'worker_threads', 'node:*'],
  logLevel: 'warning',
});
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const html = fs.readFileSync('src/index.template.html', 'utf8').replace('__SCRIPT__', () => `<script>${js}</script>`);
fs.writeFileSync('STL-Werkstatt.html', html);
console.log('STL-Werkstatt.html', (html.length / 1e6).toFixed(2), 'MB');
