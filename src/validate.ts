/**
 * 校验：拍数、记号、连音线配对、音域提示
 */
import type { Doc, Warning } from './types.js';
import { MARK_MAP } from './pitch.js';

export interface ValidateOptions {
  /** 是否把拍数不符当错误，默认 warn */
  strictBeats?: boolean;
  /** 忽略最后一个小节的拍数检查（弱起/不完整小节） */
  allowPickup?: boolean;
}

export function validate(doc: Doc, opt: ValidateOptions = {}): Warning[] {
  const out: Warning[] = [...doc.warnings];
  const { time } = doc;

  doc.items.forEach(item => {
    if (item.kind !== 'music') return;
    const lastIdx = item.measures.length - 1;
    // 行内拍号只写在变换那一小节，后面的小节沿用，直到下一次变换
    let curNum = time.num, curDen = time.den, curBeats = time.beats;
    item.measures.forEach((m, mi) => {
      if (m.restBars) return;      // 多小节休止：本来就没音符，别报空小节
      if (!m.notes.length) {
        out.push({
          level: 'warn',
          message: `第 ${m.no} 小节是空小节（本声部休止请写 0 0，别留空）`,
          line: item.line
        });
        return;
      }
      // 行内拍号变换后，本小节及后续小节的拍数基准都要跟着换，否则一变拍号满屏报错
      if (m.meter && /^\d+\/\d+$/.test(m.meter)) {
        const [a, b] = m.meter.split('/').map(Number);
        if (a > 0 && b > 0) { curNum = a; curDen = b; curBeats = a * 4 / b; }
      }
      const num = curNum, den = curDen, want = curBeats;
      const diff = Math.abs(m.beats - want);
      const isPickup = (mi === 0 || mi === lastIdx) && opt.allowPickup !== false;
      if (diff > 1e-6 && !(isPickup && m.beats <= want)) {
        out.push({
          level: opt.strictBeats ? 'error' : 'warn',
          message: `第 ${m.no} 小节拍数为 ${round(m.beats)}，拍号 ${num}/${den} 应为 ${round(want)}`,
          line: item.line
        });
      }
      for (const n of m.notes) {
        for (const mk of n.marks) {
          if (!(mk in MARK_MAP)) {
            out.push({ level: 'warn', message: `未知记号 @${mk}`, line: item.line });
          }
        }
      }
    });

  });

  // 连音线配对要按全曲算，不能一行一算：
  // JPW-ABC 和实际手写谱都经常把一条连弓拆在几行里（`( 5__6__ |:` … 下一行才 `)`）。
  let open = 0;
  let openLine = 0;
  for (const it of doc.items) {
    if (it.kind !== 'music') continue;
    for (const m of it.measures) {
      for (const n of m.notes) {
        if (n.slurOpen) { if (open === 0) openLine = it.line; open++; }
        if (n.slurClose) open--;
        if (open < 0) {
          out.push({ level: 'warn', message: '圆滑线多了一个右括号 )', line: it.line });
          open = 0;
        }
      }
    }
  }
  if (open > 0) out.push({ level: 'warn', message: '圆滑线没有闭合，缺少 )', line: openLine });

  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
