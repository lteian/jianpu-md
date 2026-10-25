/**
 * SVG 渲染器：Layout → SVG 字符串
 * 纯字符串拼接，不依赖 DOM，Node / 浏览器同构。
 */
import type { Layout, Note, Page, PlacedMeasure, PlacedNote, System, Theme, TimeSig } from './types.js';
import { MARK_MAP } from './pitch.js';
import { measureWidth } from './layout.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n1 = (v: number): string => (Math.round(v * 100) / 100).toString();

export interface RenderOptions {
  /** 每页是否输出 <svg> 外层（默认 true） */
  standalone?: boolean;
  /** 是否输出交互属性（播放高亮），默认 true */
  interactive?: boolean;
}

export function renderSvg(layout: Layout, opt: RenderOptions = {}): string {
  const pages = layout.pages.map((p, i) => renderPage(layout, p, i === 0, opt));
  if (opt.standalone === false) return pages.join('\n');
  return pages.join('\n');
}

export function renderPage(layout: Layout, page: Page, isFirst: boolean, opt: RenderOptions = {}): string {
  const th = layout.theme;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="page" data-page="${page.index}" ` +
    `viewBox="0 0 ${th.width} ${th.height}" width="${th.width}" height="${th.height}" ` +
    `font-family='${esc(th.font)}' fill="${th.ink}">`
  );
  out.push(`<rect x="0" y="0" width="${th.width}" height="${th.height}" fill="${th.paper}"/>`);
  if (isFirst) out.push(renderTitleBlock(layout));

  for (const sys of page.systems) {
    out.push(sys.section !== undefined ? renderSection(sys, th) : renderSystem(sys, layout, opt));
  }
  out.push('</svg>');
  return out.join('\n');
}

/* ------------------------------------------------------------------ 标题 */

function renderTitleBlock(layout: Layout): string {
  const { meta, key, time, tempo } = layout.doc;
  const th = layout.theme;
  const cx = th.width / 2;
  const out: string[] = [];
  const top = th.marginT;

  if (meta.title) {
    out.push(`<text class="meta-title" data-key="title" x="${n1(cx)}" y="${n1(top + 40)}" text-anchor="middle" font-size="31" font-weight="700" letter-spacing="2">${esc(meta.title)}</text>`);
  }
  if (meta.subtitle) {
    out.push(`<text class="meta-title" data-key="subtitle" x="${n1(cx)}" y="${n1(top + 68)}" text-anchor="middle" font-size="15" fill="#444">${esc(meta.subtitle)}</text>`);
  }
  const credit = [
    meta.lyricist ? `词：${meta.lyricist}` : '',
    meta.composer ? `曲：${meta.composer}` : ''
  ].filter(Boolean).join('　');
  if (credit) {
    out.push(`<text x="${n1(th.width - th.marginR)}" y="${n1(top + 68)}" text-anchor="end" font-size="14">${esc(credit)}</text>`);
  }

  const info: string[] = [];
  info.push(`1=${key.name}`);
  info.push(`${time.num}/${time.den}`);
  info.push(`♩=${tempo}`);
  if (meta.tuning) info.push(meta.tuning);
  out.push(`<text class="meta-title" data-key="info" x="${n1(th.marginL)}" y="${n1(top + 100)}" font-size="14" letter-spacing="0.5">${esc(info.join('　'))}</text>`);
  return out.join('\n');
}

/* ---------------------------------------------------------------- 段落标题 */

function renderSection(sys: System, th: Theme): string {
  return `<g class="section"><text x="${n1(th.marginL)}" y="${n1(sys.y + 20)}" font-size="14" font-weight="600" letter-spacing="1">${esc(sys.section || '')}</text></g>`;
}

/* -------------------------------------------------------------------- 行 */

/**
 * 多小节休止行（`R18`）：一条横线横贯版心，中间写「休止 18 小节」。
 * 版面上只占一行，但小节号照样吃掉 18 个 —— 分谱里二胡整段不演奏是常态。
 */
function renderRestBars(sys: System, th: Theme): string {
  const out: string[] = [`<g class="system rest" data-y="${n1(sys.y)}" data-rest="${sys.rest}">`];
  const top = th.marginL;
  const right = th.width - th.marginR;
  const cy = sys.y + sys.height * 0.62;
  const label = `休止 ${sys.rest} 小节`;
  // 估宽：汉字按字号算，数字按 0.55 字号算，够用就行（宁可留白多一点）
  let tw = 0;
  for (const ch of label) tw += /[0-9]/.test(ch) ? 13 * 0.58 : 13;
  const gap = 10;
  const lx = (top + right) / 2 - tw / 2 - gap;
  const rx = (top + right) / 2 + tw / 2 + gap;
  if (th.measureNumbers === 'system' && sys.measures.length) {
    out.push(`<text class="measure-no" x="${n1(top + 1)}" y="${n1(cy - 9)}" font-size="10" fill="#888">${sys.measures[0].measure.no}</text>`);
  }
  out.push(`<line x1="${n1(top)}" y1="${n1(cy)}" x2="${n1(lx)}" y2="${n1(cy)}" stroke="${th.ink}" stroke-width="1"/>`);
  out.push(`<line x1="${n1(rx)}" y1="${n1(cy)}" x2="${n1(right)}" y2="${n1(cy)}" stroke="${th.ink}" stroke-width="1"/>`);
  // 两端的小节线，跟正常行对齐
  out.push(`<line x1="${n1(top)}" y1="${n1(cy - 12)}" x2="${n1(top)}" y2="${n1(cy + 12)}" stroke="${th.ink}" stroke-width="1"/>`);
  out.push(`<line x1="${n1(right)}" y1="${n1(cy - 12)}" x2="${n1(right)}" y2="${n1(cy + 12)}" stroke="${th.ink}" stroke-width="1"/>`);
  out.push(`<text class="rest-label" x="${n1((top + right) / 2)}" y="${n1(cy + 4.5)}" text-anchor="middle" font-size="13">${esc(label)}</text>`);
  out.push('</g>');
  return out.join('\n');
}

function renderSystem(sys: System, layout: Layout, opt: RenderOptions): string {
  const th = layout.theme;
  if (sys.rest) return renderRestBars(sys, th);
  const out: string[] = [`<g class="system" data-y="${n1(sys.y)}">`];

  // 小节号（可核对用，默认不印）
  if (th.measureNumbers === 'system' && sys.measures.length) {
    const first = sys.measures[0];
    out.push(`<text class="measure-no" x="${n1(first.x + 1)}" y="${n1(sys.y + th.noteBaseline - 30)}" ` +
      `font-size="10" fill="#888">${first.measure.no}</text>`);
  }

  // 小节线 + 音符
  for (let mi = 0; mi < sys.measures.length; mi++) {
    const pm = sys.measures[mi];
    out.push(`<g class="measure">`);

    // 房子（跳跃反复）：从本小节起画一条上括线，到下一处房子 / 反复结束 / 行末为止
    if (pm.measure.fangzi) {
      const { x1, x2 } = fangziSpan(sys.measures, mi);
      const fy = sys.y + th.noteBaseline - 42;
      out.push(`<g class="fangzi">`);
      out.push(`<line x1="${n1(x1)}" y1="${n1(fy)}" x2="${n1(x2)}" y2="${n1(fy)}" stroke="${th.ink}" stroke-width="1"/>`);
      out.push(`<line x1="${n1(x1)}" y1="${n1(fy)}" x2="${n1(x1)}" y2="${n1(fy + 9)}" stroke="${th.ink}" stroke-width="1"/>`);
      out.push(`<text x="${n1(x1 + 4)}" y="${n1(fy - 3)}" font-size="11">${esc(pm.measure.fangzi)}</text>`);
      out.push(`</g>`);
    }

    // 行内拍号变换
    if (pm.measure.meter) {
      out.push(`<text class="meter" x="${n1(pm.x + 2)}" y="${n1(sys.y + th.noteBaseline - 28)}" font-size="12">${esc(pm.measure.meter)}</text>`);
    }

    for (const pn of pm.notes) out.push(renderNote(pn, th, opt));
    out.push(renderBarline(pm.x + pm.width - 2, sys, pm.measure.close, pm.measure.open, th));
    out.push(`</g>`);
  }

  out.push(renderBeams(sys, layout.doc.time, th));
  out.push(renderArcs(sys, th));
  out.push(renderLyrics(sys, th));
  out.push('</g>');
  return out.join('\n');
}

function renderNote(pn: PlacedNote, th: Theme, opt: RenderOptions): string {
  const n = pn.note;
  const { x, y } = pn;
  const fs = th.noteSize;
  const attrs = opt.interactive !== false ? ` data-idx="${n.idx}"` : '';
  const g: string[] = [`<g class="note kind-${n.kind}"${attrs}>`];

  // 倚音
  n.graces.forEach((gr, i) => {
    const gx = x - 15 - (n.graces.length - 1 - i) * 11;
    g.push(`<text x="${n1(gx)}" y="${n1(y - 13)}" text-anchor="middle" font-size="14" font-style="italic">${digitOf(gr.digit)}</text>`);
    g.push(`<line x1="${n1(gx - 7)}" y1="${n1(y - 3)}" x2="${n1(gx + 7)}" y2="${n1(y - 18)}" stroke="${th.ink}" stroke-width="0.9"/>`);
    g.push(dotsOf(gr.oct, gx, y - 13, 14, th));
  });

  const glyph = n.kind === 'noise' ? '×' : String(n.digit);
  const baseline = n.kind === 'rest' ? y + 1 : y;
  g.push(`<text x="${n1(x)}" y="${n1(baseline)}" text-anchor="middle" font-size="${fs}" font-weight="${n.kind === 'rest' ? 400 : 700}">${glyph}</text>`);

  if (n.acc !== 0) {
    g.push(`<text x="${n1(x - 13)}" y="${n1(y - 2)}" text-anchor="middle" font-size="19">${n.acc > 0 ? '♯' : '♭'}</text>`);
  }

  // 八度点（高音点在字上方，低音点在字下方；有减时线时要躲到线下面）
  g.push(dotsOf(n.oct, x, y, fs, th, n.slash));

  // 附点
  for (let k = 0; k < n.dots; k++) {
    g.push(`<circle cx="${n1(x + fs * 0.42 + 3 + k * 4.6)}" cy="${n1(y - fs * 0.30)}" r="1.9" fill="${th.ink}"/>`);
  }

  // 增时线
  for (let k = 0; k < n.dashes; k++) {
    const dx = x + pn.slotW * (1 + k);
    g.push(`<line x1="${n1(dx - 8)}" y1="${n1(y - fs * 0.33)}" x2="${n1(dx + 8)}" y2="${n1(y - fs * 0.33)}" stroke="${th.ink}" stroke-width="2.2"/>`);
  }

  // 后倚音
  n.gracesAfter.forEach((gr, i) => {
    const gx = x + 16 + i * 11;
    g.push(`<text x="${n1(gx)}" y="${n1(y - 13)}" text-anchor="middle" font-size="14" font-style="italic">${digitOf(gr.digit)}</text>`);
    g.push(`<line x1="${n1(gx - 7)}" y1="${n1(y - 3)}" x2="${n1(gx + 7)}" y2="${n1(y - 18)}" stroke="${th.ink}" stroke-width="0.9"/>`);
  });

  // 记号。弦位（内/外）优先于指法（宀一二三四）：两个都标的时候只显示弦位，
  // 源码里的 @ 一个都不删，取消弦位后指法自己回来。
  const HAND_MARKS = new Set(['nei', 'wai']);
  const FINGER_MARKS = new Set(['0', '1', '2', '3', '4']);
  // 手写 `@1@2@nei@wai` 这种，每组只让最后一个说了算（编辑器那边已经互斥，
  // 这里兜住手写和旧文件）
  const keepLastOfGroup = (arr: string[], inGroup: (m: string) => boolean) => {
    const idx = arr.map((m, i) => (inGroup(m) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return arr;
    const last = idx[idx.length - 1];
    return arr.filter((m, i) => !inGroup(m) || i === last);
  };
  const deduped = keepLastOfGroup(keepLastOfGroup(n.marks, (m) => FINGER_MARKS.has(m)),
                                  (m) => HAND_MARKS.has(m));
  const marks = deduped.some((m) => HAND_MARKS.has(m))
    ? deduped.filter((m) => !FINGER_MARKS.has(m))
    : deduped;

  let markTop = y - fs - 14;
  marks.forEach((mk, i) => {
    const def = MARK_MAP[mk];
    if (!def) return;
    const my = y - fs - 14 - i * 13;
    markTop = my;
    if (mk === 'la' || mk === 'tui') {
      // 弓法：拉弓 ∏、推弓 ∨，画成线条。用字形的话，缺 ㄇ(U+3107) 的字体上会变成空白/豆腐块，
      // 而这是二胡谱最要紧的记号之一，不能赌字体。
      g.push(bowMark(mk, x, my, fs, th));
    } else {
      // 指法/弦位是「小字」，比弓法记号再小一号；重音要加粗才看得见
      const fsz = mk === 'tr' ? 11 : FINGER_MARKS.has(mk) || HAND_MARKS.has(mk) ? 12 : def.bold ? 15 : 13;
      const fb = def.bold ? ' font-weight="700"' : '';
      g.push(`<text class="mark mark-${mk}" x="${n1(x)}" y="${n1(my)}" text-anchor="middle" font-size="${fsz}"${fb}>${esc(def.s)}</text>`);
    }
  });

  // 乐谱内文字（JPW-ABC 的标准文字），压在记号上方一行
  if (n.text) {
    const ty = (marks.length ? markTop - 13 : y - fs - 14);
    g.push(`<text class="note-text" x="${n1(x)}" y="${n1(ty)}" text-anchor="middle" font-size="12" fill="#333">${esc(n.text)}</text>`);
  }

  g.push('</g>');
  return g.join('');
}

/**
 * 八度点。`slash` 是减时线层数：低音点必须让到减时线下面，
 * 否则八分音符的低音点会正好压在减时线上。
 * 减时线的 y 见 renderBeams：y + 7 + (lv-1) * 4.6。
 */
function dotsOf(oct: number, x: number, y: number, fs: number, th: Theme, slash = 0): string {
  if (!oct) return '';
  const o: string[] = [];
  const r = 2.2;                                   // 屏幕上直径 4.4px，打印 @300dpi 约 1.2mm
  if (oct > 0) {
    for (let k = 0; k < oct; k++) {
      o.push(`<circle cx="${n1(x)}" cy="${n1(y - fs * 1.04 - k * 6.2)}" r="${r}" fill="${th.ink}"/>`);
    }
  } else {
    // 低音点：没有减时线时紧贴字底，有减时线时要让到线下面，别压线
    const below = slash > 0 ? 12.2 + (slash - 1) * 4.6 : fs * 0.29;
    for (let k = 0; k < -oct; k++) {
      o.push(`<circle cx="${n1(x)}" cy="${n1(y + below + k * 6.2)}" r="${r}" fill="${th.ink}"/>`);
    }
  }
  return o.join('');
}

/**
 * 弓法记号：拉弓 ∏（下弓）、推弓 ∨（上弓）。
 *
 * 尺寸按「和数字差不多高」定：宽约 0.56 字高、高约 0.48 字高，接近方形。
 * 太小（曾经只有 0.32 字高）在谱面上像一颗斑点，看不清是 ∏ 还是 ∨。
 * (x, y) 是记号行的文字基线，符号整体压在基线上方。
 */
function bowMark(kind: 'la' | 'tui', x: number, y: number, fs: number, th: Theme): string {
  const w = Math.max(3.8, fs * 0.28);     // 半宽（总宽 ≈0.56 字高）
  const h = Math.max(5.0, fs * 0.48);     // 高
  const top = y - fs * 0.54;              // 顶边略高于文字字面
  const sw = Math.max(1.2, fs * 0.085);   // 线宽
  const st = `stroke="${th.ink}" stroke-width="${n1(sw)}" stroke-linecap="round" fill="none"`;
  const out: string[] = [`<g class="mark mark-${kind}">`];
  if (kind === 'la') {
    // ∏：上横 + 左右两竖
    out.push(`<path d="M${n1(x - w)} ${n1(top + h)}V${n1(top)}H${n1(x + w)}V${n1(top + h)}" ${st}/>`);
  } else {
    // ∨
    out.push(`<path d="M${n1(x - w)} ${n1(top)}L${n1(x)} ${n1(top + h)}L${n1(x + w)} ${n1(top)}" ${st}/>`);
  }
  out.push('</g>');
  return out.join('');
}

const digitOf = (d: number): string => (d <= 0 ? '0' : String(d));

/**
 * 房子的水平跨度：从本小节左边界，到「下一处房子起点 / 反复结束 / 行末」。
 * 房子是跨小节的，排版前算不出宽度，所以只能在摆放完成后再量。
 */
function fangziSpan(ms: PlacedMeasure[], i: number): { x1: number; x2: number } {
  const pm = ms[i];
  const x1 = pm.x;
  let x2 = pm.x + pm.width;
  for (let j = i; j < ms.length; j++) {
    const m = ms[j];
    x2 = m.x + m.width;
    if (j > i && m.measure.fangzi) { x2 = m.x; break; }
    if (m.measure.close === ':|' || m.measure.sectionEnd) break;
  }
  return { x1, x2 };
}

function renderBarline(x: number, sys: System, kind: string | null, open: boolean, th: Theme): string {
  const top = sys.y + th.noteBaseline - 26;
  const bot = sys.y + th.noteBaseline + 8;
  const out: string[] = [];
  const line = (xx: number, w: number) =>
    `<line x1="${n1(xx)}" y1="${n1(top)}" x2="${n1(xx)}" y2="${n1(bot)}" stroke="${th.ink}" stroke-width="${w}"/>`;

  if (open) {
    out.push(line(x - 5, 2.6), line(x - 1.5, 0.9));
    out.push(`<circle cx="${n1(x + 2.5)}" cy="${n1(top + 11)}" r="1.6" fill="${th.ink}"/>`);
    out.push(`<circle cx="${n1(x + 2.5)}" cy="${n1(bot - 11)}" r="1.6" fill="${th.ink}"/>`);
  }
  switch (kind) {
    case ':|':
      out.push(`<circle cx="${n1(x - 7)}" cy="${n1(top + 11)}" r="1.6" fill="${th.ink}"/>`);
      out.push(`<circle cx="${n1(x - 7)}" cy="${n1(bot - 11)}" r="1.6" fill="${th.ink}"/>`);
      out.push(line(x - 3, 0.9), line(x, 2.6));
      break;
    case '||':
      out.push(line(x - 4, 1.4), line(x, 1.4));
      break;
    case '|]':
      out.push(line(x - 4, 0.9), line(x, 3.4));
      break;
    case null:
      break;
    default:
      out.push(line(x, 0.9));
  }
  return out.join('');
}

/* ------------------------------------------------------------------ 减时线 */

/**
 * 减时线（梁）分组规则：
 *  1. 一拍一组，组内主横线贯通；**拍界必须断开**——跨拍的梁会把节奏读错。
 *     这也是简谱和五线谱不一样的地方：简谱的梁是「时值说明」，不是「连接线」。
 *  2. 第二层及以下只连「减时线数 >= 该层」的连续子段：
 *     八分之间夹两个十六分时，第二条横线只覆盖那两个十六分，不落在一旁的八分下面。
 *  3. 休止符、四分及更长的音都会截断梁（本来就是这么定义的）。
 */
function renderBeams(sys: System, time: TimeSig, th: Theme): string {
  const out: string[] = [];
  const halfW = 8.6;
  // 拍组大小（以四分音符为 1）：2/4 → 1，6/8 → 1.5（附点四分一组）
  const groupBeats = time.den >= 8 && time.num % 3 === 0 ? 12 / time.den : 4 / time.den;

  for (const pm of sys.measures) {
    const notes = pm.notes;
    let pos = 0;                                  // 小节内已走过的拍数
    let i = 0;
    while (i < notes.length) {
      const n = notes[i].note;
      if (n.slash === 0 || n.kind === 'rest') { pos += n.beats; i++; continue; }

      const groupIdx = Math.floor(pos / groupBeats + 1e-9);
      const run: PlacedNote[] = [];
      let p = pos;
      let j = i;
      while (j < notes.length) {
        const nn = notes[j].note;
        if (nn.slash === 0 || nn.kind === 'rest') break;
        if (Math.floor(p / groupBeats + 1e-9) !== groupIdx) break;   // 拍界断开
        run.push(notes[j]);
        p += nn.beats;
        j++;
      }
      if (!run.length) { pos += n.beats; i++; continue; }

      const maxLv = Math.max(...run.map(r => r.note.slash));
      for (let lv = 1; lv <= maxLv; lv++) {
        let a = 0;
        while (a < run.length) {
          if (run[a].note.slash < lv) { a++; continue; }
          let b = a;
          while (b + 1 < run.length && run[b + 1].note.slash >= lv) b++;
          const yy = run[a].y + 7 + (lv - 1) * 4.6;
          out.push(`<line x1="${n1(run[a].x - halfW)}" y1="${n1(yy)}" ` +
            `x2="${n1(run[b].x + halfW)}" y2="${n1(yy)}" stroke="${th.ink}" stroke-width="1.6"/>`);
          a = b + 1;
        }
      }
      pos = p;
      i = j;
    }
  }
  return out.join('');
}

/* ------------------------------------------------------------------ 连线 */

function renderArcs(sys: System, th: Theme): string {
  const out: string[] = [];
  const flat = sys.measures.flatMap(pm => pm.notes);
  let openSlur: number | null = null;

  flat.forEach((pn, i) => {
    const n = pn.note;

    if (n.tie) {
      const next = flat[i + 1];
      if (next) {
        const a = pn.x + th.noteSize * 0.34;
        const b = next.x - th.noteSize * 0.34;
        const y = pn.y - th.noteSize * 0.72;
        out.push(arc(a, y, b, y, -7));
      }
    }
    if (n.slurOpen) openSlur = i;
    if (n.slurClose && openSlur !== null) {
      const a = flat[openSlur].x;
      const b = pn.x;
      const dist = Math.abs(b - a);
      const h = -12 - Math.min(20, dist * 0.05);
      out.push(arc(a - 6, flat[openSlur].y - th.noteSize * 1.05, b + 6, pn.y - th.noteSize * 1.05, h));
      openSlur = null;
    }
  });
  return out.join('');
}

function arc(x1: number, y1: number, x2: number, y2: number, h: number): string {
  const mx = (x1 + x2) / 2;
  return `<path class="arc" d="M${n1(x1)},${n1(y1)} Q${n1(mx)},${n1(Math.min(y1, y2) + h * 2)} ${n1(x2)},${n1(y2)}" fill="none" stroke="#111" stroke-width="1.1"/>`;
}

/* ------------------------------------------------------------------ 歌词 */

function renderLyrics(sys: System, th: Theme): string {
  if (!sys.hasLyrics) return '';
  const out: string[] = [`<g class="lyrics">`];
  for (const pm of sys.measures) {
    for (const pn of pm.notes) {
      const t = pn.note.lyric;
      if (!t) continue;
      out.push(`<text x="${n1(pn.x)}" y="${n1(pn.y + 30)}" text-anchor="middle" font-size="${th.lyricSize}">${esc(t)}</text>`);
    }
  }
  out.push('</g>');
  return out.join('');
}

/** 整体宽度（用于 web 预览缩放） */
export function pageWidth(layout: Layout): number { return layout.theme.width; }
export { measureWidth };
