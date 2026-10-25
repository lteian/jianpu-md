import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compile, locateNotes, applyNoteEdits, serializeToken, setSlur,
  parseNoteToken, parseMusicLine, tokenize,
} from '../dist/index.js';

const SRC = `---
title: 编辑测试
key: 1=D
time: 2/4
---
| 5 6// 1' 2- | (3 5) 6 1' | 0 5 5 6//
`;

/** 取第 6 行（0 基）即那条乐谱行 */
const L = (s) => s.split('\n')[5];

test('serializeToken 与 parseNoteToken 互逆（含升降/八度/时值/附点/标记）', () => {
  for (const t of ['5', '6/', '1\'', '2-', '#4', 'b7', '0', 'x', '5.', '5/..', '6@la', '3.@2', '5,,']) {
    const n = parseNoteToken(t, 1);
    const back = serializeToken(n);
    const n2 = parseNoteToken(back, 1);
    const strip = (x) => ({ ...x, idx: 0, line: 0, col: 0 });
    assert.deepEqual(strip(n2), strip(n), `${t} -> ${back}`);
  }
});

test('locateNotes：idx 与 parse 一致，且能定位到 token 下标', () => {
  const spans = locateNotes(SRC);
  assert.equal(spans.size, 12);
  // 0..3 在第一小节，4..7 在第二小节，8..11 在第三小节
  assert.equal(serializeToken(spans.get(0).note), '5');
  assert.equal(serializeToken(spans.get(3).note), '2-');
  assert.equal(serializeToken(spans.get(4).note), '3');   // 圆滑线内的音
  assert.equal(spans.get(4).line, 6);                     // 1 基行号
  // 与 compile 出来的 note.idx 完全对齐
  const { doc } = compile(SRC);
  const music = doc.items.filter((it) => it.kind === 'music');
  const idxs = music.flatMap((it) => it.measures.flatMap((m) => m.notes.map((n) => n.idx)));
  assert.deepEqual([...spans.keys()].sort((a, b) => a - b), idxs.slice().sort((a, b) => a - b));
});

test('改音高 / 时值 / 八度 / 增时线', () => {
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 0, op: { kind: 'digit', digit: 1 } }])),
    "| 1 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 6// -> 6（十六分改回四分）
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 1, op: { kind: 'slash', delta: -2 } }])),
    "| 5 6 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 八度 +1
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 2, op: { kind: 'oct', delta: 1 } }])),
    "| 5 6// 1'' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 增时线 +1（2- -> 2--）
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 3, op: { kind: 'dashes', delta: 1 } }])),
    "| 5 6// 1' 2-- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 附点
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 0, op: { kind: 'dots', delta: 1 } }])),
    "| 5. 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 升降号
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 0, op: { kind: 'acc', acc: 1 } }])),
    "| #5 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
});

test('删音 / 插音 / 一次改多个音', () => {
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 0, op: { kind: 'delete' } }])),
    "| 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  assert.equal(L(applyNoteEdits(SRC, [{ idx: 0, op: { kind: 'insertAfter', digit: 3 } }])),
    "| 5 3 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
  // 同行两处：后面的改动不能把前面的下标顶偏
  assert.equal(L(applyNoteEdits(SRC, [
    { idx: 0, op: { kind: 'digit', digit: 1 } },
    { idx: 5, op: { kind: 'digit', digit: 7 } },
  ])), "| 1 6// 1' 2- | ( 3 7 ) 6 1' | 0 5 5 6//");
  // 同一音多个操作叠加（先降八度加附点）
  assert.equal(L(applyNoteEdits(SRC, [
    { idx: 0, op: { kind: 'oct', delta: -1 } },
    { idx: 0, op: { kind: 'dots', delta: 1 } },
  ])), "| 5,. 6// 1' 2- | ( 3 5 ) 6 1' | 0 5 5 6//");
});

test('setSlur：加/去连弓，且幂等', () => {
  const on = setSlur(SRC, 6, 7, true);
  assert.equal(L(on), "| 5 6// 1' 2- | ( 3 5 ) ( 6 1' ) | 0 5 5 6//");
  assert.equal(L(setSlur(on, 6, 7, true)), L(on), '重复加连弓不该嵌套');
  // 改过的行会按规范间距重排（(3 5) → ( 3 5 )），语义等价即可
  assert.deepEqual(tokenize(L(setSlur(on, 6, 7, false))), tokenize(L(SRC)), '去掉后应回到原状');
  // 去掉已有的连弓（选中圆滑线内的音）
  assert.equal(L(setSlur(SRC, 4, 5, false)), "| 5 6// 1' 2- | 3 5 6 1' | 0 5 5 6//");
  // 跨过已有连弓向外扩
  assert.equal(L(setSlur(SRC, 4, 6, true)), "| 5 6// 1' 2- | ( 3 5 6 ) 1' | 0 5 5 6//");
  // 不同行不加
  assert.equal(setSlur(SRC, 0, 11, true).split('\n').length, SRC.split('\n').length);
});

test('编辑结果仍可编译，且不影响其它行', () => {
  const out = applyNoteEdits(SRC, [
    { idx: 2, op: { kind: 'oct', delta: -1 } },
    { idx: 0, op: { kind: 'insertAfter', digit: 3 } },
  ]);
  const r = compile(out);
  assert.equal(r.layout.pages.length, 1);
  // 头几行原样
  assert.deepEqual(out.split('\n').slice(0, 5), SRC.split('\n').slice(0, 5));
  const n = r.doc.items.filter((it) => it.kind === 'music')
    .flatMap((it) => it.measures.flatMap((m) => m.notes)).length;
  assert.equal(n, 13);
});

test('整曲示例（原创示范曲）：定位、编辑、再编译都不炸', () => {
  const full = readFileSync(new URL('../examples/原创示范曲.md', import.meta.url), 'utf8');
  const spans = locateNotes(full);
  const before = compile(full);
  const total = before.doc.items.filter((it) => it.kind === 'music')
    .flatMap((it) => it.measures.flatMap((m) => m.notes)).length;
  assert.equal(spans.size, total);
  assert.equal(before.layout.pages.length, 1);

  const out = applyNoteEdits(full, [
    { idx: 0, op: { kind: 'oct', delta: 1 } },
    { idx: 5, op: { kind: 'insertAfter', digit: 3 } },
  ]);
  const after = compile(out);
  assert.equal(after.layout.pages.length, 1);
  // 插音会让该小节多一拍，报出新的拍数告警是正常的，但不能多到离谱
  assert.ok(after.warnings.length - before.warnings.length <= 2,
    `告警从 ${before.warnings.length} 涨到 ${after.warnings.length}`);
  // 只改动被编辑到的那几行，其余原文一字不动
  const a = full.split('\n'), b = out.split('\n');
  assert.equal(a.length, b.length);
  const touched = new Set([spans.get(0).line, spans.get(5).line]).size;
  assert.equal(a.filter((x, i) => x !== b[i]).length, touched);
});
