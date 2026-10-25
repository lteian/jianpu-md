/**
 * 打包 Obsidian 插件：
 *   dist-plugin/jianpu-md/{main.js, manifest.json, styles.css}   ← 直接拷进 vault 的 .obsidian/plugins/
 *   dist-plugin/jianpu-md.zip                                     ← 社区插件标准包
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 上不能直接用 new URL(..).pathname（会解析出 C:\C:\ 这种双前缀）
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'dist-plugin');
const pkgDir = path.join(outDir, 'jianpu-md');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });

for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  const src = path.join(root, 'plugin', f);
  if (!fs.existsSync(src)) {
    console.error(`缺少 ${f}，先跑 npm run plugin`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(pkgDir, f));
}

// zip：用系统的 python3（标准库 zipfile），不引第三方依赖
try {
  execFileSync('python3', [
    '-c',
    `import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'jianpu-md')`,
    path.join(outDir, 'jianpu-md'),
    outDir,
  ]);
  console.log('→ dist-plugin/jianpu-md.zip');
} catch (e) {
  console.warn('（没打成 zip，文件夹已经备好了：' + pkgDir + '）');
}

const size = (fs.statSync(path.join(pkgDir, 'main.js')).size / 1024).toFixed(1);
console.log(`→ ${pkgDir}（main.js ${size} KB）`);
