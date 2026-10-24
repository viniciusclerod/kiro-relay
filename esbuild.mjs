import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

// Icon font for the status panel webview (node_modules is not packaged).
fs.mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);
}

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'node:sqlite'],
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
