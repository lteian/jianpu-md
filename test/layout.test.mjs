import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse } from '../dist/index.js';

const SRC = (body, extra = '') => `---
title: 测试
key: 1=D
time: 2/4
${extra}---

${body}
`;

/* --------------------------------------------------- 多小节休止（R18） */

test('R18：占一行版面，但吃掉 18 个小节号', () => {
  const doc = parse(SRC('| 1 2 | 3 4 |\n\nR18\n\n| 5 6 |'));
  const nos = doc.items.filter((i) => i.kind === 'music').flatMap((i) => i.measures.map((m) => m.no));
  assert.deepEqual(nos, [1, 2, 3, 21], `小节号应跳 18：${nos.join(',')}`);
});

test('R18：不报空小节、不报拍数', () => {
  const r = compile(SRC('| 1 2 | 3 4 |\n\nR18\n\n| 5 6 |'));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings.map((w) => w.message)));
});

test('R8 / 休止8 / 休止 8 小节 都认', () => {
  for (const line of ['R8', 'r8', '休止8', '休止 8 小节', 'R 8 bars']) {
    const doc = parse(SRC(`| 1 2 |\n\n${line}\n\n| 3 4 |`));
    const nos = doc.items.filter((i) => i.kind === 'music').flatMap((i) => i.measures.map((m) => m.no));
    // 1 小节已用，休止 8 从第 2 小节起 → 下一个是 10
    assert.deepEqual(nos, [1, 2, 10], `「${line}」应吃掉 8 小节，实际 ${nos.join(',')}`);
  }
});

test('R18 渲染成横线 + 「休止 18 小节」，独立成行', () => {
  const r = compile(SRC('| 1 2 | 3 4 |\n\nR18\n\n| 5 6 | 7 1 |'));
  assert.match(r.svg, /<g class="system rest" data-y="[\d.]+" data-rest="18">/);
  assert.match(r.svg, /休止 18 小节/);
  const restRows = r.layout.pages.flatMap((p) => p.systems).filter((s) => s.rest);
  assert.equal(restRows.length, 1);
});

test('R1 也能用（一行休止，等价于一个空小节但不出告警）', () => {
  const r = compile(SRC('| 1 2 |\n\nR1\n\n| 3 4 |'));
  assert.equal(r.warnings.length, 0);
  const nos = r.doc.items.filter((i) => i.kind === 'music').flatMap((i) => i.measures.map((m) => m.no));
  assert.deepEqual(nos, [1, 2, 3]);
});

/* ------------------------------------------------------ 行距（spacing） */

const gapOf = (src) => compile(src).layout.pages[0].systems.map((s) => s.height);

test('spacing: 1 是默认行高 76/96', () => {
  const h = gapOf(SRC('| 1 2 |\n| 3 4 |'));
  assert.ok(h.every((v) => Math.abs(v - 76) < 0.01), JSON.stringify(h));
});

test('spacing 调小 → 行高压下来，但不会压过硬底', () => {
  const a = gapOf(SRC('| 1 2 |\n| 3 4 |', 'spacing: 0.93\n'))[0];
  const b = gapOf(SRC('| 1 2 |\n| 3 4 |', 'spacing: 0.85\n'))[0];
  const c = gapOf(SRC('| 1 2 |\n| 3 4 |', 'spacing: 0.50\n'))[0];
  assert.ok(a < 76 && a > 70, `0.93 → ${a}`);
  assert.ok(b < a, `0.85 应比 0.93 更紧：${b} vs ${a}`);
  assert.ok(Math.abs(c - 67) < 0.01, `压到 0.50 也只到硬底 67，实际 ${c}`);
});

test('spacing 调大 → 行高变大（想疏一点留白）', () => {
  const h = gapOf(SRC('| 1 2 |\n| 3 4 |', 'spacing: 1.3\n'))[0];
  assert.ok(Math.abs(h - 76 * 1.3) < 0.01, `1.3 → ${h}`);
});

test('spacing 压到极限能把多出来的一行救回一页', () => {
  // 不带标题，可用高度 = 1123-50-64 = 1009
  // 14 行 × 76 = 1064 放不下；压到 93%（70.7/行 = 990）就回到一页
  const NO_TITLE = (extra) => `---\nkey: 1=D\ntime: 2/4\n${extra}---\n\n` +
    Array.from({ length: 14 }, () => '| 1 2 | 3 4 |').join('\n') + '\n';
  assert.equal(compile(NO_TITLE('')).layout.pages.length, 2, '默认行距 14 行应溢出到 2 页');
  assert.equal(compile(NO_TITLE('spacing: 1.0\n')).layout.pages.length, 2, '100% 仍放不下');
  assert.equal(compile(NO_TITLE('spacing: 0.93\n')).layout.pages.length, 1, '压到 93% 应回到 1 页');
});
