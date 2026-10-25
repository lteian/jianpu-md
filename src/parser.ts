/**
 * jianpu-md 解析器：纯文本 → Doc AST
 */
import type {
  Doc, Item, Measure, Meta, MusicItem, Note, GraceNote, Warning, SectionItem
} from './types.js';
import { parseKey, parseTime, normalizeMark } from './pitch.js';

let seq = 0;
/** 仅供编辑模块「重放解析」用：把音序号计数器归零，重放后 idx 与 parse() 一致 */
export function resetNoteSeq(): void { seq = 0; }

const BAR_TOKENS = new Set(['|', '|:', ':|', '||', '|]']);

/**
 * 引号内空格的占位符。
 * 不能用 \u00A0——JS 的 \s 认它，照样会被 split 撕开；挑一个既不是空白、
 * 又不可能出现在乐谱里的控制字符，拼完再还原。
 */
const SPACE_HOLD = '\u0001';

/**
 * JPW-ABC 兼容层（见 docs/03-JPW-ABC-对照与兼容.md）
 *
 *  1. `{C:6.86}`   控制选项 → 丢弃（JP-Word 的排版微调，我们没有对应概念）
 *  2. `{DunYin}`   技法 → `@DunYin`，落到与 `@dun` 同一张记号表
 *  3. `{6,2}`      前倚音 → `^{6,2}`，复用既有倚音语法
 *
 * 顺序不能换：先扔控制选项，再认技法，最后才把剩下的纯音高花括号当倚音。
 */
function preprocessJpw(line: string): string {
  if (!/[{}]/.test(line)) return line;
  let s = line;
  s = s.replace(/\{C:[^}]*\}/g, '');
  s = s.replace(
    /\{([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*(?:\s*,\s*[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*)*)\}/g,
    // 两侧补空格：JPW 写成 `7__{DunYin}6_`，记号属于前一个音，不能和后面的音粘成一个 token
    (_m, g: string) =>
      ' ' + g.split(',').map((x) => '@' + x.trim()).join(' ') + ' '
  );
  s = s.replace(/(^|[\s(])\{([0-7][0-9,'#b\s,]*)\}/g, '$1^{$2}');
  return s;
}

/** 把结构性字符拆成独立 token（编辑模块也用它来重建被改动的行） */
export function tokenize(line: string): string[] {
  let s = preprocessJpw(line)
    // 双引号里的文字允许带空格，先换成不断行空格，免得被下面的 split 撕开
    .replace(/"[^"]*"/g, (m) => m.replace(/\s/g, SPACE_HOLD))
    .replace(/｜/g, '|')
    /*
     * 结构性字符必须**一趟**切开：|: :| || |] | ( ) [ ] ^[ _[ 一起匹配，长的排前面。
     * 分多趟各写一条 /g 替换是不行的——后一趟的 `|` 会把前一趟插入的 `:|` 再拆成 `:` + `|`，
     * 反复记号于是整条静默失效（这个 bug 存在过很久，靠「房子」那条测试才暴露）。
     */
    .replace(/(\|:|:\||\|\||\|]|\||\(|\)|\[|\]|\^\[|_\[)/g, ' $1 ');
  // 倚音写作 ^{1 2} / _{1}，统一成 ^[ ... ]
  s = s.replace(/\^\{/g, ' ^[ ').replace(/_\{/g, ' _[ ').replace(/\}/g, ' ] ');
  // JPW-ABC 习惯把音连成一串：(6.5)(45)6 —— 在这里补上分隔，别要求用户逐个加空格。
  // 本语法里没有多位数，所以「数字紧跟数字」必然是两个音。
  s = s.replace(/(\d)(?=\d)/g, '$1 ');
  s = s.replace(/([_.',])(?=\d)/g, '$1 ');
  // `5-3`：JPW-ABC 里增时线可以紧贴后面的音，JP-Word 例子中随处可见
  s = s.replace(/(\d)(-+)(?=\d)/g, (_m, d: string, dash: string) => `${d} ${dash} `);
  return s.trim().split(/\s+/).filter(Boolean);
}

/**
 * 行内「音」的字面位置扫描：返回每个音在原行里的 [start, end) 字符范围。
 *
 * 为什么不用 tokenize：tokenize 会把结构符前后加空格、把 JPW 的 {…} 改写成
 * 别的东西，位置对不上原文；而这里要的恰恰是**原文**位置——
 * 谱面光标要停在「两个音中间」，插入时又不能碰坏行里的其它内容
 * （引号文字、注释、拍号…），所以只能拿到字符级坐标。
 *
 * 规则要和 parseMusicLine 对齐（音的顺序必须一致）：
 *   - 结构符 | : ( ) [ ] ^ _ 直接跳过
 *   - 引号文字整段跳过
 *   - `2/4` 这种行内拍号不是音（后一位是数字就判定为拍号）
 *   - `1` `1'` `b7` `1//` `1..` `5@la` 都算一个音（音级+八度点+增时线+减时线+附点+记号）
 */
const NOTE_AT = /^(?:[#b\u266d\u266e\u2099])?[0-7xX](?:['\u2032,\uff0c]+)?(?:-[-\uff0d\u2013]*)?(?:[/_]+)?(?:[\.\u3002]*)?(?:@[A-Za-z\u4e00-\u9fa50-9><=]+)*/;

export interface LineNoteSpan {
  /** 原文里的起始 / 结束字符下标 */
  start: number;
  end: number;
  /** 原文里的字面（未规范化） */
  text: string;
}

export function scanLineNotes(line: string): LineNoteSpan[] {
  const out: LineNoteSpan[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) { i++; continue; }
    // 结构符
    if ('|:()[]^_'.includes(ch)) { i++; continue; }
    // 引号文字：整段跳过
    if (ch === '"') {
      const e = line.indexOf('"', i + 1);
      i = e < 0 ? line.length : e + 1;
      continue;
    }
    const m = NOTE_AT.exec(line.slice(i));
    if (m && m.index === 0) {
      const text = m[0];
      // 行内拍号（7/8、2/4）不是音：斜杠后面紧跟数字就当拍号
      const isMeter = /\/$/.test(text) && /[0-9]/.test(line[i + text.length] || '');
      if (!isMeter) {
        out.push({ start: i, end: i + text.length, text });
        i += text.length;
        continue;
      }
      // 拍号：把 `2/4` 整段跳过（数字 + 斜杠 + 分子）
      i += text.length;
      if (/[0-9]/.test(line[i] || '')) i++;
      continue;
    }
    i++;
  }
  return out;
}

function makeNote(partial: Partial<Note>): Note {
  return {
    kind: 'note', digit: 0, acc: 0, oct: 0, slash: 0, dashes: 0, dots: 0,
    beats: 1, marks: [], tie: false, slurOpen: false, slurClose: false,
    graces: [], gracesAfter: [], lyric: '', idx: seq++, line: 0, col: 0,
    ...partial
  };
}

/** 解析单个音符 token，失败返回 null */
export function parseNoteToken(tok: string, line = 0, col = 0): Note | null {
  let t = tok;
  const marks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = /@([A-Za-z\u4e00-\u9fa5]+[0-9]*|[0-9]+|[><=])$/.exec(t))) {
    marks.unshift(normalizeMark(m[1]));
    t = t.slice(0, m.index);
  }
  // 时值后缀按「出现次数」统计，与书写顺序无关。
  // 用户手写习惯很不统一：附点八分写成 1'_. / 1._ / 6._ 都得吃，
  // 所以这里不能用「先剥点、再剥横线、再剥斜杠」的固定顺序。
  // `_`（JPW-ABC 的减时线写法）在这里等价于 `/`。
  let dots = 0, dashes = 0, slash = 0, oct = 0;
  for (;;) {
    const c = t.slice(-1);
    if (c === '.' || c === '。') dots++;
    else if (c === '-' || c === '－' || c === '–') dashes++;
    else if (c === '/' || c === '_') slash++;
    else if (c === ',' || c === '，') oct--;
    else if (c === "'" || c === '’' || c === '′') oct++;
    else break;
    t = t.slice(0, -1);
  }
  let acc = 0;
  if (t.startsWith('#')) { acc = 1; t = t.slice(1); }
  else if (t.startsWith('b') || t.startsWith('♭')) { acc = -1; t = t.slice(1); }
  else if (t.startsWith('n') || t.startsWith('♮')) { acc = 0; t = t.slice(1); }
  if (!/^[0-7xX]$/.test(t)) return null;

  const isRest = t === '0';
  const isNoise = t === 'x' || t === 'X';
  let beats = 1 / Math.pow(2, slash) + dashes;
  if (dots > 0) beats *= 2 - Math.pow(0.5, dots);

  return makeNote({
    kind: isRest ? 'rest' : isNoise ? 'noise' : 'note',
    digit: isRest ? 0 : isNoise ? -1 : Number(t),
    acc, oct, slash, dashes, dots, beats, marks, line, col
  });
}

function parseGrace(tok: string): GraceNote | null {
  const n = parseNoteToken(tok);
  if (!n) return null;
  return { digit: n.digit, acc: n.acc, oct: n.oct, slash: n.slash, dots: n.dots };
}

/** 解析一整行乐谱 → 小节数组 */
/** 一个音在源码行里的位置：token 下标 + 解析出的音符（给鼠标编辑用） */
export interface NoteTokenRef { ti: number; note: Note; }

/**
 * 解析一行音乐。
 * 传了 `rec` 就顺便把「第几个 token 是第几个音」记下来——界面要点中就音符、
 * 改音高/时值，必须能精确落回源文本的某个 token，靠 idx 反推是不可靠的
 * （倚音、括号、文字标记都会占 token，下标和音符序号不是一回事）。
 */
export function parseMusicLine(text: string, line = 0, rec?: NoteTokenRef[]): Measure[] {
  const toks = tokenize(text);
  const measures: Measure[] = [];
  let cur: Measure = { notes: [], beats: 0, no: 0, open: false, close: null };
  let prev: Note | null = null;
  let col = 0;
  let pendingGrace: GraceNote[] = [];
  let pendingSlur = false;
  let pendingText = '';
  let pendingMarks: string[] = [];

  const flush = (close: string | null, force = false) => {
    if (cur.notes.length || force) {
      cur.close = close;
      measures.push(cur);
    }
    cur = { notes: [], beats: 0, no: 0, open: false, close: null };
    prev = null;
  };

  // 后面还有没有实质内容？用来区分「行末的收尾竖线」和「中间真的空着的小节」
  const hasContentAfter = (from: number): boolean => {
    for (let k = from + 1; k < toks.length; k++) {
      const t = toks[k];
      if (BAR_TOKENS.has(t)) continue;
      if (parseNoteToken(t) || /^[-－–]+$/.test(t)) return true;
    }
    return false;
  };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    col = text.indexOf(tok, col);

    if (BAR_TOKENS.has(tok)) {
      if (tok === '|:' && cur.notes.length === 0) { cur.open = true; continue; }
      // 中间的空小节必须保留成一个小节（拍数 0），否则它后面的小节号全部前移。
      // 总谱分谱里「本声部休止」的小节是常态，编号一漂，用户说「第 35 小节错了」就对不上。
      const keepEmpty = !cur.notes.length && measures.length > 0 && hasContentAfter(i);
      if (cur.notes.length || keepEmpty) flush(tok === '|' ? '|' : tok, keepEmpty);
      if (tok === '|:') cur.open = true;
      // 房子（跳跃反复）：小节线后面紧跟 [1. / [2. / [1.2.
      if (toks[i + 1] === '[' && /^[0-9.]+$/.test(toks[i + 2] || '')) {
        cur.fangzi = toks[i + 2];
        i += 2;
      }
      continue;
    }

    // 段落标记 $ / $(True)：结束本段，不结束全曲
    if (tok === '$' || /^\$[(（]/.test(tok)) {
      if (cur.notes.length) flush('||');
      const last = measures[measures.length - 1];
      if (last) last.sectionEnd = true;
      continue;
    }

    // 行内拍号变换（JPW-ABC 把拍号当一个符号插在乐章中间）
    if (/^\d+\/\d+$/.test(tok)) { cur.meter = tok; continue; }

    // 独立的技法 token（JPW 的 {DunYin} 会被兼容层拆成一个独立 token）
    // 归属规则沿用谱面实际写法：小节内有前一个音就归它，小节开头则归下一个音。
    if (/^@[A-Za-z\u4e00-\u9fa5]/.test(tok)) {
      const mk = normalizeMark(tok.slice(1));
      if (cur.notes.length && prev) prev.marks.push(mk);
      else pendingMarks.push(mk);
      continue;
    }

    // 标准文字 "…"，挂到下一个音符上方
    if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) {
      pendingText = tok.slice(1, -1).split(SPACE_HOLD).join(' ');
      continue;
    }

    if (tok === '(') { pendingSlur = true; continue; }
    if (tok === ')') { if (prev) prev.slurClose = true; continue; }
    if (tok === '~') { if (prev) prev.tie = true; continue; }

    // 倚音 ^{...} / _{...}
    if (tok === '^[' || tok === '_[') {
      const group: GraceNote[] = [];
      let j = i + 1;
      while (j < toks.length && toks[j] !== ']') {
        const g = parseGrace(toks[j]);
        if (g) group.push(g);
        j++;
      }
      i = j;
      if (tok === '^[') pendingGrace = pendingGrace.concat(group);
      else if (prev) prev.gracesAfter.push(...group);
      continue;
    }

    // 三连音等连音符：3[ ... ]
    if (/^[2-9]$/.test(tok) && toks[i + 1] === '[') {
      const n = Number(tok);
      const inner: Note[] = [];
      let j = i + 2;
      while (j < toks.length && toks[j] !== ']') {
        const nn = parseNoteToken(toks[j], line, col);
        if (nn) inner.push(nn);
        j++;
      }
      i = j;
      const scale = (n - 1) / n;
      for (const nn of inner) { nn.beats *= scale; }
      for (const nn of inner) {
        cur.notes.push(nn);
        cur.beats += nn.beats;
        prev = nn;
      }
      continue;
    }

    // 独立的增时线 "-" / "--"
    if (/^[-－–]+$/.test(tok) && prev) {
      const add = tok.length;
      prev.dashes += add;
      prev.beats += add;
      cur.beats += add;
      continue;
    }

    const n = parseNoteToken(tok, line, col);
    if (!n) continue;
    if (pendingGrace.length) { n.graces = pendingGrace; pendingGrace = []; }
    if (pendingSlur) { n.slurOpen = true; pendingSlur = false; }
    if (pendingText) { n.text = pendingText; pendingText = ''; }
    if (pendingMarks.length) { n.marks.push(...pendingMarks); pendingMarks = []; }
    if (rec) rec.push({ ti: i, note: n });
    cur.notes.push(n);
    cur.beats += n.beats;
    prev = n;
  }
  flush(null);
  return measures;
}

/* ------------------------------------------------------------------ 文档 */

// spacing / linegap：行距倍率（0.5–1.8），打印时一页多一行就靠它压回去
const META_RE = /^(key|time|tempo|tuning|instrument|title|subtitle|composer|lyricist|paper|orientation|spacing|linegap)\s*[:：]\s*(.+)$/i;
const LYRIC_RE = /^(?:L|H|词|歌词)\s*[:：]\s*(.*)$/i;
const SECTION_RE = /^(?:%+|##+|={3,}|\/\/)\s*(.*)$/;

/**
 * 多小节休止：`R18` / `r18` / `休止18` / `休止 18 小节`。
 * 分谱里整段不演奏是常态（合奏曲的二胡声部常常几十小节没音符），
 * 逐个写空小节既占版面又要写十几行，还每条都触发「空小节」告警。
 */
const REST_BARS_RE = /^(?:R|r|休止)\s*(\d{1,3})\s*(?:小节|个?小?节|bars?)?$/;
const COMMENT_RE = /^(?:\/\/|--|;)\s?/;
/**
 * `// 35` —— 只写数字的 `//` 行是「下一小节从第 35 小节开始」的编号指令。
 * 合唱/民乐分谱里常整段休止，手写谱的小节号是唯一可靠的定位基准，
 * 号必须能由用户直接钉死，不能全靠顺序推。
 */
const MEASURE_NO_RE = /^\/{2,}\s*(\d+)\s*$/;

export function splitSyllables(s: string): string[] {
  const t = (s || '').trim();
  if (!t) return [];
  if (/\s/.test(t)) return t.split(/\s+/).filter(Boolean);
  return Array.from(t);
}

export function parse(text: string): Doc {
  seq = 0;
  const warnings: Warning[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const meta: Meta = {};
  const items: Item[] = [];

  let i = 0;
  // YAML front matter
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') {
      const m = /^\s*([A-Za-z_]+)\s*[:：]\s*(.*)$/.exec(lines[i]);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      i++;
    }
    i++;
  }

  let pendingLyric: string | null = null;
  let nextMeasureNo: number | null = null;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNo = i + 1;
    if (!line) { pendingLyric = null; continue; }

    const mno = MEASURE_NO_RE.exec(line);
    if (mno) { nextMeasureNo = parseInt(mno[1], 10); continue; }

    const sec = SECTION_RE.exec(line);
    if (sec) {
      items.push({ kind: 'section', text: sec[1].trim(), line: lineNo } as SectionItem);
      continue;
    }
    if (COMMENT_RE.test(line)) continue;

    const rbm = REST_BARS_RE.exec(line);
    if (rbm) {
      const bars = Math.max(1, Math.min(999, parseInt(rbm[1], 10) || 1));
      const m: Measure = { notes: [], beats: 0, no: 0, open: false, close: null, restBars: bars };
      items.push({ kind: 'music', measures: [m], line: lineNo });
      continue;
    }

    const mm = META_RE.exec(line);
    if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }

    const lm = LYRIC_RE.exec(line);
    if (lm) {
      const last = lastMusic(items);
      if (last) {
        attachLyrics(last, lm[1], warnings, lineNo);
      } else {
        pendingLyric = (pendingLyric ? pendingLyric + ' ' : '') + lm[1];
      }
      continue;
    }

    // 散文里出现数字（"`@0` 空弦"）不该被当成谱行：反引号与中文标点是明确的散文信号
    if (/[`、。；？！]/.test(line)) continue;

    if (/^[|:(\[]/.test(line) || /\d/.test(line)) {
      const measures = parseMusicLine(line, lineNo);
      if (!measures.length) {
        warnings.push({ level: 'warn', message: `无法解析的行：${line.slice(0, 40)}`, line: lineNo });
        continue;
      }
      const item: MusicItem = { kind: 'music', measures, line: lineNo };
      if (nextMeasureNo !== null && measures.length) {
        measures[0].no = nextMeasureNo;
        nextMeasureNo = null;
      }
      items.push(item);
      if (pendingLyric) { attachLyrics(item, pendingLyric, warnings, lineNo); pendingLyric = null; }
      continue;
    }
    // 纯文字 → 当作段落标题
    items.push({ kind: 'section', text: line, line: lineNo } as SectionItem);
  }

  const key = parseKey(meta.key);
  const time = parseTime(meta.time);
  const tempo = Math.max(20, Math.min(300, parseInt(meta.tempo || '88', 10) || 88));

  // 全曲连号：用户钉死的小节号（// 35）会重置计数器，其余顺序递增
  let counter = 0;
  for (const it of items) {
    if (it.kind !== 'music') continue;
    for (const m of it.measures) {
      if (m.restBars) { m.no = counter + 1; counter += m.restBars; continue; }
      if (m.no > 0) counter = m.no;
      else m.no = ++counter;
    }
  }

  const notes = items.flatMap(it => it.kind === 'music'
    ? it.measures.flatMap(m => m.notes)
    : []);
  notes.forEach((n, k) => { n.idx = k; });

  return { meta, key, time, tempo, items, warnings };
}

function lastMusic(items: Item[]): MusicItem | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.kind === 'music') return it;
    if (it.kind === 'section') continue;
  }
  return null;
}

function attachLyrics(item: MusicItem, raw: string, warnings: Warning[], lineNo: number): void {
  const syl = splitSyllables(raw);
  const sounding = item.measures.flatMap(m => m.notes).filter(n => n.kind === 'note');
  sounding.forEach((n, k) => { if (k < syl.length) n.lyric = syl[k]; });
  if (syl.length && syl.length !== sounding.length) {
    warnings.push({
      level: 'warn',
      message: `第 ${lineNo} 行歌词 ${syl.length} 字，对应音符 ${sounding.length} 个，未对齐`,
      line: lineNo
    });
  }
}
