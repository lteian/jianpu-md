#!/usr/bin/env node
/**
 * jianpu CLI —— 把 .md / .txt 变成 .svg / .html
 *
 *   jianpu score.md                 → score.svg（单页）或 score-p1.svg…
 *   jianpu score.md -o out.svg
 *   jianpu score.md --html          → 附带一个可直接打印的 HTML
 *   jianpu score.md --check         → 只做校验，有问题退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { compile, VERSION } from '../dist/index.js';

function usage(code = 0) {
  const msg = `jianpu-md v${VERSION}

用法：
  jianpu <file.md|file.txt> [选项]

选项：
  -o, --out <path>   输出路径（.svg；多页时自动加 -p1/-p2）
      --html         同时生成可打印 HTML
      --check        只校验，不写文件
      --strict       拍数不符视为错误
      --quiet        不打印告警
      --paper <型>   覆盖纸型：A3 / A4 / A5 / B5 / Letter
      --orientation <方向>  竖版(portrait) 或 横版(landscape)
  -h, --help         显示帮助
`;
  process.stdout.write(msg);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(0);

let input = null;
let out = null;
let html = false;
let check = false;
let strict = false;
let quiet = false;
let paper = null;
let orientation = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') out = argv[++i];
  else if (a === '--html') html = true;
  else if (a === '--check') check = true;
  else if (a === '--strict') strict = true;
  else if (a === '--quiet') quiet = true;
  else if (a === '--paper') paper = argv[++i];
  else if (a === '--orientation' || a === '--landscape') orientation = a === '--landscape' ? 'landscape' : argv[++i];
  else if (!a.startsWith('-')) input = a;
  else { console.error(`未知选项：${a}`); usage(2); }
}
if (!input) usage(2);

const source = fs.readFileSync(input, 'utf8');
const { svg, warnings, doc, layout } = compile(source, { strictBeats: strict, paper, orientation });

const errors = warnings.filter(w => w.level === 'error');
const warns = warnings.filter(w => w.level === 'warn');
if (!quiet) {
  if (!warnings.length) console.log('✓ 校验通过，没有发现问题');
  for (const w of warnings) {
    const tag = w.level === 'error' ? '✗' : '⚠';
    console.log(`${tag} ${w.message}${w.line ? `（第 ${w.line} 行）` : ''}`);
  }
}
if (check) {
  console.log(`\n标题：${doc.meta.title || '(无)'}　调号：1=${doc.key.name}　拍号：${doc.time.num}/${doc.time.den}　速度：♩=${doc.tempo}　纸型：${layout.theme.width}×${layout.theme.height}（${layout.pages.length} 页）`);
  process.exit(errors.length ? 1 : 0);
}
if (errors.length) {
  console.error('\n存在错误，已中止输出');
  process.exit(1);
}

const base = out ? out.replace(/\.svg$/i, '') : input.replace(/\.(md|txt|jpm)$/i, '');
const pages = svg.split(/(?=<svg )/).filter(Boolean);

if (pages.length === 1) {
  fs.writeFileSync(`${base}.svg`, svg, 'utf8');
  console.log(`✓ ${path.basename(base)}.svg`);
} else {
  pages.forEach((p, i) => {
    fs.writeFileSync(`${base}-p${i + 1}.svg`, p, 'utf8');
    console.log(`✓ ${path.basename(base)}-p${i + 1}.svg`);
  });
}

if (html) {
  const file = `${base}.html`;
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${doc.meta.title || ''}</title>
<style>@page{size:${Math.round(layout.theme.width / (96 / 25.4))}mm ${Math.round(layout.theme.height / (96 / 25.4))}mm;margin:0}body{margin:0;background:#eaeaea}
svg{display:block;margin:12px auto;background:#fff;box-shadow:0 2px 10px #0003}
@media print{body{background:#fff}svg{margin:0;box-shadow:none}}</style>
${svg}`, 'utf8');
  console.log(`✓ ${path.basename(file)}`);
}

void warns;
