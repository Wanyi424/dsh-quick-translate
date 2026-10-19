import { build, transform } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
await mkdir('dist', { recursive: true });
// Stylesheets are authored readable and shipped minified as text injected by the page.
const cssText = { name: 'css-text', setup(plugin) {
  plugin.onLoad({ filter: /\.css$/ }, async args => ({ loader: 'text', contents: (await transform(await readFile(args.path, 'utf8'), { loader: 'css', minify: true, target: 'chrome130' })).code }));
} };
const host = await build({ entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true });
const clients = await Promise.all([['src/client.tsx', 'client.js'], ['src/page.tsx', 'client.page.js']].map(([entry, file]) => build({
  entryPoints: [entry], outfile: `lib/${file}`, bundle: true, platform: 'browser', target: 'chrome130', format: 'cjs', jsx: 'transform', minify: true, metafile: true,
  external: ['react', 'react/jsx-runtime', 'react-dom'], plugins: [cssText],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(file === 'client.js' ? 'dsh-translate' : 'dsh-translate/' + file)}, factory(require) { const module = { exports: {} }; const exports = module.exports;` },
  footer: { js: 'return module.exports; } });' }, define: { 'process.env.NODE_ENV': '"production"' },
})));
const roots = new Set();
for (const path of [host, ...clients].flatMap(result => Object.keys(result.metafile.inputs))) { const match = /^(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path); if (match) roots.add(match[1]); }
const notices = [];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const licenses = (await readdir(root)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  notices.push(`${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See upstream package'}\n${(await Promise.all(licenses.map(name => readFile(join(root, name), 'utf8')))).join('\n')}`);
}
await writeFile('lib/THIRD_PARTY_NOTICES.txt', notices.join('\n\n' + '='.repeat(72) + '\n\n'));
console.log('Built Host, lightweight Client entry and lazy translation page.');
