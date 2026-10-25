/**
 * 播放：时间轴（纯数据）+ Web Audio 合成器
 * 时间轴部分不依赖浏览器，可在 Node 里算 MIDI 事件。
 */
import type { Doc, Note } from './types.js';
import { noteToMidi, midiToFreq } from './pitch.js';
import { flatten } from './layout.js';

export type Timbre = 'erhu' | 'piano' | 'sine';

export interface PlayEvent {
  /** 相对起始秒 */
  t: number;
  dur: number;
  midi: number | null;
  idx: number;
  kind: 'note' | 'rest' | 'noise' | 'grace';
}

export interface Timeline {
  events: PlayEvent[];
  total: number;
}

export function buildTimeline(doc: Doc, bpm?: number): Timeline {
  const spb = 60 / (bpm && bpm > 0 ? bpm : doc.tempo);
  const events: PlayEvent[] = [];
  let t = 0;

  for (const n of flatten(doc)) {
    // 前倚音：挤在主音之前的极短时值
    if (n.graces.length) {
      const g = 0.1;
      for (const gr of n.graces) {
        const midi = graceMidi(gr, doc.key.semi);
        events.push({ t, dur: g * spb, midi, idx: n.idx, kind: 'grace' });
        t += g * spb;
      }
    }
    const midi = noteToMidi(n, doc.key.semi);
    const dur = n.beats * spb;
    events.push({ t, dur, midi, idx: n.idx, kind: n.kind });
    t += dur;

    if (n.gracesAfter.length) {
      const g = 0.1;
      for (const gr of n.gracesAfter) {
        const gm = graceMidi(gr, doc.key.semi);
        events.push({ t, dur: g * spb, midi: gm, idx: n.idx, kind: 'grace' });
        t += g * spb;
      }
    }
  }
  return { events, total: t };
}

function graceMidi(g: { digit: number; acc: number; oct: number }, keySemi: number): number | null {
  if (g.digit <= 0) return null;
  return noteToMidi(
    { kind: 'note', digit: g.digit, acc: g.acc, oct: g.oct } as Pick<Note, 'kind' | 'digit' | 'acc' | 'oct'>,
    keySemi
  );
}

/* ------------------------------------------------------------------ 合成 */

export interface VoiceOptions {
  /** 力度 0–1 */
  gain?: number;
  /** 是否启用滑音衔接（二胡拉弦感） */
  portamento?: boolean;
}

export function createVoice(ctx: BaseAudioContext, dest: AudioNode, timbre: Timbre = 'erhu') {
  let lastFreq = 0;

  return function play(t0: number, dur: number, midi: number, opt: VoiceOptions = {}): void {
    const f = midiToFreq(midi);
    const vel = opt.gain ?? 0.85;
    const d = Math.max(0.06, dur);
    const out = ctx.createGain();
    out.connect(dest);

    if (timbre === 'sine') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vel * 0.5, t0 + 0.02);
      g.gain.setTargetAtTime(0, t0 + Math.max(0.03, d * 0.6), 0.25);
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + d + 0.5);
      return;
    }

    // 滤波器：二胡的弓毛噪声被琴筒压掉，高频偏暗
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(5200, Math.max(900, f * (timbre === 'erhu' ? 6.5 : 9)));
    lp.Q.value = timbre === 'erhu' ? 0.9 : 0.4;
    lp.connect(out);

    const oscs: OscillatorNode[] = [];
    const mk = (type: OscillatorType, detune: number, level: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(lp);
      oscs.push(o);
      return o;
    };

    if (timbre === 'erhu') {
      mk('sawtooth', 0, 0.55);
      mk('sawtooth', 7, 0.30);
      mk('triangle', 0, 0.22);
    } else {
      mk('triangle', 0, 0.7);
      mk('sine', 0, 0.3);
    }

    // 滑音衔接
    const port = opt.portamento !== false && lastFreq > 0 && timbre === 'erhu';
    if (port) {
      for (const o of oscs) {
        o.frequency.setValueAtTime(lastFreq, t0 - 0.001);
        o.frequency.setTargetAtTime(f, t0, 0.012);
      }
    }

    // 揉弦：0.18s 后逐渐加入
    if (timbre === 'erhu' && d > 0.22) {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 5.4;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t0);
      lg.gain.linearRampToValueAtTime(f * 0.006, t0 + Math.min(0.5, d * 0.45));
      lfo.connect(lg);
      for (const o of oscs) lg.connect(o.frequency);
      lfo.start(t0);
      lfo.stop(t0 + d + 0.6);
    }

    // 包络：慢起弓、稳音、收弓
    const atk = timbre === 'erhu' ? Math.min(0.07, d * 0.25) : 0.004;
    const rel = timbre === 'erhu' ? Math.min(0.16, d * 0.4) : Math.min(0.35, d * 0.8);
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(vel * 0.55, t0 + atk);
    out.gain.linearRampToValueAtTime(vel * 0.42, t0 + Math.min(atk + 0.08, d));
    out.gain.setValueAtTime(vel * 0.42, t0 + Math.max(atk, d - rel));
    out.gain.linearRampToValueAtTime(0, t0 + d + 0.02);

    for (const o of oscs) { o.start(t0); o.stop(t0 + d + 0.35); }
    lastFreq = f;
  };
}

/** 把时间轴调度到一个 AudioContext 上，返回结束时间（秒，ctx 时间） */
export function schedule(
  ctx: BaseAudioContext,
  dest: AudioNode,
  tl: Timeline,
  opts: { timbre?: Timbre; startAt?: number } = {}
): number {
  const t0 = opts.startAt ?? ctx.currentTime + 0.08;
  const voice = createVoice(ctx, dest, opts.timbre ?? 'erhu');
  for (const e of tl.events) {
    if (e.midi == null) continue;
    voice(t0 + e.t, e.dur, e.midi, { gain: e.kind === 'grace' ? 0.5 : 0.9 });
  }
  return t0 + tl.total;
}
