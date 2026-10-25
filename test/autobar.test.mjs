import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoBarLine, rebarLines, setMeta, compile } from '../dist/index.js';

test('自动分节：满一小节就落一条线', () => {
  assert.equal(autoBarLine('1 2 3 4', 2), '| 1 2 | 3 4 |');
  assert.equal(autoBarLine('1 2 3', 2), '| 1 2 | 3 |');
  assert.equal(autoBarLine('1 2 3 4 5 6', 2), '| 1 2 | 3 4 | 5 6 |');
});

test('自动分节：已有的普通小节线被重算', () => {
  // 用户原来划歪了（第二小节只有一拍），改完时值后按拍数纠正
  assert.equal(autoBarLine('| 1 2 | 3 |', 2), '| 1 2 | 3 |');
  assert.equal(autoBarLine('| 1 2 3 | 4 |', 2), '| 1 2 | 3 4 |');
});

test('自动分节：八分音符两个算一拍', () => {
  assert.equal(autoBarLine('1/ 2/ 3/ 4/', 2), '| 1/ 2/ 3/ 4/ |');
  assert.equal(autoBarLine('1/ 2/ 3/ 4/ 5/ 6/', 2), '| 1/ 2/ 3/ 4/ | 5/ 6/ |');
});

test('自动分节：增时线按拍数算', () => {
  // 1- 是 2 拍，正好一小节
  assert.equal(autoBarLine('1- 2', 2), '| 1- | 2 |');
  assert.equal(autoBarLine('1 - 2', 2), '| 1- | 2 |');
});

test('自动分节：反复记号带语义，原样保留', () => {
  assert.equal(autoBarLine('|: 1 2 :|', 2), '|: 1 2 :|');
  assert.equal(autoBarLine('1 2 3 4 ||', 2), '| 1 2 | 3 4 ||');
  assert.equal(autoBarLine('1 2 |]', 2), '| 1 2 |]');
});

test('自动分节：行内拍号优先', () => {
  assert.equal(autoBarLine('3/4 1 2 3', 4), '3/4 | 1 2 3 |');
});

test('自动分节：休止符和连音括号也参与', () => {
  assert.equal(autoBarLine('0 0', 2), '| 0 0 |');
  assert.equal(autoBarLine('( 1 2 ) 3 4', 2), '| ( 1 2 ) | 3 4 |');
});

test('自动分节：文字行、空行不动', () => {
  assert.equal(autoBarLine('', 2), '');
  assert.equal(autoBarLine('## 八度点', 2), '## 八度点');
  assert.equal(autoBarLine('L: 一闪一闪亮晶晶', 2), 'L: 一闪一闪亮晶晶');
});

test('自动分节：已经规范的行原样返回（不无谓改写）', () => {
  const ok = '| 1 2 | 3 4 |';
  assert.equal(autoBarLine(ok, 2), ok);
});

test('rebarLines：只动指定的行', () => {
  const src = '---\ntime: 2/4\n---\n| 1 2 3 4 |\n| 5 6 7 1 |';
  const out = rebarLines(src, [4], 2);
  assert.equal(out.split('\n')[3], '| 1 2 | 3 4 |');
  assert.equal(out.split('\n')[4], '| 5 6 7 1 |');   // 没点名的行一个字都不动
});

test('rebarLines 出来的谱能正常编译、零告警', () => {
  const src = rebarLines('---\ntime: 2/4\n---\n1 2 3 4 5 6 7 1', [4], 2);
  const r = compile(src);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.doc.items.filter((i) => i.kind === 'music').length, 1);
});

test('setMeta：改已有字段 / 插入新字段 / 无 frontmatter 时新建', () => {
  assert.equal(setMeta('---\ntempo: 88\n---\n| 1 |', 'tempo', '120'), '---\ntempo: 120\n---\n| 1 |');
  assert.equal(setMeta('---\ntitle: x\n---\n| 1 |', 'tempo', '66'), '---\ntitle: x\ntempo: 66\n---\n| 1 |');
  assert.equal(setMeta('| 1 |', 'tempo', '72'), '---\ntempo: 72\n---\n| 1 |');
});
