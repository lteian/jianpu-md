/**
 * jianpu-md —— 数据模型
 *
 * 设计原则：AST 只描述「音乐」，不含任何像素/坐标；
 * 坐标在 layout 阶段计算，字符串序列化在 render 阶段完成。
 * 这样同一份 AST 可以同时喂给 SVG 渲染器、WebAudio 播放器和 CLI。
 */

/** 装饰音（倚音） */
export interface GraceNote {
  digit: number;
  acc: number;
  oct: number;
  slash: number;
  dots: number;
}

/** 一个音符 / 休止符 */
export interface Note {
  /** note = 有音高；rest = 休止；noise = 噪音(x) */
  kind: 'note' | 'rest' | 'noise';
  /** 1..7，休止符为 0，噪音为 -1 */
  digit: number;
  /** 变音记号带来的半音偏移：-2..2，0 表示无 */
  acc: number;
  /** 八度点数，正数=高音点在上，负数=低音点在下 */
  oct: number;
  /** 减时线层数（/ 的个数） */
  slash: number;
  /** 增时线个数（- 的个数） */
  dashes: number;
  /** 附点个数 */
  dots: number;
  /** 总拍数（以四分音符为 1） */
  beats: number;
  /** 二胡/表情记号，如 la / tui / 2 / tr */
  marks: string[];
  /** 到下一个同音高的延音线 */
  tie: boolean;
  /** 圆滑线（连弓）起点 */
  slurOpen: boolean;
  /** 圆滑线终点 */
  slurClose: boolean;
  /** 前倚音 */
  graces: GraceNote[];
  /** 后倚音 */
  gracesAfter: GraceNote[];
  /** 歌词（单字/音节） */
  lyric: string;
  /** 乐谱内文字（JPW-ABC 的 "…" 标准文字），印在音符上方 */
  text?: string;
  /** 全局序号，播放高亮用 */
  idx: number;
  /** 源位置，报错用 */
  line: number;
  col: number;
}

/** 一小节 */
export interface Measure {
  notes: Note[];
  /** 实际拍数 */
  beats: number;
  /**
   * 显式小节号（全曲连号，含空小节）。
   * 必须存下来，不能靠数组下标现推：总谱里删掉/补上空小节后，
   * 下标全漂，「第 35 小节不对」这种反馈就失效了。
   */
  no: number;
  /** 反复开始记号 */
  open: boolean;
  /** 小节线类型：| |: :| || |] */
  close: string | null;
  /**
   * 房子（跳跃反复）起始标记的文字，如 `1.` `2.`。
   * 起点写在小节线后面：`|[1. …  :|[2. …`。
   * 宽度要等排版时才知道，所以这里只存文字，跨度由 layout 算。
   */
  fangzi?: string;
  /** 行内拍号变换，如 `7/8`（JPW-ABC 允许把拍号当符号插在乐章中间） */
  meter?: string;
  /** 段落标记 `$`：终止本段但不结束全曲 */
  sectionEnd?: boolean;
  /**
   * 多小节休止：`R18` 表示「接下来 18 个小节这个声部不演奏」。
   * 只占版面上的一行，但要把 18 个小节号吃掉，否则后面的小节号全错。
   * 值就是被吃掉的小节数。
   */
  restBars?: number;
}

export interface SectionItem {
  kind: 'section';
  text: string;
  line: number;
}

export interface MusicItem {
  kind: 'music';
  measures: Measure[];
  line: number;
}

export type Item = SectionItem | MusicItem;

export interface Meta {
  title?: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  key?: string;
  time?: string;
  tempo?: string;
  tuning?: string;
  instrument?: string;
  [k: string]: string | undefined;
}

export interface KeySig {
  /** 原始写法，如 1=F */
  text: string;
  /** 调名，如 F / Bb */
  name: string;
  /** 主音相对 C 的半音数 */
  semi: number;
  /** 小调写法 6=X */
  minor: boolean;
}

export interface TimeSig {
  num: number;
  den: number;
  /** 每小节拍数（以四分音符为 1 计） */
  beats: number;
}

export interface Warning {
  level: 'warn' | 'error';
  message: string;
  line: number;
}

export interface Doc {
  meta: Meta;
  key: KeySig;
  time: TimeSig;
  tempo: number;
  items: Item[];
  warnings: Warning[];
}

/* ---------------------------------------------------------------- 排版结果 */

export interface PlacedNote {
  note: Note;
  /** 数字中心 x */
  x: number;
  /** 数字基线 y */
  y: number;
  /** 该音符占用的槽宽（已按行缩放） */
  slotW: number;
}

export interface PlacedMeasure {
  measure: Measure;
  x: number;
  width: number;
  notes: PlacedNote[];
}

export interface System {
  y: number;
  measures: PlacedMeasure[];
  hasLyrics: boolean;
  /** 段落标题（此行为某段首行时） */
  section?: string;
  height: number;
  /** 多小节休止行（`R18`）：整行画一条线，中间写小节数 */
  rest?: number;
}

export interface Page {
  index: number;
  systems: System[];
  width?: number;
  height?: number;
}

export interface Theme {
  width: number;
  height: number;
  marginL: number;
  marginR: number;
  marginT: number;
  marginB: number;
  /** 一个四分音符的基本槽宽 */
  slot: number;
  /** 数字字号 */
  noteSize: number;
  /** 歌词字号 */
  lyricSize: number;
  /** 行内音符基线相对行顶的偏移 */
  noteBaseline: number;
  /** 有歌词时的行高 */
  systemH: number;
  /** 无歌词时的行高 */
  systemHNoLyric: number;
  /** 行距（同一页内两行之间） */
  sectionGap: number;
  ink: string;
  paper: string;
  font: string;
  /** 是否在每行首小节上方印小节号：none（默认）/ system */
  measureNumbers: 'none' | 'system';
}

export interface Layout {
  doc: Doc;
  pages: Page[];
  theme: Theme;
}
