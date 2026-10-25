/**
 * jianpu-md —— 主入口
 *
 *   import { compile } from 'jianpu-md';
 *   const { svg, warnings } = compile(source);
 */
export { parse, parseMusicLine, parseNoteToken, splitSyllables, tokenize, resetNoteSeq, scanLineNotes } from './parser.js';
export type { NoteTokenRef, LineNoteSpan } from './parser.js';
export { locateNotes, applyNoteEdits, serializeToken, setSlur, durLevel, DUR_LEVELS,
  autoBarLine, rebarLines, setMeta } from './edit.js';
export type { NoteSpan, EditOp } from './edit.js';
export { validate } from './validate.js';
export { layout, lineGapOf, defaultTheme, flatten, noteUnits, measureWidth } from './layout.js';
export { PAPERS, PAPER_NAMES, paperTheme, normalizePaper, normalizeOrientation } from './paper.js';
export type { Orientation } from './paper.js';
export { renderSvg, renderPage } from './render.js';
export { buildTimeline, createVoice, schedule } from './player.js';
export { parseKey, parseTime, noteToMidi, midiToFreq, MARK_MAP, DEGREE_SEMI, KEY_SEMI, TUNING_HINT } from './pitch.js';

export type * from './types.js';
export type { PlayEvent, Timeline, Timbre, VoiceOptions } from './player.js';
export type { ValidateOptions } from './validate.js';

import { parse } from './parser.js';
import { validate, type ValidateOptions } from './validate.js';
import { layout } from './layout.js';
import { paperTheme, normalizePaper, normalizeOrientation } from './paper.js';
import { renderSvg } from './render.js';
import type { Doc, Layout, Theme, Warning } from './types.js';

export interface CompileOptions extends ValidateOptions {
  theme?: Partial<Theme>;
  /** 覆盖 front matter 里的纸型（命令行 / 工作台用） */
  paper?: string;
  /** 覆盖 front matter 里的方向 */
  orientation?: string;
}

function themeOf(doc: Doc, opt: CompileOptions): Theme {
  const paper = opt.paper ? normalizePaper(opt.paper) : normalizePaper(doc.meta.paper);
  const orient = opt.orientation ? normalizeOrientation(opt.orientation) : normalizeOrientation(doc.meta.orientation);
  return paperTheme(paper, orient, opt.theme);
}

export interface CompileResult {
  doc: Doc;
  layout: Layout;
  svg: string;
  warnings: Warning[];
}

export function compile(source: string, opt: CompileOptions = {}): CompileResult {
  const doc = parse(source);
  const warnings = validate(doc, opt);
  doc.warnings = warnings;
  const lay = layout(doc, themeOf(doc, opt));
  return { doc, layout: lay, svg: renderSvg(lay), warnings };
}

/** 只出版面，不出 SVG 字符串（给需要自己序列化的场景，比如 React） */
export function compileLayout(source: string, opt: CompileOptions = {}): CompileResult {
  const doc = parse(source);
  const warnings = validate(doc, opt);
  doc.warnings = warnings;
  const lay = layout(doc, themeOf(doc, opt));
  return { doc, layout: lay, svg: '', warnings };
}

export const VERSION = '0.1.0';
