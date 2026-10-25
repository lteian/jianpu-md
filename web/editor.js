/**
 * 所见即所得编辑器（工作台用）
 *
 * 简谱没有纵向音高轴——1 和 5 都写在同一水平线上，所以「上下拖音符」在物理上
 * 不可能让音符真的上下移动。这里的映射是：
 *
 *   左右拖 = 改时值（右拉变长、左拉变短）
 *   上下拖 = 改音级（上滑 1→2→3…，下滑往 1 走）
 *   Shift + 上下拖 = 改八度（加点 / 加点子在下面）
 *
 * 拖动过程 **实时改源码并重渲染**（整曲 compile ≈ 6ms，来得及），所以看到的就是
 * 拖完之后的样子。一次拖动从按下到松手只占一个撤销步。
 */
import { locateNotes, applyNoteEdits, setSlur, tokenize, durLevel, rebarLines, scanLineNotes } from '../dist/index.js?v=00000000';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createEditor({ srcEl, pagesEl, marqueeEl, onChange, onSelection, onInfo }) {
  let sel = new Set();          // 选中的 note.idx
  let spans = new Map();        // idx -> NoteSpan
  let curDoc = null;            // 最近一次渲染的文档（要拿拍号）
  let zoom = 1;
  let th = { width: 794, height: 1123, noteSize: 18.7 };
  const undo = [];
  const redo = [];

  /* ------------------------------------------------------------ 插入光标 */
  // 光标 = 「第 line 行的第 k 个音之前」。不是选区：可以停在两个音中间，
  // 也能停在行首/行尾——打谱时这两头都要能停。
  let caret = null;             // { line, k }
  let insDur = 2;               // 当前插入时值档位：0 全 1 二分 2 四分 3 八分 4 十六 5 三十二
  let posMap = new Map();       // note.idx -> { page, x, y }
  let lineIdx = new Map();      // 行号 -> [note.idx...]（该行的音，按顺序）
  const DUR_SUFFIX = ['---', '-', '', '/', '//', '///'];
  const NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------ 选中状态 */
  function setSel(next) {
    sel = next;
    paint();
    onSelection && onSelection([...sel], spans);
  }

  function paint() {
    pagesEl.querySelectorAll('svg.page g.note > rect.selhl').forEach((r) => r.remove());
    pagesEl.querySelectorAll('svg.page g.note.sel').forEach((g) => g.classList.remove('sel'));
    for (const idx of sel) {
      const g = pagesEl.querySelector(`svg.page g.note[data-idx="${idx}"]`);
      if (!g) continue;
      g.classList.add('sel');
      const b = g.getBBox();
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('class', 'selhl');
      r.setAttribute('x', b.x - 3);
      r.setAttribute('y', b.y - 3);
      r.setAttribute('width', b.width + 6);
      r.setAttribute('height', b.height + 6);
      r.setAttribute('rx', 4);
      g.insertBefore(r, g.firstChild);
    }
  }

  /** 渲染完成后由 app.js 调用：重新定位音符、重画高亮 */
  function refresh({ layout, doc } = {}) {
    spans = locateNotes(srcEl.value);
    if (doc) curDoc = doc;
    if (layout && layout.theme) th = layout.theme;
    // 选中的音可能因为删音/插音而换了编号，越界的直接丢掉
    const kept = new Set([...sel].filter((i) => spans.has(i)));
    const changed = kept.size !== sel.size;
    sel = kept;
    paint();
    // 谱面坐标表：光标要画在谱上，得知道每个音在哪
    posMap = new Map();
    lineIdx = new Map();
    if (layout) {
      layout.pages.forEach((p, pi) => {
        for (const sys of p.systems) {
          for (const m of sys.measures) {
            for (const pn of m.notes) {
              posMap.set(pn.note.idx, { page: pi, x: pn.x, y: pn.y });
            }
          }
        }
      });
    }
    for (const [idx, sp] of spans) {
      const arr = lineIdx.get(sp.line) || [];
      arr.push(idx);
      lineIdx.set(sp.line, arr);
    }
    // 光标所在行可能因为删行而不见了，落到最近的谱行上
    if (caret && !lineIdx.has(caret.line)) {
      const ls = musicLines();
      if (ls.length) caret = { line: ls[ls.length - 1], k: 0 };
      else caret = null;
    }
    if (changed) onSelection && onSelection([...sel], spans);
    paintCaret();
  }

  /** 缩放变了要跟着调拖动灵敏度（屏上 1px 对应的谱面距离变了） */
  function setZoom(z) { zoom = z; }

  /* ------------------------------------------------------------ 改源码 */
  function getSrc() { return srcEl.value; }

  function commit(newSrc, { snapshot = true, keepSel = true } = {}) {
    if (newSrc === srcEl.value) return false;
    if (snapshot) { undo.push(srcEl.value); if (undo.length > 200) undo.shift(); redo.length = 0; }
    srcEl.value = newSrc;
    const keep = keepSel ? new Set(sel) : new Set();
    onChange();                       // app.js 的 render()（同步）
    if (keepSel) { sel = keep; paint(); }
    return true;
  }

  /** 一小节几拍（以四分音符计） */
  function meterBeats() {
    const t = (curDoc && curDoc.meta && curDoc.meta.time) || '';
    const m = /^(\d+)\/(\d+)$/.exec(String(t).trim());
    return m ? (+m[1] * 4) / +m[2] : 4;
  }

  /** 改了时值 → 这几行的小节线要重排（音符会被「挤」到新位置） */
  const REBAR_KINDS = new Set(['dur', 'dashes', 'dots', 'slash', 'delete', 'insertAfter']);

  function edit(edits, opts = {}) {
    const target = opts.src != null ? opts.src : srcEl.value;
    let next = applyNoteEdits(target, edits);
    const wantRebar = opts.rebar !== undefined
      ? opts.rebar
      : edits.some((e) => REBAR_KINDS.has(e.op.kind));
    if (wantRebar) {
      const rows = new Set();
      for (const e of edits) {
        const sp = spans.get(e.idx);
        if (sp) rows.add(sp.line);
      }
      if (rows.size) next = rebarLines(next, [...rows], meterBeats());
    }
    return commit(next, opts);
  }

  /* ------------------------------------------------------------ 读取选中音 */
  function selNotes() {
    return [...sel].filter((i) => spans.has(i)).sort((a, b) => a - b);
  }

  /* ------------------------------------------------------------ 拖动 */
  let drag = null;

  const NOTE_STEP = () => Math.max(14, th.noteSize * 1.7 * zoom);

  function pagePoint(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const g = e.target.closest && e.target.closest('g.note');
    if (g) {
      const idx = +g.getAttribute('data-idx');
      // Shift/Ctrl 点在音上是「加选」，但同一次按下也可能是「Shift + 上下拖 = 改八度」，
      // 所以先不下结论：拖动了就走拖动，没拖动才在 mouseup 时切换选中
      const toggle = !!(e.shiftKey || e.ctrlKey || e.metaKey);
      if (!toggle && !sel.has(idx)) setSel(new Set([idx]));
      // 光标跟到这个音前面：点完就能接着往下打
      if (!toggle) {
        const sp = spans.get(idx);
        if (sp) {
          const ids = lineIdx.get(sp.line) || [];
          setCaret(sp.line, Math.max(0, ids.indexOf(idx)));
        }
      }
      startNoteDrag(e, idx, toggle);
      return;
    }
    // 空白处：单击 = 进光标模式（清掉选区），Shift+拖 = 框选
    if (!e.shiftKey) {
      setSel(new Set());
      const svg = e.target.closest && e.target.closest('svg.page');
      caretFromPoint(svg, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    startMarquee(e);
  }

  function startNoteDrag(e, idx, toggle) {
    const p = pagePoint(e);
    const targets = toggle ? [...new Set([...sel, idx])] : sel.size > 1 && sel.has(idx) ? selNotes() : [idx];
    const base = targets.map((i) => ({ idx: i, n: spans.get(i).note })).filter((t) => t.n);
    drag = { kind: 'note', idx, x0: p.x, y0: p.y, axis: null, base, last: {}, src0: srcEl.value, moved: false, toggle: !!toggle };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    const p = pagePoint(e);
    if (drag.kind === 'marquee') { moveMarquee(p); return; }

    const dx = p.x - drag.x0;
    const dy = p.y - drag.y0;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = e.shiftKey ? 'oct' : Math.abs(dx) > Math.abs(dy) ? 'dur' : 'digit';
      drag.moved = true;
    }
    // 八度是「一个音上最多三个点」，手感要比换音级钝一点，否则一下拖过头
    const step = NOTE_STEP() * (drag.axis === 'oct' ? 2.4 : 1);
    const d = Math.round((drag.axis === 'dur' ? dx : -dy) / step);
    if (d === drag.last[drag.axis]) return;
    drag.last[drag.axis] = d;

    const edits = [];
    for (const t of drag.base) {
      const b = t.n;
      if (drag.axis === 'dur') {
        edits.push({ idx: t.idx, op: { kind: 'dur', level: clamp(durLevel(b) - d, 0, 5) } });
      } else if (drag.axis === 'digit') {
        const target = clamp((b.kind === 'rest' ? 1 : b.digit) + d, 1, 7);
        edits.push({ idx: t.idx, op: { kind: 'digit', digit: target } });
      } else {
        edits.push({ idx: t.idx, op: { kind: 'oct', delta: clamp(b.oct + d, -3, 3) - b.oct } });
      }
    }
    // 整个手势只占一个还原点：第一次真正改动时把原始源码压栈
    if (!drag.snapped) { undo.push(drag.src0); if (undo.length > 200) undo.shift(); redo.length = 0; drag.snapped = true; }
    edit(edits, { snapshot: false, rebar: drag.axis !== 'digit' });
    hint(p, drag, d);
  }

  let hintEl = null;
  function hint(p, d, delta) {
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'draghint';
      document.body.appendChild(hintEl);
    }
    const first = d.base[0] && d.base[0].n;
    let text = '';
    if (d.axis === 'dur') {
      const names = ['全', '二分', '四分', '八分', '十六分', '三十二分'];
      text = '时值 ' + names[clamp(durLevel(first) - delta, 0, 5)];
    } else if (d.axis === 'digit') {
      text = '音级 ' + clamp((first.kind === 'rest' ? 1 : first.digit) + delta, 1, 7);
    } else {
      text = '八度 ' + (clamp(first.oct + delta, -3, 3) > 0 ? '+' : '') + clamp(first.oct + delta, -3, 3);
    }
    hintEl.textContent = text;
    hintEl.style.left = p.x + 14 + 'px';
    hintEl.style.top = p.y - 10 + 'px';
    hintEl.style.display = 'block';
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (hintEl) hintEl.style.display = 'none';
    if (drag && drag.kind === 'marquee') endMarquee();
    else if (drag && drag.kind === 'note' && drag.toggle && !drag.moved) {
      const next = new Set(sel);
      next.has(drag.idx) ? next.delete(drag.idx) : next.add(drag.idx);
      setSel(next);
    }
    drag = null;
  }

  /* ------------------------------------------------------------ 框选 */
  let mq = null;
  function startMarquee(e) {
    const p = pagePoint(e);
    drag = { kind: 'marquee', x0: p.x, y0: p.y };
    mq = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    marqueeEl.style.display = 'block';
    if (!e.shiftKey) setSel(new Set());
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function moveMarquee(p) {
    mq.x1 = p.x; mq.y1 = p.y;
    const l = Math.min(mq.x0, mq.x1), t = Math.min(mq.y0, mq.y1);
    marqueeEl.style.left = l + 'px';
    marqueeEl.style.top = t + 'px';
    marqueeEl.style.width = Math.abs(mq.x1 - mq.x0) + 'px';
    marqueeEl.style.height = Math.abs(mq.y1 - mq.y0) + 'px';
  }

  function endMarquee() {
    marqueeEl.style.display = 'none';
    if (!mq) return;
    const l = Math.min(mq.x0, mq.x1), r = Math.max(mq.x0, mq.x1);
    const t = Math.min(mq.y0, mq.y1), b = Math.max(mq.y0, mq.y1);
    if (r - l < 4 && b - t < 4) { mq = null; return; }
    const hit = new Set();
    pagesEl.querySelectorAll('svg.page g.note[data-idx]').forEach((g) => {
      const q = g.getBoundingClientRect();
      if (q.right >= l && q.left <= r && q.bottom >= t && q.top <= b) hit.add(+g.getAttribute('data-idx'));
    });
    setSel(hit);
    mq = null;
  }


  /* ============================================================ 插入光标 */

  /** 所有谱行的行号（按顺序） */
  function musicLines() {
    return [...new Set([...spans.values()].map((sp) => sp.line))].sort((a, b) => a - b);
  }

  /** 光标所在行的音（原文里的字面位置） */
  function caretSpans() {
    if (!caret) return [];
    const line = (srcEl.value.split('\n')[caret.line - 1]) || '';
    return scanLineNotes(line);
  }

  /** 光标左边那个音的 note.idx（没有就 null） */
  function leftIdx() {
    if (!caret || caret.k === 0) return null;
    const ids = lineIdx.get(caret.line) || [];
    const idx = ids[caret.k - 1];
    return idx == null ? null : idx;
  }

  /**
   * 「当前这一音」：优先光标左边的（刚敲进去的那个），
   * 左边没有就取右边紧邻的（光标在行首时按附点，作用在第一个音上）。
   */
  function targetIdx() {
    const l = leftIdx();
    if (l != null) return l;
    if (!caret) return null;
    const ids = lineIdx.get(caret.line) || [];
    const r = ids[caret.k];
    return r == null ? null : r;
  }

  /** 光标在谱面上的位置（x/y/page） */
  function caretGeom() {
    if (!caret) return null;
    const ids = lineIdx.get(caret.line) || [];
    if (!ids.length) return null;
    const k = Math.min(caret.k, ids.length);
    const target = k < ids.length ? ids[k] : ids[ids.length - 1];
    const p = posMap.get(target);
    if (!p) return null;
    const gap = Math.max(9, th.noteSize * 0.6);
    return {
      page: p.page,
      x: k < ids.length ? p.x - gap : p.x + gap,
      y: p.y
    };
  }

  /** 把光标画到谱上（每次重排后都要重画，坐标会变） */
  function paintCaret() {
    pagesEl.querySelectorAll('svg.page g.caret').forEach((g) => g.remove());
    const geo = caretGeom();
    if (!geo) return;
    const svg = pagesEl.querySelectorAll('svg.page')[geo.page];
    if (!svg) return;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'caret');
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', n1(geo.x)); l.setAttribute('x2', n1(geo.x));
    l.setAttribute('y1', n1(geo.y - 21)); l.setAttribute('y2', n1(geo.y + 9));
    l.setAttribute('stroke', '#e04a2f'); l.setAttribute('stroke-width', '1.6');
    g.appendChild(l);
    const cap = document.createElementNS(NS, 'rect');
    cap.setAttribute('x', n1(geo.x - 3.2)); cap.setAttribute('y', n1(geo.y - 24));
    cap.setAttribute('width', '6.4'); cap.setAttribute('height', '3');
    cap.setAttribute('fill', '#e04a2f');
    g.appendChild(cap);
    svg.appendChild(g);
  }

  const n1 = (v) => Math.round(v * 100) / 100;

  function setCaret(line, k) {
    caret = { line, k };
    paintCaret();
    onInfo && onInfo();
  }

  /** 光标左右移动一个音；到行首/行尾就跨到上一行/下一行 */
  function moveCaret(dir) {
    const ls = musicLines();
    if (!ls.length) return;
    if (!caret) { setCaret(ls[0], 0); return; }
    const ids = lineIdx.get(caret.line) || [];
    if (dir < 0) {
      if (caret.k > 0) { caret.k--; }
      else {
        const i = ls.indexOf(caret.line);
        if (i > 0) { caret.line = ls[i - 1]; caret.k = (lineIdx.get(caret.line) || []).length; }
      }
    } else {
      if (caret.k < ids.length) { caret.k++; }
      else {
        const i = ls.indexOf(caret.line);
        if (i >= 0 && i < ls.length - 1) { caret.line = ls[i + 1]; caret.k = 0; }
      }
    }
    paintCaret();
    onInfo && onInfo();
  }

  /** 光标上下换行（尽量保持行内位置） */
  function moveCaretLine(dir) {
    const ls = musicLines();
    if (!ls.length) return;
    if (!caret) { setCaret(ls[0], 0); return; }
    const i = ls.indexOf(caret.line);
    const j = i + dir;
    if (j < 0 || j >= ls.length) return;
    const n = (lineIdx.get(ls[j]) || []).length;
    caret = { line: ls[j], k: Math.min(caret.k, n) };
    paintCaret();
    onInfo && onInfo();
  }

  /** 在光标处插一个音；返回是否成功 */
  function insertNote(digit, opt = {}) {
    const ls = musicLines();
    if (!ls.length) return false;
    if (!caret) caret = { line: ls[0], k: 0 };
    const lines = srcEl.value.split('\n');
    const li = caret.line - 1;
    if (li < 0 || li >= lines.length) return false;
    const sp = scanLineNotes(lines[li]);
    const k = Math.min(caret.k, sp.length);
    const oct = opt.oct || 0;
    const token = String(digit) + (oct > 0 ? "'".repeat(oct) : oct < 0 ? ','.repeat(-oct) : '') + DUR_SUFFIX[insDur];
    const at = k < sp.length ? sp[k].start : (sp.length ? sp[sp.length - 1].end : lines[li].length);
    const before = lines[li].slice(0, at);
    const after = lines[li].slice(at);
    const head = before && !/\s$/.test(before) ? before + ' ' : before;
    const tail = after && !/^\s/.test(after) ? ' ' + after : after;
    lines[li] = head + token + tail;
    let next = lines.join('\n');
    // 插完立刻按拍号重排这一行：满拍自动落小节线
    next = rebarLines(next, [caret.line], meterBeats());
    commit(next);
    caret = { line: caret.line, k: k + 1 };
    paintCaret();
    onInfo && onInfo();
    return true;
  }

  /** 删掉光标左边的音 */
  function deleteBefore() {
    const idx = leftIdx();
    if (idx == null) return false;
    edit([{ idx, op: { kind: 'delete' } }]);
    if (caret) caret = { line: caret.line, k: Math.max(0, caret.k - 1) };
    paintCaret();
    onInfo && onInfo();
    return true;
  }

  /** 对光标左边的音做一次编辑（没有左边的音就什么也不做） */
  function editLeft(op) {
    const idx = leftIdx();
    if (idx == null) return false;
    edit([{ idx, op }]);
    return true;
  }

  /** 变音记号循环：升 → 降 → 还原 → 无 */
  function cycleAcc() {
    const idx = targetIdx();
    if (idx == null) return false;
    const n = spans.get(idx);
    if (!n) return false;
    const cur = n.note.acc;
    const next = cur > 0 ? -1 : (cur < 0 ? 0 : 1);
    return edit([{ idx, op: { kind: 'acc', acc: next } }]);
  }

  /** 在光标处插一根小节线 */
  function insertBar() {
    if (!caret) return false;
    const lines = srcEl.value.split('\n');
    const li = caret.line - 1;
    if (li < 0 || li >= lines.length) return false;
    const sp = scanLineNotes(lines[li]);
    const k = Math.min(caret.k, sp.length);
    const at = k < sp.length ? sp[k].start : (sp.length ? sp[sp.length - 1].end : lines[li].length);
    const before = lines[li].slice(0, at);
    const after = lines[li].slice(at);
    const head = before && !/\s$/.test(before) ? before + ' ' : before;
    const tail = after && !/^\s/.test(after) ? ' ' + after : after;
    lines[li] = head + '|' + tail;
    // 手动落线**不**重排：自动分节会把手插的小节线按拍数重插掉，
    // 用户想自己控制小节线时就听他的。
    commit(lines.join('\n'));
    paintCaret();
    onInfo && onInfo();
    return true;
  }

  /** 点谱面：把光标放到最近的音前面（坐标要按 svg 的缩放换算） */
  function caretFromPoint(svg, clientX, clientY) {
    if (!svg) return false;
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const w = (vb && vb.width) || r.width || 1;
    const scale = r.width / w || 1;
    const x = (clientX - r.left) / scale;
    const y = (clientY - r.top) / scale;
    let best = null, bestD = Infinity;
    for (const [idx, p] of posMap) {
      if (p.page !== svgIndex(svg)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = idx; }
    }
    if (best == null) return false;
    const sp = spans.get(best);
    if (!sp) return false;
    const ids = lineIdx.get(sp.line) || [];
    const k = ids.indexOf(best);
    setCaret(sp.line, k < 0 ? 0 : k);
    return true;
  }

  function svgIndex(svg) {
    return [...pagesEl.querySelectorAll('svg.page')].indexOf(svg);
  }

  /* ------------------------------------------------------------ 工具栏动作 */
  /** 对所有选中音跑同一个 op */
  function applyAll(op) {
    const ids = selNotes();
    if (!ids.length) return;
    edit(ids.map((idx) => ({ idx, op })));
  }

  function slurToggle() {
    const ids = selNotes();
    if (ids.length < 2) return;
    const a = spans.get(ids[0]), b = spans.get(ids[ids.length - 1]);
    if (a.line !== b.line) return;
    const toks = tokenize(getSrc().split('\n')[a.line - 1] || '');
    const on = !(toks[a.ti - 1] === '(' && toks[b.ti + 1] === ')');
    commit(setSlur(getSrc(), ids[0], ids[ids.length - 1], on));
  }

  function insertAfter() {
    const ids = selNotes();
    if (!ids.length) return;
    const last = ids[ids.length - 1];
    edit([{ idx: last, op: { kind: 'insertAfter' } }]);
    setSel(new Set([last + 1]));
  }

  function del() {
    const ids = selNotes();
    if (!ids.length) return;
    const first = ids[0];
    edit(ids.map((idx) => ({ idx, op: { kind: 'delete' } })));
    setSel(new Set(spans.has(first - 1) ? [first - 1] : []));
  }

  /* ------------------------------------------------------------ 键盘 */
  const DUR_NAME = ['全音符', '二分音符', '四分音符', '八分音符', '十六分音符', '三十二分音符'];

  function setInsDur(v) {
    insDur = Math.max(0, Math.min(5, v | 0));
    onInfo && onInfo();
  }

  /**
   * 对「当前目标音」做操作：
   * 有选区 → 改选区里的音；没有选区 → 改光标左边那个音。
   * op 是函数：可以根据音的当前状态决定做什么（附点/增时线就是「有就减、无就加」）。
   */
  function applyTarget(fn) {
    if (sel.size) {
      const ids = selNotes();
      edit(ids.map((idx) => ({ idx, op: fn(spans.get(idx).note) })));
      return true;
    }
    const idx = targetIdx();
    if (idx == null) return false;
    const n = spans.get(idx);
    if (!n) return false;
    edit([{ idx, op: fn(n.note) }]);
    return true;
  }

  function onKey(e) {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (inField) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const stack = e.shiftKey ? redo : undo;
      const other = e.shiftKey ? undo : redo;
      if (!stack.length) return;
      other.push(srcEl.value);
      srcEl.value = stack.pop();
      onChange();
      return;
    }

    const k = e.key;
    const shift = e.shiftKey;
    const alt = e.altKey;

    // Esc：取消选中，进光标模式
    if (k === 'Escape') {
      if (sel.size) { setSel(new Set()); }
      if (!caret) { const ls = musicLines(); if (ls.length) setCaret(ls[0], 0); }
      return;
    }

    /* ---------- 选中模式：上下键改音级（左右键一律留给光标） ---------- */
    if (sel.size && !ctrl && !alt) {
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); del(); return; }
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        const dir = k === 'ArrowUp' ? 1 : -1;
        applyAll(shift ? { kind: 'oct', delta: dir } : { kind: 'digitStep', delta: dir });
        return;
      }
    }

    // Ctrl+上下：自然音阶升/降一度（JP-Word 同款）
    // Ctrl+左右：改时值（左右键本身已经让给光标了）
    // 注意：这几个分支必须排在「方向键移动光标」前面，
    // 否则 Ctrl+↑ 会被当成「光标上移」吃掉。
    if (ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      const dir = k === 'ArrowUp' ? 1 : -1;
      applyTarget(() => ({ kind: 'digitStep', delta: dir }));
      return;
    }
    if (ctrl && (k === 'ArrowRight' || k === 'ArrowLeft')) {
      e.preventDefault();
      applyTarget(() => ({ kind: 'slash', delta: k === 'ArrowLeft' ? 1 : -1 }));
      return;
    }

    // Alt+方向：插入低音 1/2/3/4（JP-Word 同款）
    if (alt && ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(k)) {
      e.preventDefault();
      const map = { ArrowLeft: 1, ArrowDown: 2, ArrowRight: 3, ArrowUp: 4 };
      insertNote(map[k], { oct: -1 });
      return;
    }

    /* ---------- 光标模式 ---------- */
    // 左右键**永远**是移动光标，不改音长 —— 改音长用 - / Shift+- （增时线/减时线）
    // 或 Ctrl+左右。开始移动就退出选中模式：方向键表达的是「我在哪儿」，
    // 不是「这个音该多长」。
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      if (sel.size) setSel(new Set());
      moveCaret(k === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (!sel.size) {
      if (k === 'ArrowUp') { e.preventDefault(); moveCaretLine(-1); return; }
      if (k === 'ArrowDown') { e.preventDefault(); moveCaretLine(1); return; }
      if (k === 'Home') { e.preventDefault(); if (caret) setCaret(caret.line, 0); return; }
      if (k === 'End') {
        e.preventDefault();
        if (caret) setCaret(caret.line, (lineIdx.get(caret.line) || []).length);
        return;
      }
    }

    // 附点：`.`（逗号右侧那个键）
    if (k === '.') { e.preventDefault(); applyTarget((n) => ({ kind: 'dots', delta: n.dots > 0 ? -1 : 1 })); return; }
    // 增时线：`-`；减时线：Shift+-（键盘上是 `_`）
    if (k === '-') { e.preventDefault(); applyTarget((n) => ({ kind: 'dashes', delta: n.dashes > 0 ? -1 : 1 })); return; }
    if (k === '_') { e.preventDefault(); applyTarget((n) => ({ kind: 'slash', delta: n.slash > 0 ? -1 : 1 })); return; }
    // 八度：`` ` `` 升，Shift+`（~）降
    if (k === '`') { e.preventDefault(); applyTarget(() => ({ kind: 'oct', delta: 1 })); return; }
    if (k === '~') { e.preventDefault(); applyTarget(() => ({ kind: 'oct', delta: -1 })); return; }
    // 变音记号：Shift+3（也接受 # 键）
    if (k === '#' || (shift && k === '3')) { e.preventDefault(); cycleAcc(); return; }
    // 小节线：`\` 或 Tab
    if (k === '\\' || k === 'Tab') { e.preventDefault(); insertBar(); return; }
    // 空格：切换音值组合（JP-Word 同款）
    if (k === ' ') { e.preventDefault(); setInsDur((insDur + 1) % DUR_SUFFIX.length); return; }
    // 删除：选区模式删选区，光标模式删左边那个音
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (sel.size) del(); else deleteBefore();
      return;
    }
    // 数字：选区模式改音级，光标模式插入新音
    if (/^[0-7]$/.test(k)) {
      e.preventDefault();
      if (sel.size) applyAll({ kind: 'digit', digit: +k }); else insertNote(+k);
      return;
    }
    if (k === '0') {
      e.preventDefault();
      if (sel.size) applyAll({ kind: 'digit', digit: 0 }); else insertNote(0);
    }
  }

  /* ------------------------------------------------------------ 绑定 */
  pagesEl.addEventListener('mousedown', onDown);
  window.addEventListener('keydown', onKey);

  return {
    refresh,
    setZoom,
    get selection() { return selNotes(); },
    get insertDur() { return insDur; },
    get durName() { return DUR_NAME[insDur]; },
    setInsertDur: setInsDur,
    insertNote: (digit, opt) => insertNote(digit, opt),
    insertBar,
    /** 对「当前目标音」做一次操作（菜单里的附点/弓法等走它） */
    applyOp: (fn) => applyTarget(fn),
    get caret() { return caret ? { ...caret } : null; },
    setCaret,
    clearCaret: () => { caret = null; paintCaret(); },
    applyAll,
    slurToggle,
    insertAfter,
    del,
    undo: () => { if (undo.length) { redo.push(srcEl.value); srcEl.value = undo.pop(); onChange(); } },
    redo: () => { if (redo.length) { undo.push(srcEl.value); srcEl.value = redo.pop(); onChange(); } },
    canUndo: () => undo.length > 0,
    forgetHistory: () => { undo.length = 0; redo.length = 0; },
    clear: () => setSel(new Set()),
  };
}
