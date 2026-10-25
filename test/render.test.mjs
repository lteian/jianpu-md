import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, parseNoteToken, applyNoteEdits, locateNotes } from '../dist/index.js';

const SRC = (body, extra = '') => `---
title: 测试
key: 1=D
time: 2/4
${extra}---
${body}
`;

/** 取出某个音（按 data-idx）的 <g>…</g> */
function noteGroup(svg, idx) {
  const re = new RegExp(`<g class="note[^"]*" data-idx="${idx}">[\\s\\S]*?</g>`);
  const m = svg.match(re);
  return m ? m[0] : '';
}

const circles = (frag) => [...frag.matchAll(/<circle[^>]*>/g)].map((m) => m[0]);

test('八度点：高音点画在字上方，低音点在字下方', () => {
  const svg = compile(SRC("| 1' 2, |")).svg;
  const g0 = noteGroup(svg, 0);
  const g1 = noteGroup(svg, 1);
  // 基线 y（数字的 y 属性）
  const y0 = +g0.match(/<text[^>]*y="([\d.]+)"/)[1];
  const c0 = circles(g0);
  assert.equal(c0.length, 1, "1' 应有一个高音点");
  const cy0 = +c0[0].match(/cy="([\d.]+)"/)[1];
  assert.ok(cy0 < y0 - 8, `高音点应在字上方，cy=${cy0} 基线=${y0}`);

  const y1 = +g1.match(/<text[^>]*y="([\d.]+)"/)[1];
  const c1 = circles(g1);
  assert.equal(c1.length, 1, '2, 应有一个低音点');
  const cy1 = +c1[0].match(/cy="([\d.]+)"/)[1];
  assert.ok(cy1 > y1 + 5, `低音点应在字下方，cy=${cy1} 基线=${y1}`);
});

test('八度点：几个点就是几个圈', () => {
  for (const [tok, n] of [["1'''", 3], ['1,,', 2], ['1', 0]]) {
    const svg = compile(SRC(`| ${tok} |`)).svg;
    const c = circles(noteGroup(svg, 0));
    assert.equal(c.length, n, `${tok} 应有 ${n} 个八度点，实际 ${c.length}`);
  }
});

test('低音点要让开减时线', () => {
  // 2,// 有两条减时线（y+7 / y+11.6），低音点必须在最下面那条之下
  const svg = compile(SRC('| 2,// 5,/ |')).svg;
  const g = noteGroup(svg, 0);
  const y = +g.match(/<text[^>]*y="([\d.]+)"/)[1];
  const cy = +circles(g)[0].match(/cy="([\d.]+)"/)[1];
  assert.ok(cy > y + 11.6 + 1.9, `低音点 cy=${cy} 应低于第二条减时线（y+11.6）`);
});

test('弓法记号画成矢量，不依赖字体', () => {
  const svg = compile(SRC('| 5@la 6@tui |')).svg;
  const la = noteGroup(svg, 0);
  const tui = noteGroup(svg, 1);
  assert.match(la, /class="mark mark-la"/);
  assert.match(la, /<path d="M[^"]*V[^"]*H[^"]*V/, '拉弓应是 ∏ 形折线');
  assert.match(tui, /class="mark mark-tui"/);
  assert.match(tui, /<path d="M[^"]*L[^"]*L/, '推弓应是 ∨ 形折线');
  // 不能再出现依赖字体的 ㄇ / ∨ 文本
  assert.doesNotMatch(svg, /mark-la"[^>]*>ㄇ</);
  assert.doesNotMatch(svg, /mark-tui"[^>]*>∨</);
});

test('弓法记号大小跟音符相称（不是一颗斑点）', () => {
  const svg = compile(SRC('| 5@la 6@tui |')).svg;
  // 拉弓：M x1 y1 V y2 H x2 V y1
  const la = noteGroup(svg, 0).match(/d="M([\d.]+) ([\d.]+)V([\d.]+)H([\d.]+)V([\d.]+)"/);
  // 推弓：M x1 y1 L x2 y2 L x3 y1
  const tui = noteGroup(svg, 1).match(/d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"/);
  assert.ok(la && tui, '弓法路径结构不对');
  const w1 = Math.abs(+la[4] - +la[1]), h1 = Math.abs(+la[3] - +la[2]);
  const w2 = Math.abs(+tui[5] - +tui[1]), h2 = Math.abs(+tui[4] - +tui[2]);   // 第 4 组是 V 的尖端 y
  for (const [name, w, h] of [['la', w1, h1], ['tui', w2, h2]]) {
    assert.ok(h >= 18.7 * 0.45, `${name} 高 ${h.toFixed(1)} 太小`);
    assert.ok(w / h > 0.8 && w / h < 1.8, `${name} 宽高比 ${(w / h).toFixed(2)} 不是方形`);
  }
});

test('附点与八度点同时存在时互不干扰', () => {
  const svg = compile(SRC("| 5'. |")).svg;
  const g = noteGroup(svg, 0);
  const cs = circles(g);
  assert.equal(cs.length, 2, '一个八度点 + 一个附点');
  const ys = cs.map((c) => +c.match(/cy="([\d.]+)"/)[1]);
  const xs = cs.map((c) => +c.match(/cx="([\d.]+)"/)[1]);
  assert.equal(new Set(ys.map((v) => Math.round(v))).size, 2, '两个点的 y 不同');
  assert.ok(Math.abs(xs[0] - xs[1]) > 2, '附点在音符右侧，不与八度点重叠');
});

test('工具条的 mark 操作：加弓法 / 再点取消', () => {
  const src = SRC('| 5 6 |');
  const spans = locateNotes(src);
  const added = applyNoteEdits(src, [{ idx: 0, op: { kind: 'mark', mark: 'la' } }]);
  assert.match(added, /\| 5@la 6 \|/);
  // 再点一次（on 缺省 = 切换）应去掉
  const spans2 = locateNotes(added);
  assert.equal(spans2.get(0).note.marks.length, 1);
  const removed = applyNoteEdits(added, [{ idx: 0, op: { kind: 'mark', mark: 'la' } }]);
  assert.match(removed, /\| 5 6 \|/);
  // 显式 on:true 幂等
  const twice = applyNoteEdits(added, [{ idx: 0, op: { kind: 'mark', mark: 'la', on: true } }]);
  assert.equal(twice, added);
  assert.ok(spans.size === 2);
});

/* ---------------------------------------------------- 指法 / 弦位（小字记号） */

/** 一个音上所有 text.mark 的 [记号名, 字, 字号] */
function marksOf(svg, idx) {
  const g = noteGroup(svg, idx);
  return [...g.matchAll(/<text class="mark mark-([^"]+)"[^>]*font-size="([\d.]+)">([^<]*)</g)]
    .map((m) => [m[1], m[3], +m[2]]);
}

test('空弦记作「宀」，不是数字 0', () => {
  const m = marksOf(compile(SRC('| 5@0 6 |')).svg, 0);
  assert.equal(m.length, 1);
  assert.equal(m[0][0], '0', '记号名仍是 0（源码写法 @0 不变）');
  assert.equal(m[0][1], '宀', '显示字必须是宀');
});

test('指法一二三四：小字（比弓法记号还小一号）', () => {
  const svg = compile(SRC('| 1@1 2@2 3@3 4@4 |')).svg;
  const want = ['一', '二', '三', '四'];
  want.forEach((ch, i) => {
    const m = marksOf(svg, i);
    assert.equal(m.length, 1);
    assert.equal(m[0][1], ch, `第 ${i + 1} 个音应显示 ${ch}`);
    assert.equal(m[0][2], 12, '指法是 12px 小字');
  });
});

test('弦位（内/外）优先于指法：两个都标时只显示弦位', () => {
  const svg = compile(SRC('| 5@0@nei 6@1@wai |')).svg;
  const a = marksOf(svg, 0);
  const b = marksOf(svg, 1);
  assert.deepEqual(a.map((x) => x[1]), ['内'], '标了内弦就不显示空弦宀');
  assert.deepEqual(b.map((x) => x[1]), ['外'], '标了外弦就不显示一指');
});

test('同组互斥：手写多个指法/弦位只认最后一个', () => {
  const svg = compile(SRC('| 1@1@2@3 2@nei@wai 3@nei@2 |')).svg;
  assert.deepEqual(marksOf(svg, 0).map((x) => x[1]), ['三']);
  assert.deepEqual(marksOf(svg, 1).map((x) => x[1]), ['外']);
  // 弦位优先的过滤发生在互斥之后：结果只剩外弦
  assert.deepEqual(marksOf(svg, 2).map((x) => x[1]), ['内']);
});

test('点「二指」会顶掉「一指」，不会叠成两行', () => {
  const src = SRC('| 5 6 |');
  const one = applyNoteEdits(src, [{ idx: 0, op: { kind: 'mark', mark: '1' } }]);
  assert.match(one, /\| 5@1 6 \|/);
  const two = applyNoteEdits(one, [{ idx: 0, op: { kind: 'mark', mark: '2' } }]);
  assert.match(two, /\| 5@2 6 \|/, '应替换而不是追加');
  // 内弦与外弦同理
  const nei = applyNoteEdits(src, [{ idx: 0, op: { kind: 'mark', mark: 'nei' } }]);
  const wai = applyNoteEdits(nei, [{ idx: 0, op: { kind: 'mark', mark: 'wai' } }]);
  assert.match(wai, /\| 5@wai 6 \|/);
  // 指法和弦位不属于同一组，可以共存（渲染时才按优先级取舍）
  const both = applyNoteEdits(one, [{ idx: 0, op: { kind: 'mark', mark: 'nei' } }]);
  assert.match(both, /5@1@nei/);
});
