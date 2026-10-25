/**
 * 渲染 + 播放的纯逻辑（不依赖 obsidian，方便在浏览器里单独预览验证）。
 */

/** 原生 DOM 小工具：不用 Obsidian 的 HTMLElement 扩展，普通浏览器里也能跑 */
function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function add(parent: HTMLElement, cls?: string, text?: string): HTMLDivElement {
  const d = mk('div', cls, text);
  parent.appendChild(d);
  return d;
}
function addBtn(parent: HTMLElement, text: string, cls?: string): HTMLButtonElement {
  const b = mk('button', cls, text);
  b.type = 'button';
  parent.appendChild(b);
  return b;
}

import { buildTimeline, compile, schedule, type Doc } from '../src/index.js';

export interface RenderOpts {
  paper?: string;
  orientation?: string;
  toolbar?: boolean;
  highlight?: boolean;
  zoom?: number;
}

export interface Rendered {
  doc: Doc;
  svg: string;
  warnings: string[];
}

/** 编译并把警告/错误收成一段文字 */
export function buildBlock(source: string, opts: RenderOpts = {}): Rendered | { error: string } {
  try {
    const o: { paper?: string; orientation?: string } = {};
    if (opts.paper) o.paper = opts.paper;
    if (opts.orientation) o.orientation = opts.orientation;
    const r = compile(source, o);
    return {
      doc: r.doc,
      svg: r.svg,
      warnings: r.warnings.map((w) => (w.level === 'error' ? '✕ ' : '⚠ ') + w.message),
    };
  } catch (e) {
    return { error: '渲染失败：' + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 把谱面画进容器，带工具条（播放 / 缩放） */
export function renderJianpu(source: string, el: HTMLElement, opts: RenderOpts = {}): Rendered | { error: string } {
  el.innerHTML = '';
  el.classList.add('jianpu-block');

  const r = buildBlock(source, opts);
  if ('error' in r) {
    add(el, 'jianpu-err', r.error);
    return r;
  }

  let zoom = opts.zoom ?? 0;

  if (opts.toolbar !== false) {
    const bar = add(el, 'jp-bar');
    const play = addBtn(bar, '▶ 播放', 'jp-btn jp-play');
    const stop = addBtn(bar, '■', 'jp-btn');
    bar.appendChild(mk('span', 'jp-sep'));
    const zout = addBtn(bar, '−', 'jp-btn');
    const zin = addBtn(bar, '＋', 'jp-btn');
    const zfit = addBtn(bar, '适应', 'jp-btn');
    const zl = mk('span', 'jp-zoom');

    const applyZoom = (z: number) => {
      zoom = z;
      el.querySelectorAll('svg.page').forEach((s) => {
        const svg = s as SVGElement;
        svg.style.width = z ? 794 * z + 'px' : '100%';
        svg.style.maxWidth = '100%';
      });
      zl.textContent = z ? Math.round(z * 100) + '%' : '适应';
    };

    play.addEventListener('click', () => void playDoc(r.doc, el, opts.highlight !== false));
    stop.addEventListener('click', () => stopAll(el));
    zout.addEventListener('click', () => applyZoom(Math.max(0.4, (zoom || 1) - 0.1)));
    zin.addEventListener('click', () => applyZoom(Math.min(2.5, (zoom || 1) + 0.1)));
    zfit.addEventListener('click', () => applyZoom(0));
    applyZoom(zoom);
  }

  const holder = add(el, 'jp-pages');
  holder.innerHTML = r.svg;

  if (r.warnings.length) {
    add(el, 'jianpu-warn', r.warnings.join('\n'));
  }
  return r;
}

/* ------------------------------------------------------------------ 播放 */

let audioCtx: AudioContext | null = null;
let raf = 0;

export async function playDoc(doc: Doc, host?: HTMLElement, highlight = true): Promise<void> {
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
  const AC = Ctor.AudioContext || Ctor.webkitAudioContext;
  if (!AC) return;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const tl = buildTimeline(doc, doc.tempo);
  const master = audioCtx.createGain();
  master.gain.value = 0.55;
  master.connect(audioCtx.destination);
  const startAt = audioCtx.currentTime + 0.08;
  schedule(audioCtx, master, tl, { timbre: 'erhu', startAt });

  if (!highlight) return;
  const scope: ParentNode = host || document.body;
  const notes = scope.querySelectorAll('g.note');
  const tick = () => {
    const now = audioCtx!.currentTime - startAt;
    let cur: { idx: number } | null = null;
    for (const e of tl.events) {
      if (now >= e.t && now < e.t + e.dur) { cur = e; break; }
    }
    notes.forEach((n) => n.classList.remove('active'));
    if (cur) {
      const n = scope.querySelector(`g.note[data-idx="${cur.idx}"]`);
      if (n) n.classList.add('active');
    }
    if (now < tl.total + 0.3) raf = requestAnimationFrame(tick);
    else notes.forEach((n) => n.classList.remove('active'));
  };
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function stopAll(host?: HTMLElement): void {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const scope: ParentNode = host || document.body;
  scope.querySelectorAll('g.note.active').forEach((n) => n.classList.remove('active'));
}
