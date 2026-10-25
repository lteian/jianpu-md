/**
 * 调号、拍号与音高换算
 */
import type { KeySig, TimeSig, Note } from './types.js';

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 音名 → 半音数（供外部做转调计算） */
export const KEY_SEMI: Record<string, number> = LETTER;

/** 首调唱名 → 半音数（下标即数字） */
export const DEGREE_SEMI = [0, 0, 2, 4, 5, 7, 9, 11];

/** 解析 1=F / 6=F# / bB 之类的调号写法 */
export function parseKey(raw?: string): KeySig {
  const text = (raw || '1=C').trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/＃/g, '#');
  let minor = false;
  let body = text;
  const eq = text.lastIndexOf('=');
  if (eq >= 0) {
    const lhs = text.slice(0, eq).trim();
    minor = lhs === '6' || lhs === '6m' || lhs === 'A';
    body = text.slice(eq + 1).trim();
  }
  const m = /^([b#]*)([A-Ga-g])$/.exec(body);
  let semi = 0;
  let name = 'C';
  if (m) {
    const acc = m[1];
    name = acc + m[2].toUpperCase();
    semi = LETTER[m[2].toUpperCase()] ?? 0;
    for (const ch of acc) semi += ch === '#' ? 1 : -1;
  } else {
    name = body || 'C';
    semi = 0;
  }
  return { text: text || `1=${name}`, name, semi, minor };
}

/** 解析 4/4、3/4、6/8、2/4,1（弱起） */
export function parseTime(raw?: string): TimeSig {
  const text = (raw || '4/4').trim();
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(text);
  const num = m ? parseInt(m[1], 10) : 4;
  const den = m ? parseInt(m[2], 10) : 4;
  return { num, den, beats: (num * 4) / den };
}

/**
 * 音符 → MIDI 音高。1 的基准音高为 C4(60) + 调号偏移，
 * 例如 1=C → 1 是 60，1=F → 1 是 65，1=D → 62（正好是二胡内弦空弦）。
 */
export function noteToMidi(n: Pick<Note, 'kind' | 'digit' | 'acc' | 'oct'>, keySemi: number, base = 60): number | null {
  if (n.kind !== 'note' || n.digit < 1) return null;
  const deg = DEGREE_SEMI[n.digit] ?? 0;
  return base + keySemi + deg + n.acc + 12 * n.oct;
}

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** 二胡与常用表情记号 → 排版符号 */
export interface MarkDef {
  s: string;
  name: string;
  /** 画在音符上方还是下方 */
  side?: 'above' | 'below';
  /** 加粗（重音记号要看得见，13px 的细 `>` 在 A4 上太淡） */
  bold?: boolean;
}

export const MARK_MAP: Record<string, MarkDef> = {
  la: { s: '∏', name: '拉弓' },      // 渲染用矢量画（render.ts bowMark），这里的 s 只是兜底
  tui: { s: '∨', name: '推弓' },
  lian: { s: '⌒', name: '连弓' },
  dun: { s: '▼', name: '顿弓' },
  '0': { s: '宀', name: '空弦' },      // 二胡谱里空弦写作「宀」
  '1': { s: '一', name: '食指' },
  '2': { s: '二', name: '中指' },
  '3': { s: '三', name: '无名指' },
  '4': { s: '四', name: '小指' },
  nei: { s: '内', name: '内弦' },
  wai: { s: '外', name: '外弦' },
  chuo: { s: '↗', name: '绰（上滑）' },
  zhu: { s: '↘', name: '注（下滑）' },
  rou: { s: '吟', name: '吟弦（揉弦）' },
  tr: { s: 'tr', name: '打弦' },
  w: { s: '⌣', name: '上波音' },
  bw: { s: '⌢', name: '下波音' },
  o: { s: '○', name: '泛音' },
  v: { s: 'v', name: '换气' },
  '>': { s: '>', name: '重音', bold: true },
  '=': { s: '—', name: '保持音' },
  dim: { s: '<', name: '渐强' },
  dimu: { s: '>', name: '渐弱' }
};

/**
 * JPW-ABC 的技法名（拼音，见 JP-Word 4.0 手册 Voice 节）别名表。
 * 写 `{DunYin}` 与写 `@dun` 是同一个符号——小通用 JPW-ABC 写谱，
 * 我们自己的手写谱用 @短名，两边必须落到同一张符号表上。
 */
export const MARK_ALIAS: Record<string, string> = {
  DunYin: 'dun', BoYin: 'w', YanYin: '=', ChanYin: 'tr', DaYin: 'tr',
  HuanQi: 'v', ZhongYin: '>', BaoChiYin: '=', FanYin: 'o', RouYin: 'rou',
  ChuoYin: 'chuo', ZhuYin: 'zhu', LianYin: 'lian', LaGong: 'la', TuiGong: 'tui',
  顿音: 'dun', 波音: 'w', 上波音: 'w', 下波音: 'bw', 延音: '=', 颤音: 'tr',
  打音: 'tr', 泛音: 'o', 揉弦: 'rou', 吟弦: 'rou', 绰音: 'chuo', 注音: 'zhu',
  连弓: 'lian', 拉弓: 'la', 推弓: 'tui', 重音: '>', 保持音: '=', 换气: 'v',
  空弦: '0', 宀: '0', 内弦: 'nei', 外弦: 'wai'
};

/** 记号名归一化：`DunYin` / `顿音` / `dun` 都归到同一个 key */
export function normalizeMark(raw: string): string {
  const t = (raw || '').trim();
  if (!t) return t;
  if (MARK_ALIAS[t]) return MARK_ALIAS[t];
  const low = t.charAt(0).toLowerCase() + t.slice(1);
  if (MARK_ALIAS[low]) return MARK_ALIAS[low];
  return t;
}

/** 二胡常用定弦（内弦-外弦），用于显示提示 */
export const TUNING_HINT: Record<string, string> = {
  D: '1-5 弦（内 D / 外 A）',
  G: '5-2 弦（内 D / 外 G）',
  F: '6-3 弦（内 D / 外 F）',
  C: '2-6 弦（内 D / 外 C）',
  Bb: '3-7 弦（内 F / 外 C）',
  A: '4-1 弦（内 D / 外 E）'
};
