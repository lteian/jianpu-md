import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse, parseMusicLine, parseNoteToken, parseKey, parseTime, noteToMidi, buildTimeline, splitSyllables } from '../dist/index.js';

const SRC = `---
title: 测试
key: 1=C
time: 2/4
tempo: 120
---
| 1 1 | 5 5 | 6 6 | 5 - |
L: 一 闪 一 闪 亮 晶 晶
`;

test('parseNoteToken：音高/八度/时值/附点', () => {
  const a = parseNoteToken("1'");
  assert.equal(a.oct, 1);
  assert.equal(a.beats, 1);
  const b = parseNoteToken('5,');
  assert.equal(b.oct, -1);
  const c = parseNoteToken('1/');
  assert.equal(c.slash, 1);
  assert.equal(c.beats, 0.5);
  const d = parseNoteToken('1//');
  assert.equal(d.beats, 0.25);
  const e = parseNoteToken('1/.');
  assert.equal(e.beats, 0.75);
  const f = parseNoteToken('3-');
  assert.equal(f.beats, 2);
  const g = parseNoteToken('#4');
  assert.equal(g.acc, 1);
  const h = parseNoteToken('b3');
  assert.equal(h.acc, -1);
  const i = parseNoteToken('0');
  assert.equal(i.kind, 'rest');
});

test('调号与音高换算', () => {
  assert.equal(parseKey('1=C').semi, 0);
  assert.equal(parseKey('1=F').semi, 5);
  assert.equal(parseKey('1=bB').semi, 10);
  assert.equal(noteToMidi({ kind: 'note', digit: 1, acc: 0, oct: 0 }, 0), 60);
  assert.equal(noteToMidi({ kind: 'note', digit: 5, acc: 0, oct: 0 }, 2), 69); // 1=D 的 5 = A4（二胡外弦）
  assert.equal(noteToMidi({ kind: 'note', digit: 1, acc: 0, oct: 1 }, 0), 72);
});

test('拍号', () => {
  assert.equal(parseTime('2/4').beats, 2);
  assert.equal(parseTime('4/4').beats, 4);
  assert.equal(parseTime('6/8').beats, 3);
});

test('整篇：小节与歌词', () => {
  const { doc, warnings } = compile(SRC);
  const music = doc.items.filter(i => i.kind === 'music');
  assert.equal(music.length, 1);
  assert.equal(music[0].measures.length, 4);
  const notes = music[0].measures.flatMap(m => m.notes);
  assert.equal(notes.length, 7);          // 5 - 是一个音
  assert.equal(notes[6].beats, 2);
  assert.equal(notes[0].lyric, '一');
  assert.equal(notes[6].lyric, '晶');
  assert.deepEqual(warnings, []);
});

test('歌词无需空格的中文按字拆分', () => {
  assert.deepEqual(splitSyllables('一闪一闪'), ['一', '闪', '一', '闪']);
  assert.deepEqual(splitSyllables('一 闪 一 闪'), ['一', '闪', '一', '闪']);
});

test('拍数不符会告警', () => {
  const { warnings } = compile('---\ntime: 2/4\n---\n| 1 1 1 | 2 2 |\n');
  assert.ok(warnings.some(w => w.message.includes('拍数')));
});

test('三连音按 2/3 缩放', () => {
  const { doc, warnings } = compile('---\ntime: 2/4\n---\n| 3[1 2 3] | 5 - |\n');
  const notes = doc.items.find(i => i.kind === 'music').measures[0].notes;
  assert.equal(notes.length, 3);
  assert.ok(Math.abs(notes[0].beats - 2 / 3) < 1e-9);
  assert.deepEqual(warnings, []);
});

test('倚音挂在后面的音符上', () => {
  const { doc } = compile('---\ntime: 2/4\n---\n| ^{2 3} 1 1 | 2 - |\n');
  const notes = doc.items.find(i => i.kind === 'music').measures[0].notes;
  assert.equal(notes[0].graces.length, 2);
  assert.equal(notes[0].graces[1].digit, 3);
});

test('圆滑线成对', () => {
  const { warnings } = compile('---\ntime: 2/4\n---\n| (4 3) | 1 - |\n');
  assert.deepEqual(warnings, []);
});

test('版面：A4 且不越界', () => {
  const { layout } = compile(SRC);
  assert.equal(layout.pages.length, 1);
  const p = layout.pages[0];
  assert.equal(p.width, 794);
  assert.equal(p.height, 1123);
  const notes = p.systems.flatMap(s => s.measures.flatMap(m => m.notes));
  const xs = notes.map(n => n.x);
  assert.ok(Math.min(...xs) > 60, '左边距');
  assert.ok(Math.max(...xs) < 794 - 60, '右边距');
});

test('时间轴：速度与休止符', () => {
  const { doc } = compile(SRC);
  const tl = buildTimeline(doc, 60);
  // 8 拍 @ 60bpm = 8 秒
  assert.ok(Math.abs(tl.total - 8) < 1e-6);
  assert.equal(tl.events.length, 7);
  assert.ok(Math.abs(tl.events[1].t - 1) < 1e-6);
});

test('长谱自动分页', () => {
  const line = '| 1 1 | 5 5 | 6 6 | 5 - | 4 4 | 3 3 | 2 2 | 1 - |\n';
  const src = `---\ntitle: 长谱\ntime: 2/4\n---\n` + line.repeat(24);
  const { layout } = compile(src);
  assert.ok(layout.pages.length >= 2, `应分页，实际 ${layout.pages.length} 页`);
});

test('SVG 结构完整', () => {
  const { svg } = compile(SRC);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /class="note/);
  assert.match(svg, /一/);        // 歌词
  assert.match(svg, /<\/svg>\s*$/);
});

/* ------------------------------------------------ 记谱法兼容性（T25CP3 反馈） */

/** 从 SVG 里抽出减时线（梁）线段 */
function beamsOf(svg) {
  return [...svg.matchAll(
    /<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)" stroke="#111" stroke-width="1\.6"\/>/g
  )].map(m => ({ x1: +m[1], y: +m[2], x2: +m[3] }));
}

test('时值后缀与书写顺序无关：附点八分 1\'_. / 1\'._ / 1_\' 等价', () => {
  const a = parseNoteToken("1'_.");
  const b = parseNoteToken("1'._");
  const c = parseNoteToken("1_.'");
  for (const n of [a, b, c]) {
    assert.equal(n.slash, 1);
    assert.equal(n.dots, 1);
    assert.equal(n.oct, 1);
    assert.equal(n.beats, 0.75);
  }
  // 手写稿里更常见的落笔顺序
  assert.equal(parseNoteToken('6._').beats, 0.75);
});

test('JPW-ABC 的 _ 减时线写法可直接当 / 用', () => {
  assert.equal(parseNoteToken('1_').slash, 1);
  assert.equal(parseNoteToken('1_').beats, 0.5);
  assert.equal(parseNoteToken('1__').beats, 0.25);
  assert.equal(parseNoteToken('1___').beats, 0.125);
});

test('空小节必须保留，小节号不能靠下标漂', () => {
  const doc = parse('key: 1=C\ntime: 2/4\n| 1/ 2/ | | 3/ 4/ |');
  const ms = doc.items.filter(i => i.kind === 'music')[0].measures;
  assert.equal(ms.length, 3, '中间的空小节不能被丢掉');
  assert.deepEqual(ms.map(m => m.no), [1, 2, 3]);
  assert.equal(ms[1].notes.length, 0);
  assert.equal(ms[2].notes[0].digit, 3);
});

test('// 35 可以把小节号钉死（总谱分谱常整段休止）', () => {
  const doc = parse('key: 1=C\ntime: 2/4\n| 1/ 2/ |\n// 35\n| 5/ 6/ | 7/ 1\'/ |');
  const ms = doc.items.filter(i => i.kind === 'music').flatMap(i => i.measures);
  assert.deepEqual(ms.map(m => m.no), [1, 35, 36]);
});

test('减时线按拍分组：拍界断开，第二层只连连续十六分', () => {
  // 2/4：1/ 2// 3// | 4/ —— 第一拍三个音，第二拍一个音
  const { svg, layout } = compile('---\ntitle: 梁\ntime: 2/4\n---\n| 1/ 2// 3// 4/ |');
  const xs = layout.pages[0].systems[0].measures[0].notes.map(n => n.x);
  assert.equal(xs.length, 4);

  const beams = beamsOf(svg);
  const topY = Math.min(...beams.map(b => b.y));
  const lv1 = beams.filter(b => b.y === topY).sort((a, b) => a.x1 - b.x1);
  const lv2 = beams.filter(b => b.y > topY).sort((a, b) => a.x1 - b.x1);

  // 第一层：拍界断开 → 两段
  assert.equal(lv1.length, 2, '主横线必须按拍分成两段');
  assert.ok(lv1[0].x1 < xs[0] && lv1[0].x2 > xs[2] - 1, '第一段覆盖第一拍三个音');
  assert.ok(lv1[1].x1 < xs[3] && lv1[1].x2 > xs[3], '第二段只覆盖第二拍那个音');
  assert.ok(lv1[0].x2 < xs[3], '两段不能连起来');

  // 第二层：只覆盖两个连续的十六分，不落到旁边八分下面
  assert.equal(lv2.length, 1);
  assert.ok(lv2[0].x1 > xs[0] + 1, '第二层不能盖住第一个八分');
  assert.ok(lv2[0].x2 > xs[2] - 1);
});

test('密集十六分保底间距，不叠字', () => {
  const { layout } = compile('---\ntitle: 密\ntime: 2/4\n---\n| 1// 2// 3// 4// 5// 6// 7// 1\'// | 1/// 2/// 3/// 4/// 5/// 6/// |');
  const xs = layout.pages[0].systems[0].measures[0].notes.map(n => n.x);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  // 阈值跟着字号走：字形宽约 0.55em，中心间距 ≥0.6em 就不会叠字。
  // 写死 14px 是旧字号（27）下的巧合，换字号就误报。
  const noteSize = layout.theme.noteSize;
  assert.ok(Math.min(...gaps) >= noteSize * 0.6,
    `十六分中心间距过小：${Math.min(...gaps).toFixed(1)} < ${(noteSize * 0.6).toFixed(1)}（noteSize=${noteSize}）`);
});

test('反复/终止记号与房子不被 tokenizer 拆散', () => {
  const ms = parseMusicLine('|: 1 2 :| [1. 3 4 :| [2. 5 - |]');
  assert.equal(ms.length, 3);
  assert.equal(ms[0].open, true);
  assert.equal(ms[0].close, ':|');
  assert.equal(ms[1].fangzi, '1.');
  assert.equal(ms[2].fangzi, '2.');
  assert.equal(ms[2].close, '|]');
  assert.deepEqual(parseMusicLine('1 2 ||').map(m => m.close), ['||']);
});

/* ---------------------------------------------------------- JPW-ABC 兼容层 */

test('JPW 技法 {DunYin} → 与 @dun 等价', () => {
  const a = parseMusicLine("1'_.7__{DunYin}6_")[0];
  assert.equal(a.beats, 1.5);
  assert.deepEqual(a.notes[1].marks, ['dun']);
  const b = parseMusicLine('7__@dun 6_')[0];
  assert.deepEqual(b.notes[0].marks, ['dun']);
  // 记号写在小节开头时归下一个音
  const c = parseMusicLine('{YanYin}2-')[0];
  assert.deepEqual(c.notes[0].marks, ['=']);
  // 中文别名
  const d = parseMusicLine('1{顿音}')[0];
  assert.deepEqual(d.notes[0].marks, ['dun']);
});

test('JPW 倚音 {6,2}、控制选项 {C:…} 被正确吃掉', () => {
  const m = parseMusicLine('{6,2}5,- | 2-{C:6.86}')[0];
  assert.equal(m.beats, 2);
  assert.equal(m.notes[0].graces.length, 2);
  assert.equal(m.notes[0].graces[0].digit, 6);
  assert.equal(parseMusicLine('2-{C:6.86}')[0].beats, 2);
});

test('JPW 增时线紧贴后续音：5-3 不被吞掉', () => {
  const m = parseMusicLine('5-3 |')[0];
  assert.equal(m.notes.length, 2);
  assert.equal(m.notes[0].beats, 2);
  assert.equal(m.notes[1].beats, 1);
});

test('段落标记 $ 与行内拍号', () => {
  const ms = parseMusicLine('3/4 1 2 3 | 5-3 | $');
  assert.equal(ms[0].meter, '3/4');
  assert.equal(ms[0].beats, 3);
  assert.equal(ms[1].beats, 3);
  assert.equal(ms[1].sectionEnd, true);
});

test('标准文字 "…" 挂到下一个音符且允许空格', () => {
  const m = parseMusicLine('"渐慢 rit." 5_2_')[0];
  assert.equal(m.notes[0].text, '渐慢 rit.');
});

test('圆滑线可以跨行闭合（全曲配对）', () => {
  const doc = parse('---\ntime: 2/4\n---\n( 5_6_ |\n1 2 | 3 4 ) |');
  const warns = doc.warnings.concat([]);
  assert.equal(warns.filter(w => w.message.includes('圆滑线')).length, 0);
  const notes = doc.items.filter(i => i.kind === 'music').flatMap(i => i.measures.flatMap(m => m.notes));
  assert.equal(notes[0].slurOpen, true);
  assert.equal(notes[notes.length - 1].slurClose, true);
});

test('带数字的说明文字不会被当成谱行', () => {
  const doc = parse('---\ntime: 2/4\n---\n`@0` 空弦、`@la` 拉弓\n1 2 | 3 4 |');
  assert.equal(doc.warnings.filter((w) => w.message.includes('无法解析')).length, 0);
  const music = doc.items.filter((i) => i.kind === 'music');
  assert.equal(music.length, 1, '只有一行是谱');
});
