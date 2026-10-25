/**
 * 排版引擎：Doc AST → 页面 / 行 / 坐标
 * 纯函数，不碰 DOM，可以在 Node 里跑（CLI 出 SVG）。
 */
import type {
  Doc, Layout, Measure, MusicItem, Note, Page, PlacedMeasure, PlacedNote, System, Theme
} from './types.js';

export function defaultTheme(over: Partial<Theme> = {}): Theme {
  return {
    width: 794,            // A4 @96dpi
    height: 1123,
    marginL: 62,
    marginR: 62,
    marginT: 50,
    marginB: 64,
    slot: 50,
    noteSize: 18.7,
    lyricSize: 16,
    noteBaseline: 40,
    systemH: 96,
    systemHNoLyric: 76,
    sectionGap: 34,
    ink: '#111',
    paper: '#ffffff',
    font: '"Noto Serif CJK SC","Source Han Serif SC","Songti SC",serif',
    measureNumbers: 'none',
    ...over
  };
}

/**
 * 音符占几个「四分音符槽」。
 *
 * 模型是拿 2480×3508（A4@300dpi）的出版谱反解的，不是拍的。
 * 出版谱每行都两端对齐，行内所有间距被同一个比例 s 拉伸，所以先按
 * "无拍边界、不跨小节"的相邻音分组，用 d(八分) - d(十六分) 反解：
 *
 *   相邻音左边界距离 = (M + d_i/2 + d_j/2) × s
 *
 * 四行独立算出来 M 全部≈0（-1、-1、0、0 px），也就是**没有固定最小占位**，
 * 纯按时值比例排。s 各行不同（232/192/220/232 px/拍），正是两端对齐的拉伸。
 * 拍边界额外留白也是四行一致：0.130/0.130/0.130/0.129 slot。
 *
 * 早先用 max(beats, 下限) 会让八分和十六分只差 1.13 倍，而原谱差 1.54 倍，
 * 密集处越排越紧；加了 26px 常数项又反过来让八分偏窄。都不对。
 */
const MIN_SLOT = 0;          // 实测无固定项：纯按时值比例
const BEAT_GAP_SLOT = 0.13;  // 拍边界额外留白（四行实测 0.129–0.134）

export function noteUnits(n: Note): number {
  return MIN_SLOT + Math.max(0, n.beats);
}

/** 走一遍小节里的音符：每个音的占位宽，以及它前面要不要加拍间隙。 */
export function noteSlots(m: Measure, th: Theme, slotW: number):
    { w: number; gapBefore: number }[] {
  const out: { w: number; gapBefore: number }[] = [];
  let t = 0;
  m.notes.forEach((n, i) => {
    const lyricW = n.lyric ? n.lyric.length * th.lyricSize + 3 : 0;
    // 时值占位是唯一的间距依据（原谱无固定项），只兜住"字形不能重叠"
    const w = Math.max(noteUnits(n) * slotW, th.noteSize * 0.6, lyricW);
    const onBeat = Math.round(t) > 0 && Math.abs(t - Math.round(t)) < 1e-6;
    out.push({ w, gapBefore: i > 0 && onBeat ? BEAT_GAP_SLOT * slotW : 0 });
    t += n.beats;
  });
  return out;
}

const PAD = 3.2;           // 小节线两侧留白（原谱实测仅约 10px）

export function measureWidth(m: Measure, th: Theme): number {
  let w = 0;
  for (const s of noteSlots(m, th, th.slot)) w += s.w + s.gapBefore;
  return w + PAD * 2 + (m.close && m.close !== '|' ? 12 : 0);
}

interface Row {
  kind: 'music' | 'section';
  text?: string;
  measures: Measure[];
  hasLyrics: boolean;
  /** 多小节休止（R18）：整行独占，中间写小节数 */
  rest?: number;
}

function toRows(doc: Doc): Row[] {
  const rows: Row[] = [];
  for (const item of doc.items) {
    if (item.kind === 'section') {
      rows.push({ kind: 'section', text: item.text, measures: [], hasLyrics: false });
      continue;
    }
    const it = item as MusicItem;
    // 多小节休止永远独占一行：它没有音符，混在乐谱行里既算不出宽度也画不出小节线
    if (it.measures.length === 1 && it.measures[0].restBars) {
      rows.push({ kind: 'music', measures: it.measures, hasLyrics: false, rest: it.measures[0].restBars });
      continue;
    }
    rows.push({
      kind: 'music',
      measures: it.measures,
      hasLyrics: it.measures.some(m => m.notes.some(n => !!n.lyric))
    });
  }
  return rows;
}

/** 把一条用户书写的乐谱行按页宽拆成若干视觉行 */
function wrap(measures: Measure[], th: Theme, contentW: number): Measure[][] {
  // 允许轻微压缩：自然宽超版心 3% 以内仍然排进这一行，靠 justify 收回来。
  // 没有这个容差，差几个单位就会提前断行，整行被拉伸得和原谱对不上。
  const LIMIT = contentW * 1.03;

  const fill = (cap: number): Measure[][] => {
    const out: Measure[][] = [];
    let cur: Measure[] = [];
    let w = 0;
    for (const m of measures) {
      const mw = measureWidth(m, th);
      if (cur.length && w + mw > cap) {
        out.push(cur); cur = []; w = 0;
      }
      cur.push(m);
      w += mw;
    }
    if (cur.length) out.push(cur);
    return out;
  };

  const greedy = fill(LIMIT);
  if (greedy.length <= 1) return greedy;

  /*
   * 贪心断行会把"剩一小截"留到最后一行（6 小节挤成 5+1，很难看）。
   * 改成先以贪心的行数为目标，把可用宽度均摊后重新装一遍：
   * 从 total/k 开始逐步放宽容差，直到行数不再超过 k。各行的宽度就基本均衡了。
   */
  const k = greedy.length;
  const total = measures.reduce((a, m) => a + measureWidth(m, th), 0);
  let cap = total / k;
  for (let i = 0; i < 40; i++) {
    const parts = fill(Math.min(cap, LIMIT));
    if (parts.length <= k) return parts;
    cap += Math.max(4, contentW * 0.01);
  }
  return greedy;
}

/** 行距倍率：frontmatter 的 spacing / linegap，1 = 默认。夹在 0.5–1.8 之间（下限由 layout 的硬底兜住）。 */
export function lineGapOf(doc: Doc): number {
  const raw = Number(doc.meta.spacing ?? doc.meta.linegap);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(0.5, Math.min(1.8, raw));
}

export function layout(doc: Doc, theme: Theme = defaultTheme()): Layout {
  const th = theme;
  const contentW = th.width - th.marginL - th.marginR;
  const rows = toRows(doc);
  // 行距（frontmatter spacing）整体缩放行高，但每行有硬底：再压下去低音点
  // 会撞到下一行。硬底来自实际内容高度 —— 音符基线 noteBaseline(40) 往下
  // 还有减时线和最多 3 个低音点（≈24）→ 无歌词 67；有歌词再加歌词行（≈13）→ 80。
  const gap = lineGapOf(doc);
  const systemHeight = (hasLyrics: boolean) => {
    const base = hasLyrics ? th.systemH : th.systemHNoLyric;
    const floor = hasLyrics ? 80 : 67;
    return Math.max(floor, base * gap);
  };

  const pages: Page[] = [];
  let page: Page = { index: 0, systems: [] };
  pages.push(page);

  const hasTitle = !!(doc.meta.title || doc.meta.subtitle);
  let y = th.marginT + (hasTitle ? titleHeight(doc) : 0);

  const newPage = () => {
    page = { index: pages.length, systems: [] };
    pages.push(page);
    y = th.marginT;
  };

  for (const row of rows) {
    if (row.kind === 'section') {
      const need = th.sectionGap * gap + 10;
      if (y + need > th.height - th.marginB) newPage();
      page.systems.push({
        y, measures: [], hasLyrics: false, height: need, section: row.text
      });
      y += need;
      continue;
    }

    if (row.rest) {
      const h = Math.max(34, th.systemHNoLyric * 0.52);
      if (y + h > th.height - th.marginB) newPage();
      page.systems.push({
        y, rest: row.rest, hasLyrics: false, height: h,
        measures: [{ measure: row.measures[0], x: th.marginL, width: contentW, notes: [] }]
      });
      y += h;
      continue;
    }

    const chunks = wrap(row.measures, th, contentW);
    chunks.forEach((chunk, ci) => {
      const h = systemHeight(row.hasLyrics);
      if (y + h > th.height - th.marginB) newPage();

      const nat = chunk.map(m => measureWidth(m, th));
      const totalNat = nat.reduce((a, b) => a + b, 0);
      // 出版简谱每一行都撑满版心，只有"被挤到下一行的最后几个小节"例外：
      // 那一小截硬拉会散得很难看，左对齐更像真谱。
      // 注意两条防线：必须该行真的换过行（chunks.length > 1），否则一整行
      // 单独成段时会被误判成末段、整行不撑满；再配一个 1.6 的阈值。
      let scale = contentW / totalNat;
      const isTail = chunks.length > 1 && ci === chunks.length - 1;
      if (isTail && scale > 1.6) scale = 1;
      if (scale > 2.0) scale = 1;
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;

      const placed: PlacedMeasure[] = [];
      let x = th.marginL;
      for (let k = 0; k < chunk.length; k++) {
        const m = chunk[k];
        const w = nat[k] * scale;
        placed.push({
          measure: m,
          x,
          width: w,
          notes: placeNotes(m, x, y + th.noteBaseline, scale * th.slot, th)
        });
        x += w;
      }
      page.systems.push({ y, measures: placed, hasLyrics: row.hasLyrics, height: h });
      y += h;
    });
  }

  for (const p of pages) { p.width = th.width; p.height = th.height; }
  return { doc, pages, theme: th };
}

function titleHeight(doc: Doc): number {
  let h = 84;
  if (doc.meta.subtitle) h += 22;
  return h + 34;                                  // 调号/拍号行
}

function placeNotes(m: Measure, x0: number, baseline: number, slotW: number, th: Theme): PlacedNote[] {
  const out: PlacedNote[] = [];
  let cursor = x0 + PAD;
  const slots = noteSlots(m, th, slotW);
  m.notes.forEach((n, i) => {
    cursor += slots[i].gapBefore;
    const w = slots[i].w;
    const isMulti = n.dashes > 0;
    const cx = isMulti ? cursor + slotW * 0.5 : cursor + w / 2;
    out.push({ note: n, x: cx, y: baseline, slotW });
    cursor += w;
  });
  return out;
}

/** 播放时间轴用：按顺序展平所有音符（含跨行） */
export function flatten(doc: Doc): Note[] {
  return doc.items.flatMap(it => it.kind === 'music'
    ? it.measures.flatMap(m => m.notes)
    : []);
}
