/**
 * 打包 Obsidian 插件：src/ 的渲染器直接打进 main.js，插件离线可用。
 *   node plugin/esbuild.config.mjs            → 开发版（带 sourcemap）
 *   node plugin/esbuild.config.mjs --production → 发布版
 */
import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv.includes('--production');

/** Obsidian 运行时提供的模块，不能打进包里 */
const external = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
];

const banner = `/*
 * jianpu-md Obsidian 插件
 * 渲染器来自 jianpu-md（MIT）：https://github.com/lteian/jianpu-md
 */`;

/** 浏览器预览版（不含 obsidian 依赖） */
async function buildPreview() {
  await esbuild.build({
    entryPoints: ['plugin/preview.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: 'plugin/preview.js',
    logLevel: 'info',
  });
  console.log('→ plugin/preview.js');
}

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['plugin/main.ts'],
  bundle: true,
  external,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
  logLevel: 'info',
  outfile: 'plugin/main.js',
});

await buildPreview();

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('→ plugin/main.js（发布版）');
} else {
  await ctx.watch();
}
