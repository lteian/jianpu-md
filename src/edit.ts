/**
 * 源码级编辑：把界面上的鼠标/按钮操作翻译成对 jianpu-md 文本的**定点改写**。
 *
 * 为什么不「改 AST 再整体序列化」：用户在 md 里写的 `%` 段落注释、空行、
 * `L:` 歌词行、`// 35` 小节号指令、手写间距，都是他的原文，不该被一次鼠标
 * 点击冲掉。所以这里只重写**被改到的那一行**，而且只替换该行里被改到的
 * token，其余 token 原样保留。
 *
 * 代价：被改到的那一行会按规范形式重排空格（`(6.5)(45)6` → `( 6.5 ) ( 45 ) 6`）。
 * 语义完全等价，渲染结果不变，只是原文的「手感间距」会规整化。其它行不动。
 */
import { parse, parseMusicLine, parseNoteToken, resetNoteSeq, tokenize, type NoteTokenRef } from './parser.js';
import type { Note } from './types.js';

/** 一个音在源码里的位置 */
/** 互斥的记号组：指法只能有一个，弦位也只能有一个（内弦 or 外弦） */
const MARK_GROUP: Record<string, string> = {
  '0': 'finger', '1': 'finger', '2': 'finger', '3': 'finger', '4': 'finger',
  nei: 'hand', wai: 'hand'
};

export interface NoteSpan {
  /** 1 起的行号 */
  line: number;
  /** 该行 token 下标 */
  ti: number;
  note: Note;
}

export type EditOp =
  /** 改音级；0 = 改成休止符 */
  | { kind: 'digit'; digit: number }
  /** 音级相对移动：+1 往上一个数字（7 封顶），-1 往下（1 封底） */
  | { kind: 'digitStep'; delta: number }
  /** 八度：+1 加一个高音点，-1 加一个低音点 */
  | { kind: 'oct'; delta: number }
  /** 减时线层数（/ 的个数）：+1 减半，-1 加倍 */
  | { kind: 'slash'; delta: number }
  /** 直接设定时值档位（0=全 1=二分 2=四分 3=八分 4=十六分 5=三十二分） */
  | { kind: 'dur'; level: number }
  /** 增时线个数（- 的个数）：+1 加一拍 */
  | { kind: 'dashes'; delta: number }
  /** 附点 */
  | { kind: 'dots'; delta: number }
  /** 加/去一个记号（`la` 拉弓、`tui` 推弓、`0` 空弦…）；不给 on 就是切换 */
  | { kind: 'mark'; mark: string; on?: boolean }
  /** 变音记号：1 升 / -1 降 / 0 还原 */
  | { kind: 'acc'; acc: number }
  /** 删掉这个音 */
  | { kind: 'delete' }
  /** 在这个音后面插入一个同类的音 */
  | { kind: 'insertAfter'; digit?: number };

/**
 * 扫一遍源码，得到每个 note.idx → (行号, token 下标)。
 *
 * 关键点：`parse()` 里 `seq` 是全局递增的，直接对单行再解析一次会接着编号，
 * 得到的 idx 和 layout 里的对不上。所以这里先 `resetNoteSeq()`，再按**同样的
 * 行序遍历**重放一遍，idx 才能和 `parse()` 逐个吻合。
 */
export function locateNotes(src: string): Map<number, NoteSpan> {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const doc = parse(src);
  const map = new Map<number, NoteSpan>();
  resetNoteSeq();
  for (const it of doc.items) {
    if (it.kind !== 'music') continue;
    const rec: NoteTokenRef[] = [];
    parseMusicLine(lines[it.line - 1] ?? '', it.line, rec);
    for (const r of rec) map.set(r.note.idx, { line: it.line, ti: r.ti, note: r.note });
  }
  return map;
}

/** Note → 规范 token 文本（parseNoteToken 的逆运算） */
export function serializeToken(n: Note): string {
  let s: string;
  if (n.kind === 'rest') s = '0';
  else if (n.kind === 'noise') s = 'x';
  else s = String(n.digit);

  if (n.acc > 0) s = '#' + s;
  else if (n.acc < 0) s = 'b' + s;

  // 时值后缀：解析器是「从末尾反复剥」，所以顺序无所谓；这里按可读性排
  s += n.oct > 0 ? "'".repeat(n.oct) : ','.repeat(-n.oct);
  s += '-'.repeat(Math.max(0, n.dashes));
  s += '/'.repeat(Math.max(0, n.slash));
  s += '.'.repeat(Math.max(0, n.dots));

  // 记号必须留在最后：parseNoteToken 是先剥 @mark、再剥时值后缀
  for (const mk of n.marks) s += '@' + mk;
  return s;
}

/** 时值档位：0=全音符 1=二分 2=四分 3=八分 4=十六分 5=三十二分 */
export const DUR_LEVELS: { dashes: number; slash: number }[] = [
  { dashes: 3, slash: 0 },
  { dashes: 1, slash: 0 },
  { dashes: 0, slash: 0 },
  { dashes: 0, slash: 1 },
  { dashes: 0, slash: 2 },
  { dashes: 0, slash: 3 },
];

/** 反查一个音当前落在哪一档（附点不影响档位） */
export function durLevel(n: Note): number {
  if (n.dashes > 0) return n.dashes >= 2 ? 0 : 1;
  return Math.min(5, 2 + n.slash);
}

function applyOp(n: Note, op: EditOp): Note | null {
  const m: Note = { ...n, marks: [...n.marks], graces: [...n.graces], gracesAfter: [...n.gracesAfter] };
  switch (op.kind) {
    case 'digit':
      m.digit = op.digit;
      m.kind = op.digit === 0 ? 'rest' : 'note';
      if (op.digit === 0) { m.oct = 0; m.acc = 0; }
      break;
    case 'digitStep': {
      const d0 = m.kind === 'rest' ? 1 : m.digit;
      const d1 = Math.max(1, Math.min(7, d0 + op.delta));
      m.digit = d1;
      m.kind = 'note';
      break;
    }
    case 'oct':
      m.oct = Math.max(-3, Math.min(3, m.oct + op.delta));
      break;
    case 'slash':
      m.slash = Math.max(0, Math.min(4, m.slash + op.delta));
      // 减时线只管「比四分短」，别跟增时线同时存在，否则 1-// 这种没意义
      if (m.slash > 0) m.dashes = 0;
      break;
    case 'dashes':
      m.dashes = Math.max(0, Math.min(7, m.dashes + op.delta));
      if (m.dashes > 0) m.slash = 0;
      break;
    case 'dots':
      m.dots = Math.max(0, Math.min(2, m.dots + op.delta));
      break;
    case 'dur': {
      const L = DUR_LEVELS[Math.max(0, Math.min(DUR_LEVELS.length - 1, op.level))];
      m.dashes = L.dashes;
      m.slash = L.slash;
      break;
    }
    case 'mark': {
      const has = m.marks.includes(op.mark);
      const want = op.on === undefined ? !has : op.on;
      if (want && !has) {
        // 同一个音只留一个指法、一个弦位：点「二指」不该跟「一指」叠成两行小字
        const group = MARK_GROUP[op.mark];
        const kept = group ? m.marks.filter((x) => MARK_GROUP[x] !== group) : m.marks;
        m.marks = [...kept, op.mark];
      } else if (!want && has) {
        m.marks = m.marks.filter((x) => x !== op.mark);
      }
      break;
    }
    case 'acc':
      m.acc = Math.max(-1, Math.min(1, op.acc));
      break;
    case 'delete':
      return null;
    case 'insertAfter':
      return null;   // 插入由调用方处理
  }
  return m;
}

interface Pending { ti: number; op: EditOp; note: Note }

/**
 * 应用一批编辑。返回改好的源码（其它行原样保留）。
 * 同一个音有多条操作时按数组顺序叠加。
 */
export function applyNoteEdits(src: string, edits: { idx: number; op: EditOp }[]): string {
  if (!edits.length) return src;
  const spans = locateNotes(src);
  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  const byLine = new Map<number, Pending[]>();
  for (const e of edits) {
    const sp = spans.get(e.idx);
    if (!sp) continue;
    const arr = byLine.get(sp.line) || [];
    arr.push({ ti: sp.ti, op: e.op, note: sp.note });
    byLine.set(sp.line, arr);
  }

  for (const [lineNo, pend] of byLine) {
    const idx0 = lineNo - 1;
    if (idx0 < 0 || idx0 >= lines.length) continue;
    const toks = tokenize(lines[idx0]);

    // 按下标从大到小处理：插入/删除不会让还没处理的下标漂移
    pend.sort((a, b) => b.ti - a.ti);
    // 同一个 token 上的多条操作要正序叠加，这里先把同 ti 的合并
    const merged = new Map<number, Pending[]>();
    for (const p of pend) {
      const arr = merged.get(p.ti) || [];
      arr.push(p);
      merged.set(p.ti, arr);
    }
    const tis = [...merged.keys()].sort((a, b) => b - a);

    for (const ti of tis) {
      const ops = merged.get(ti)!.slice().reverse();   // 恢复正序
      let note: Note | null = ops[0].note;
      const inserts: string[] = [];
      let del = false;
      for (const p of ops) {
        if (p.op.kind === 'insertAfter') {
          const base = note ?? ops[0].note;
          const d = p.op.digit ?? base.digit;
          inserts.push(serializeToken({ ...base, kind: 'note', digit: d }));
          continue;
        }
        const r = applyOp(note!, p.op);
        if (r === null) { del = true; break; }
        note = r;
      }
      if (del) {
        toks.splice(ti, 1);
      } else if (note) {
        toks[ti] = serializeToken(note);
        if (inserts.length) toks.splice(ti + 1, 0, ...inserts);
      }
    }
    lines[idx0] = toks.join(' ');
  }

  return lines.join('\n');
}

/**
 * 给一段连续的音加/去圆滑线（连弓）。
 *
 * 语法里 `(` 和 `)` 是**独立 token**（`(3 5)` 会被 tokenize 拆成 4 个），
 * 所以不能只改音符 token，必须按括号配对来删：只动「两端都落在选区里」的
 * 那种括号对，跨越选区边界的旧圆滑线原样保留，避免把别的连弓拆坏。
 */
export function setSlur(src: string, fromIdx: number, toIdx: number, on: boolean): string {
  const spans = locateNotes(src);
  const a = spans.get(fromIdx);
  const b = spans.get(toIdx);
  if (!a || !b || a.line !== b.line) return src;
  let lo = Math.min(a.ti, b.ti);
  let hi = Math.max(a.ti, b.ti);
  if (on && lo === hi) return src;      // 单个音谈不上连弓

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const idx0 = a.line - 1;
  const toks = tokenize(lines[idx0]);

  const nLo = lo, nHi = hi;   // 音符 token 的原位置，插括号时要用
  // 把紧贴在选区外侧的括号并入选区，否则「选中已有连弓内的音再点取消」会没反应
  while (lo > 0 && toks[lo - 1] === '(') lo--;
  while (hi + 1 < toks.length && toks[hi + 1] === ')') hi++;

  // 括号配对
  const pairs: [number, number][] = [];
  const stack: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '(') stack.push(i);
    else if (t === ')' && stack.length) pairs.push([stack.pop()!, i]);
  }

  const kill = new Set<number>();
  for (const [o, c] of pairs) {
    if (o >= lo && c <= hi) { kill.add(o); kill.add(c); }
    // 跨越选区边界的旧圆滑线：不动
  }

  // 选区内的独立括号全部丢弃（含配对的和没配上的孤立括号）
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (kill.has(i)) continue;
    if ((t === '(' || t === ')') && i >= lo && i <= hi) continue;
    out.push(t);
  }

  if (on) {
    // 重新定位 lo/hi 在新数组里的位置：按「选区内的非括号 token」数数
    let start = -1, end = -1, seen = 0;
    const wantLo = toks.slice(0, nLo + 1).filter((t, i) => t !== '(' && t !== ')' && !kill.has(i)).length - 1;
    const wantHi = toks.slice(0, nHi + 1).filter((t, i) => t !== '(' && t !== ')' && !kill.has(i)).length - 1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '(' || out[i] === ')') continue;
      if (seen === wantLo) start = i;
      if (seen === wantHi) end = i;
      seen++;
    }
    if (start >= 0 && end > start) {
      out.splice(end + 1, 0, ')');
      out.splice(start, 0, '(');
    }
  }

  lines[idx0] = out.join(' ');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ 自动分节 */

/** 小节线类 token（`|:` `:|` `||` `|]` 带语义，重排时保留） */
const BAR_LINES = new Set(['|', '|:', ':|', '||', '|]']);

/** 一小节有几拍（以四分音符计）：2/4 → 2，3/8 → 1.5，6/8 → 3 */
function beatsOfMeter(num: number, den: number): number {
  if (!(num > 0 && den > 0)) return 4;
  return (num * 4) / den;
}

/**
 * 按拍号把一行重新分节。
 *
 * 规则：
 *   - 行内普通 `|` 全部丢掉，按音符累计拍数重插（满一小节落一条）
 *   - `|:` `:|` `||` `|]` 带语义（反复、终止），原样保留并把累计清零
 *   - 行首补 `|`（除非本来就以结构线开头）
 *   - 行末补 `|`（哪怕最后一小节不满，规范要求收线）
 *   - 行内拍号（`2/4`）优先于参数
 *
 * 只动音符行；纯文字行、空行原样返回。
 */
export function autoBarLine(line: string, beatsPerBar = 4): string {
  const body = line.replace(/^\s+/, '');
  const indent = line.slice(0, line.length - body.length);
  const raw = tokenize(body);
  if (!raw.length) return line;

  // `1 - 2` 里那条独立的 `-` 是增时线，并回前一个音（`1-`）
  const toks: string[] = [];
  for (const t of raw) {
    const prev = toks[toks.length - 1];
    if (/^-+$/.test(t) && prev && parseNoteToken(prev)) toks[toks.length - 1] = prev + t;
    else toks.push(t);
  }

  const notes = toks.map((t) => (BAR_LINES.has(t) ? null : parseNoteToken(t)));
  if (!notes.some(Boolean)) return line;          // 没有音符：不是谱行

  let per = beatsPerBar > 0 ? beatsPerBar : 4;
  for (const t of toks) {
    const m = /^(\d+)\/(\d+)$/.exec(t);
    if (m) per = beatsOfMeter(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  const out: string[] = [];
  let acc = 0;
  let depth = 0;          // 连音括号深度：满拍点在括号里时要等到 `)` 之后
  let pending = 0;

  const flush = () => {
    while (pending > 0) { out.push('|'); pending--; }
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '(') { out.push(t); depth++; continue; }
    if (t === ')') {
      out.push(t);
      depth = Math.max(0, depth - 1);
      if (!depth) flush();
      continue;
    }
    if (BAR_LINES.has(t)) {
      if (t !== '|') { out.push(t); acc = 0; pending = 0; }   // 反复记号保留并断累计
      continue;
    }
    out.push(t);
    const n = notes[i];
    if (!n) continue;
    acc += n.beats;

    let due = 0;
    while (acc >= per - 1e-9) { due++; acc -= per; }
    if (!due) continue;
    // 后面紧跟着 `:|` `||` `|]`：那是收尾线，不要再补一条
    const nx = toks[i + 1];
    if (nx && BAR_LINES.has(nx) && nx !== '|') { due = 0; acc = 0; }
    if (depth > 0) { pending += due; continue; }
    for (let k = 0; k < due; k++) out.push('|');
  }
  flush();

  // 行首：拍号后面补线；纯音符就在最前面补
  const first = out[0];
  if (first && /^\d+\/\d+$/.test(first)) {
    if (out[1] && !BAR_LINES.has(out[1])) out.splice(1, 0, '|');
  } else if (first && !BAR_LINES.has(first) && first !== '$') {
    out.unshift('|');
  }
  // 行末：`$` 之前必须是线；末尾空着也补
  const last = out[out.length - 1];
  if (last && last !== '$' && !BAR_LINES.has(last)) out.push('|');

  const res = out.join(' ');
  return res === body ? line : indent + res;
}

/** 给指定的几行（1 起）重排小节线，其它行原样保留 */
export function rebarLines(src: string, lineNos: number[], beatsPerBar = 4): string {
  if (!lineNos.length) return src;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const want = new Set(lineNos);
  let changed = false;
  for (const no of want) {
    const i = no - 1;
    if (i < 0 || i >= lines.length) continue;
    const next = autoBarLine(lines[i], beatsPerBar);
    if (next !== lines[i]) { lines[i] = next; changed = true; }
  }
  return changed ? lines.join('\n') : src;
}

/* ------------------------------------------------------------------ front matter */

/**
 * 改 frontmatter 里的一个字段（没有就插入，没有 frontmatter 就建一个）。
 * 工作台的「速度」输入框用它同步到谱面 —— 改了播放速度，谱上的 ♩= 也该跟着变。
 */
export function setMeta(src: string, key: string, value: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const k = key.toLowerCase();
  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      const re = new RegExp('^\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]', 'i');
      for (let i = 1; i < end; i++) {
        if (re.test(lines[i])) {
          // 空值 = 删除这个键（行距调回 100% 时不留一行空字段）
          if (!value) { lines.splice(i, 1); return lines.join('\n'); }
          lines[i] = `${key}: ${value}`;
          return lines.join('\n');
        }
      }
      if (!value) return src;
      lines.splice(end, 0, `${key}: ${value}`);
      return lines.join('\n');
    }
  }
  if (!value) return src;
  lines.unshift('---', `${key}: ${value}`, '---');
  return lines.join('\n');
}
