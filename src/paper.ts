/**
 * 纸张与方向。
 *
 * 谱面坐标系用 CSS px @96dpi（A4 竖版 = 794×1123，正好对应 2480×3508 @300dpi 的
 * 出版谱扫描件），所以 mm 换算时统一乘 96/25.4。
 *
 * 版心边距**按幅面等比缩放**：A4 竖版实测左右各 62 单位（§文档 04），
 * 换到 A5 就按 62 × (A5宽/A4宽) 缩，这样任何纸型的版心占宽比都一样，不会出现
 * 小纸型上边距把版心挤没的情况。
 *
 * 字号（noteSize）和小节槽宽（slot）**不随纸型缩放**：物理尺寸不变，
 * 换更小的纸只是每行放得下的小节变少、行数变多。
 */
import type { Theme } from './types.js';
import { defaultTheme } from './layout.js';

/** 纸张短边 × 长边（mm） */
export const PAPERS: Record<string, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  B5: [176, 250],
  Letter: [215.9, 279.4],
};

export const PAPER_NAMES = Object.keys(PAPERS);

export type Orientation = 'portrait' | 'landscape';

const MM = 96 / 25.4;      // 1mm = 3.7795 px
const A4_W = PAPERS.A4[0] * MM;

/** 归一化用户写的纸型名：`a5`、`A5`、`a5纸` 都认 */
export function normalizePaper(p?: string): string {
  const t = (p || '').trim().replace(/纸$/, '');
  if (!t) return 'A4';
  const hit = PAPER_NAMES.find((n) => n.toLowerCase() === t.toLowerCase());
  return hit || 'A4';
}

export function normalizeOrientation(o?: string): Orientation {
  return /^(landscape|l|横|横向|横版)$/i.test((o || '').trim()) ? 'landscape' : 'portrait';
}

/** 生成某个纸型的 theme（在 A4 竖版基准上等比缩边距） */
export function paperTheme(paper = 'A4', orientation: Orientation = 'portrait',
                           over: Partial<Theme> = {}): Theme {
  const base = defaultTheme();
  const name = normalizePaper(paper);
  const [sw, sl] = PAPERS[name] || PAPERS.A4;   // 短边、长边
  let wmm = sw, hmm = sl;
  if (orientation === 'landscape') { wmm = sl; hmm = sw; }

  const width = Math.round(wmm * MM);
  const height = Math.round(hmm * MM);
  const k = width / A4_W;

  return {
    ...base,
    width,
    height,
    marginL: Math.round(base.marginL * k),
    marginR: Math.round(base.marginR * k),
    marginT: Math.round(base.marginT * k),
    marginB: Math.round(base.marginB * k),
    ...over,
  };
}
