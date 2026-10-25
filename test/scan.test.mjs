import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLineNotes, parse } from '../dist/index.js';

/** 用 parse 走一遍，返回这一行的音（数量必须和扫描一致） */
function parsedNotes(line) {
  const doc = parse(`---\nkey: 1=D\ntime: 2/4\n---\n\n${line}\n`);
  return doc.items.filter((i) => i.kind === 'music').flatMap((i) => i.measures).flatMap((m) => m.notes);
}

test('scanLineNotes：音的数量和 parse 一致', () => {
  const lines = [
    "| 1 2 3 4 |",
    "| 1'/@la ( 1'// 2'// ) 1'/ ( 6// 5// ) |",
    "| b7// 1'// 3.. 5@> |",
    "| 12 34 |",
    "| 5 \"文字 空格\" 6 |",
    "| 1' 2, 3// 4- 5. 6@nei |",
    "| 1 2/4 3 |",          // 行内拍号不算音
    "| 5 x 6 |",            // x 是节奏音符，也是音
  ];
  for (const l of lines) {
    const sc = scanLineNotes(l);
    const ps = parsedNotes(l);
    assert.equal(sc.length, ps.length, `「${l}」扫描 ${sc.length} 个，解析 ${ps.length} 个`);
  }
});

test('scanLineNotes：位置指回原文，能量出切出来的字面', () => {
  const line = "| 1'/@la 2, 3// |";
  for (const sp of scanLineNotes(line)) {
    assert.equal(line.slice(sp.start, sp.end), sp.text, '切出来的字面必须和原文一致');
  }
});

test('scanLineNotes：行内拍号和引号文字都跳过去', () => {
  assert.deepEqual(scanLineNotes('| 1 2/4 3 |').map((s) => s.text), ['1', '3']);
  assert.deepEqual(scanLineNotes('| 5 "a b" 6 |').map((s) => s.text), ['5', '6']);
  assert.deepEqual(scanLineNotes('| 1 2 3 |').map((s) => s.text), ['1', '2', '3']);
});

test('scanLineNotes：八度点、增时线、减时线、附点、记号都算在一个音里', () => {
  assert.deepEqual(scanLineNotes('| 1\' 2, 3// 4- 5. 6@nei |').map((s) => s.text),
    ["1'", '2,', '3//', '4-', '5.', '6@nei']);
});
