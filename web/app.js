import { compile, compileLayout, buildTimeline, schedule, normalizePaper, normalizeOrientation,
  autoBarLine, setMeta as setMetaText, tokenize, parseNoteToken, TUNING_HINT } from '../dist/index.js?v=00000000';
import { samples } from './samples.js?v=00000000';
import { createEditor } from './editor.js?v=00000000';

const $ = (s) => document.querySelector(s);
const srcEl = $('#src');
const pagesEl = $('#pages');
const diagEl = $('#diag');
const btnPlay = $('#btnPlay');
const bpmEl = $('#bpm');
const timbreEl = $('#timbre');
const zoomEl = $('#zoom');
const paperEl = $('#paper');
const orientEl = $('#orient');
const toolsEl = $('#tools');
const selinfoEl = $('#selinfo');
const gapEl = $('#gap');
const btnFit = $('#btnFit');
const pageCountEl = $('#pageCount');
const fileNameEl = $('#fileName');
const toastEl = $('#toast');

let state = { doc: null, layout: null, svg: '' };
let editor = null;
let audio = { ctx: null, master: null, raf: 0, start: 0, tl: null };
let zoom = 1;

/* ------------------------------------------------------------------ 渲染 */
let timer = 0;
function scheduleRender(delay = 180) {
  clearTimeout(timer);
  timer = setTimeout(render, delay);
}

function render() {
  const text = srcEl.value;
  try {
    const r = compile(text);
    state = r;
    pagesEl.innerHTML = r.svg;
    applyZoom();
    showDiag(r.warnings);
    syncMetaPickers(r.doc);
    showPageCount(r.layout);
    updateStatus();
    if (editor) editor.refresh(r);
    saveDraft();
  } catch (e) {
    showDiag([{ level: 'error', message: String(e && e.message || e) }]);
  }
}

/** 纸型选择器跟着源码里的 frontmatter 走（手改 frontmatter 也会同步过来） */
/** 打印用的 @page 尺寸跟着纸型走 */
function syncPageSize(theme) {
  let el = document.getElementById('pagesize');
  if (!el) { el = document.createElement('style'); el.id = 'pagesize'; document.head.appendChild(el); }
  const mm = (px) => Math.round(px / (96 / 25.4));
  const orient = theme.width > theme.height ? ' landscape' : ' portrait';
  el.textContent = `@page { size: ${mm(theme.width)}mm ${mm(theme.height)}mm${orient}; margin: 0; }`;
}

/** 右上角页数：多页时亮一下，提醒「要不要压一压行距」 */
function showPageCount(lay) {
  if (!pageCountEl) return;
  const n = lay ? lay.pages.length : 1;
  pageCountEl.textContent = n > 1 ? `共 ${n} 页` : '共 1 页';
  pageCountEl.classList.toggle('many', n > 1);
}

function syncMetaPickers(doc) {
  const tempo = doc && doc.meta && doc.meta.tempo;
  if (tempo && document.activeElement !== bpmEl) bpmEl.value = String(tempo);
  const paper = normalizePaper(doc && doc.meta && doc.meta.paper);
  const orient = normalizeOrientation(doc && doc.meta && doc.meta.orientation);
  if (paperEl.value !== paper) paperEl.value = paper;
  if (orientEl.value !== orient) orientEl.value = orient;
  const sp = Math.round((parseFloat(doc && doc.meta && doc.meta.spacing) || 1) * 100);
  if (document.activeElement !== gapEl) gapEl.value = String(sp);
  if (state.layout && state.layout.theme) syncPageSize(state.layout.theme);
}

/** 改写 frontmatter 里的某个键（没有就补一行；没有 frontmatter 就新建） */
function setMeta(key, value) {
  const next = setMetaText(srcEl.value, key, value);
  if (next === srcEl.value) return;
  srcEl.value = next;
  render();
}

/* --------------------------------------------------------- 自动分节（敲音符） */

/** 当前拍号一小节几拍（以四分音符计）：2/4 → 2，3/8 → 1.5 */
function meterBeats() {
  const t = (state.doc && state.doc.meta && state.doc.meta.time) || '';
  const m = /^(\d+)\/(\d+)$/.exec(String(t).trim());
  return m ? (+m[1] * 4) / +m[2] : 4;
}

const isNoteTok = (t) => !/^\d+\/\d+$/.test(t) && !!parseNoteToken(t);

/**
 * 光标所在行按拍号自动补小节线。
 *
 * 只对「看起来是谱行」的行动手——行首必须是 `|` `:` `(` `[` 或数字，
 * 不然 frontmatter 里的 `title: 1`、标题里的数字都会被当成音符重排。
 * 光标按「前面经过几个音」还原，不会跳到行尾。
 *
 * 这条路径就是「空白行直接敲数字」：敲 `1` 得 `| 1 |`，接着敲 `2` 得 `| 1 2 |`，
 * 满一拍自动落 `|`，满了就换小节。改时值（打 `/`、`-`、`.`）也会立刻重排。
 */
function autoBarAtCursor(e) {
  // 整段粘贴进来的谱保持原样，别一粘就重排
  if (e && e.inputType === 'insertFromPaste') return;
  const v = srcEl.value;
  const pos = srcEl.selectionStart;
  if (srcEl.selectionEnd !== pos) return;
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const nl = v.indexOf('\n', pos);
  const lineEnd = nl < 0 ? v.length : nl;
  const line = v.slice(lineStart, lineEnd);
  const body = line.trim();
  if (!body) return;
  if (!/^[|:(\[]/.test(body) && !/^\d/.test(body)) return;

  const next = autoBarLine(line, meterBeats());
  if (next === line) return;

  // 用 tokenize 数：`12` 在源码里是一个 token，但它是两个音，按空格切会数错
  const before = line.slice(0, pos - lineStart);
  const nBefore = tokenize(before).filter(isNoteTok).length;

  if (srcEl.setRangeText) srcEl.setRangeText(next, lineStart, lineEnd, 'preserve');
  else srcEl.value = v.slice(0, lineStart) + next + v.slice(lineEnd);

  let caret = 0;
  if (nBefore === 0) {
    caret = (/^\|?\s*/.exec(next) || [''])[0].length;
  } else {
    const re = /\S+/g;
    let m, seen = 0;
    caret = next.length;
    while ((m = re.exec(next))) {
      if (!isNoteTok(m[0])) continue;
      seen++;
      if (seen === nBefore) { caret = m.index + m[0].length; break; }
    }
  }
  srcEl.setSelectionRange(lineStart + caret, lineStart + caret);
}

function showDiag(warnings) {
  if (!warnings || !warnings.length) { diagEl.innerHTML = ''; return; }
  diagEl.innerHTML = warnings
    .slice(0, 30)
    .map((w) => `<div class="${w.level === 'error' ? 'e' : ''}">${w.level === 'error' ? '✕' : '⚠'} ${esc(w.message)}${w.line ? `　<span style="opacity:.5">第 ${w.line} 行</span>` : ''}</div>`)
    .join('');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function applyZoom() {
  const th = state.layout && state.layout.theme;
  const pw = th ? th.width : 794;
  const ph = th ? th.height : 1123;
  const w = Math.round(pw * zoom);
  pagesEl.querySelectorAll('svg.page').forEach((s) => {
    s.style.width = w + 'px';
    s.style.height = Math.round(ph * zoom) + 'px';
  });
  if (editor) editor.setZoom(zoom);
}

/* ------------------------------------------------------------------ 播放 */
function ensureCtx() {
  if (!audio.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}

function play() {
  stop();
  if (!state.doc) return;
  const ctx = ensureCtx();
  const tl = buildTimeline(state.doc, +bpmEl.value);
  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);

  const startAt = ctx.currentTime + 0.1;
  schedule(ctx, master, tl, { timbre: timbreEl.value, startAt });

  audio.master = master;
  audio.tl = tl;
  audio.start = startAt;
  btnPlay.textContent = '⏸ 停止';
  btnPlay.classList.add('on');

  const tick = () => {
    const now = audio.ctx.currentTime - audio.start;
    let cur = null;
    for (const e of audio.tl.events) {
      if (now >= e.t && now < e.t + e.dur) { cur = e; break; }
    }
    pagesEl.querySelectorAll('.note.active').forEach((n) => n.classList.remove('active'));
    if (cur) {
      const el = pagesEl.querySelector(`[data-idx="${cur.idx}"]`);
      if (el) el.classList.add('active');
    }
    if (now < audio.tl.total + 0.3) audio.raf = requestAnimationFrame(tick);
    else stop();
  };
  audio.raf = requestAnimationFrame(tick);
}

function stop() {
  if (audio.raf) cancelAnimationFrame(audio.raf);
  audio.raf = 0;
  pagesEl.querySelectorAll('.note.active').forEach((n) => n.classList.remove('active'));
  if (audio.master) { try { audio.master.disconnect(); } catch (e) { /* noop */ } audio.master = null; }
  btnPlay.textContent = '▶ 播放';
  btnPlay.classList.remove('on');
}

/* ------------------------------------------------------- 打开 / 保存 / 草稿 */
/**
 * 保存走 File System Access API（Chrome / Edge）：
 * 第一次保存让你选个 .md，之后 Ctrl+S 直接写回同一个文件，不用反复下载。
 * 不支持（Safari / Firefox）就退回下载文件。
 *
 * 另外每次渲染都把内容存进 localStorage：浏览器崩了、手滑关页面都能捡回来。
 */
const APP_BUILD = '2026-10-25a';
window.__APP_BUILD = APP_BUILD;   // 排查「浏览器跑的是不是新代码」用

const DRAFT_KEY = 'jianpu:draft:v1';
let fileHandle = null;
let draftTimer = 0;
let toastTimer = 0;
let apiOn = false;          // 服务器带 /api/save（tools/serve.py）
let currentPath = null;     // 当前谱在服务器上的相对路径
let dirty = false;          // 当前谱改过但还没存回服务器

function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

function setFileName(name) {
  fileNameEl.textContent = name || '';
  fileNameEl.title = name ? `当前文件：${name}` : '';
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ t: Date.now(), text: srcEl.value, path: currentPath }));
    } catch (e) { /* 撑爆配额就算了 */ }
  }, 350);
}

/** 探一下服务器有没有保存接口（没有就退回浏览器端保存） */
async function probeApi() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    apiOn = r.ok && !!((await r.json()).ok);
  } catch (e) { apiOn = false; }
  return apiOn;
}

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return d && typeof d.text === 'string' && d.text.trim() ? d : null;
  } catch (e) { return null; }
}

/** 新建曲谱的对话框：曲名 / 调号 / 拍号 / 速度 / 定弦 */
const NEW_KEYS = [
  ['D', '1=D'], ['G', '1=G'], ['F', '1=F'], ['C', '1=C'],
  ['A', '1=A'], ['E', '1=E'], ['Bb', '1=♭B'], ['F#', '1=♯F']
];
const NEW_TIMES = ['2/4', '3/4', '4/4', '6/8', '2/2', '3/8', '9/8'];

function newScoreDialog() {
  closeFilePick();
  const box = document.createElement('div');
  box.id = 'newscore';
  box.className = 'fp';
  const tuning0 = TUNING_HINT.D || '';
  box.innerHTML =
    `<div class="fp-h"><b>新建曲谱</b><span class="fp-x" title="关闭">×</span></div>` +
    `<div class="fp-f">` +
    `<label>曲名 <input id="npTitle" type="text" value="新曲" maxlength="40"></label>` +
    `<label>调号 <select id="npKey">${NEW_KEYS.map(([v, l]) => `<option value="${v}"${v === 'D' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` +
    `<label>拍号 <select id="npTime">${NEW_TIMES.map((t) => `<option value="${t}"${t === '2/4' ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` +
    `<label>速度 <input id="npTempo" type="number" min="20" max="300" value="88"> ♩</label>` +
    `<label>定弦 <input id="npTuning" type="text" value="${esc(tuning0)}"></label>` +
    `</div>` +
    `<div class="fp-act"><button id="npOk" class="primary2">创建</button></div>`;
  document.body.appendChild(box);

  const q = (sel) => box.querySelector(sel);
  const titleEl = q('#npTitle');
  titleEl.focus(); titleEl.select();
  // 改调号就跟着换定弦（二胡常用定弦表在库里的 TUNING_HINT）
  q('#npKey').addEventListener('change', (e) => {
    q('#npTuning').value = TUNING_HINT[e.target.value] || '';
  });

  const close = () => { box.remove(); };
  box.addEventListener('click', (e) => {
    if (e.target === box || e.target.classList.contains('fp-x') || e.target.classList.contains('fp-h')) close();
  });
  q('#npOk').addEventListener('click', () => { close(); createScore(box); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('#npOk').click(); } });
}

/** 新谱的第一行：按拍号给一整小节的示例音（免得刚建好就报「拍数不对」） */
function starterLine(time) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(time || '2/4').trim());
  const num = m ? +m[1] : 4, den = m ? +m[2] : 4;
  const beats = num * 4 / den;
  if (Math.abs(beats - Math.round(beats)) < 1e-9) {
    return `| ${Array.from({ length: Math.round(beats) }, (_, i) => (i % 7) + 1).join(' ')} |`;
  }
  // 3/8、9/8 这种：整小节用八分音符
  return `| ${Array.from({ length: num }, (_, i) => `${(i % 7) + 1}/`).join(' ')} |`;
}

/** 真的建一张新谱：旧谱没存的话先存回去，别让改动白丢 */
async function createScore(box) {
  const q = (sel) => box.querySelector(sel);
  const title = (q('#npTitle').value || '新曲').trim() || '新曲';
  const key = q('#npKey').value;
  const time = q('#npTime').value;
  const tempo = Math.max(20, Math.min(300, Math.round(+q('#npTempo').value || 88)));
  const tuning = (q('#npTuning').value || '').trim();

  if (dirty && currentPath) {
    await saveFile({ quiet: true });
    if (dirty) { toast('旧谱没存成功，先存好再新建', 3200); return; }
  }

  const text = `---
title: ${title}
key: 1=${key}
time: ${time}
tempo: ${tempo}
${tuning ? `tuning: ${tuning}\n` : ''}---

${starterLine(time)}
`;
  srcEl.value = text;
  currentPath = null;
  dirty = false;
  setFileName('');
  editor.forgetHistory();
  render();
  // 光标落到谱行上，接着就能敲
  const bodyIdx = srcEl.value.lastIndexOf('\n| ');
  if (bodyIdx >= 0) {
    const end = srcEl.value.indexOf('\n', bodyIdx + 1);
    srcEl.focus();
    srcEl.setSelectionRange(bodyIdx + 1, end < 0 ? srcEl.value.length : end);
  }
  toast(`已新建「${title}」　Ctrl+S 存成 scores/${title.replace(/[\\/:*?"<>|\s]+/g, '_')}.md`);
}

async function openFile() {
  await probeApi();
  if (apiOn) {
    let files = [];
    try { files = await (await fetch('/api/files', { cache: 'no-store' })).json(); }
    catch (e) { toast('读文件列表失败：' + e.message); return; }
    showFilePick(files);
    return;
  }
  try {
    if (window.showOpenFilePicker) {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: '简谱（Markdown / 文本）', accept: { 'text/markdown': ['.md', '.txt'], 'text/plain': ['.txt'] } }],
      });
      const f = await h.getFile();
      fileHandle = h;
      srcEl.value = await f.text();
      dirty = false;
      setFileName(f.name);
      editor.forgetHistory();
      render();
      toast(`已打开 ${f.name}（Ctrl+S 保存回这个文件）`);
    } else {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.md,.txt,text/plain';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        srcEl.value = await f.text();
        fileHandle = null;                      // 老浏览器写不回去，只能再下载
        dirty = false;
        setFileName(f.name);
        editor.forgetHistory();
        render();
        toast(`已打开 ${f.name}（这个浏览器只能"另存"，会下载文件）`);
      };
      inp.click();
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('打开失败：' + (e && e.message || e));
  }
}

/** 服务器上的文件列表弹层 */
function showFilePick(files) {
  closeFilePick();
  const box = document.createElement('div');
  box.id = 'filepick';
  box.className = 'fp';
  const rows = files.length
    ? files.map((f) => `<button class="fp-i" data-path="${esc(f.path)}">` +
        `<span>${esc(f.name)}</span><small>${esc(f.dir)} · ${new Date(f.mtime * 1000).toLocaleString()}</small></button>`).join('')
    : '<div class="fp-e">examples/ 和 scores/ 里还没有 .md 文件</div>';
  box.innerHTML = `<div class="fp-h"><b>打开</b><span class="fp-x" title="关闭">×</span></div>` + rows;
  document.body.appendChild(box);
  box.addEventListener('click', async (e) => {
    if (e.target === box || e.target.classList.contains('fp-x') || e.target.classList.contains('fp-h')) {
      closeFilePick();
      return;
    }
    const b = e.target.closest('.fp-i');
    if (!b) return;
    const path = b.getAttribute('data-path');
    closeFilePick();
    try {
      const text = await (await fetch('/' + path, { cache: 'no-store' })).text();
      srcEl.value = text;
      currentPath = path;
      dirty = false;
      setFileName(path);
      editor.forgetHistory();
      render();
      toast(`已打开 ${path}　Ctrl+S 存回这个文件`);
    } catch (err) { toast('打开失败：' + err.message); }
  });
}

function closeFilePick() {
  const el = document.getElementById('filepick');
  if (el) el.remove();
}

async function saveFile(opt = {}) {
  const text = srcEl.value;
  const say = (m, ms) => { if (!opt.quiet) toast(m, ms); };
  const name = baseName() + '.md';

  await probeApi();
  if (apiOn) {
    let path = opt.asNew ? null : currentPath;
    if (!path) {
      const t = String((state.doc && state.doc.meta && state.doc.meta.title) || '未命名')
        .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || '未命名';
      const guess = currentPath ? currentPath.replace(/\.md$/i, '-副本.md') : `scores/${t}.md`;
      const input = prompt('保存到哪里？（examples/ 或 scores/ 下的 .md）', guess);
      if (input === null) return;
      path = input.trim();
      if (!path) return;
      if (!/\.(md|txt)$/i.test(path)) path += '.md';
    }
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, text }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
      if (j.ok) {
        currentPath = j.path;
        dirty = false;
        setFileName(j.path);
        saveDraft();
        say(`已保存 ${j.path}`);
      } else {
        say('保存失败：' + (j.error || '未知原因'), 4000);
      }
    } catch (e) { say('保存失败：' + e.message, 4000); }
    return;
  }

  if (window.showSaveFilePicker) {
    try {
      if (!fileHandle) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '简谱（Markdown）', accept: { 'text/markdown': ['.md'] } }],
        });
      }
      const w = await fileHandle.createWritable();
      await w.write(text);
      await w.close();
      currentPath = null;
      dirty = false;
      setFileName(fileHandle.name);
      saveDraft();
      say(`已保存 ${fileHandle.name}`);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('保存失败，改为下载：' + (e && e.message || e));
    }
  }
  dirty = false;
  download(name, new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  say('已下载 ' + name);
}


/* ======================================================= JPWORD 版式 */

const LAYOUT_KEY = 'jianpu:layout:v1';

/** 切版式：默认（顶栏 + 下方源码栏） / JPWORD（菜单栏 + 左侧竖排工具窗 + 状态栏） */
function setLayout(name) {
  const jpw = name === 'jpw';
  document.body.classList.toggle('layout-jpw', jpw);
  const pick = document.getElementById('layoutPick');
  if (pick) pick.value = jpw ? 'jpw' : 'default';
  try { localStorage.setItem(LAYOUT_KEY, jpw ? 'jpw' : 'default'); } catch (e) { /* 算了 */ }
  requestAnimationFrame(() => { applyZoom(); updateStatus(); });
}

/** 菜单表：每项要么是分隔线，要么是 [名字, 快捷键提示, 动作] */
const MENUS = () => [
  ['文件', [
    ['新建曲谱', 'Ctrl+N', () => newScoreDialog()],
    ['打开…', 'Ctrl+O', () => openFile()],
    ['保存', 'Ctrl+S', () => saveFile()],
    ['另存为…', 'Ctrl+Shift+S', () => saveFile({ asNew: true })],
    ['sep'],
    ['导出 SVG（矢量）', '', () => exportSvg()],
    ['导出 PNG（300dpi）', '', () => exportPng()],
    ['打印 / 存 PDF', 'Ctrl+P', () => window.print()],
  ]],
  ['编辑', [
    ['撤销', 'Ctrl+Z', () => editor.undo()],
    ['重做', 'Ctrl+Shift+Z', () => editor.redo()],
    ['sep'],
    ['插入一个音（光标处）', '', () => editor.insertAfter()],
    ['删除选中的音', 'Del', () => editor.del()],
    ['连弓 / 连音线', 'F4', () => editor.slurToggle()],
  ]],
  ['视图', [
    ['版式：默认', '', () => setLayout('default')],
    ['版式：JPWORD', '', () => setLayout('jpw')],
    ['sep'],
    ['显示 / 隐藏源码栏', 'Ctrl+/', () => toggleSrcPanel()],
    ['放大', 'Ctrl+=', () => setZoomLevel(zoom * 1.1)],
    ['缩小', 'Ctrl+-', () => setZoomLevel(zoom / 1.1)],
    ['恢复 100%', '', () => setZoomLevel(1)],
  ]],
  ['插入', [
    ['音符 1', '1', () => editor.insertNote(1)],
    ['音符 2', '2', () => editor.insertNote(2)],
    ['音符 3', '3', () => editor.insertNote(3)],
    ['音符 4', '4', () => editor.insertNote(4)],
    ['音符 5', '5', () => editor.insertNote(5)],
    ['音符 6', '6', () => editor.insertNote(6)],
    ['音符 7', '7', () => editor.insertNote(7)],
    ['休止符', '0', () => editor.insertNote(0)],
    ['sep'],
    ['附点', '.', () => editor.applyOp((n) => ({ kind: 'dots', delta: n.dots > 0 ? -1 : 1 }))],
    ['增时线', '-', () => editor.applyOp((n) => ({ kind: 'dashes', delta: n.dashes > 0 ? -1 : 1 }))],
    ['减时线', 'Shift+-', () => editor.applyOp((n) => ({ kind: 'slash', delta: n.slash > 0 ? -1 : 1 }))],
    ['小节线', '\\', () => editor.insertBar()],
    ['sep'],
    ['拉弓', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'la' }))],
    ['推弓', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'tui' }))],
    ['顿音', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'dun' }))],
    ['揉弦', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'rou' }))],
    ['重音', '', () => editor.applyOp(() => ({ kind: 'mark', mark: '>' }))],
    ['sep'],
    ['指法 一指', '1指', () => editor.applyOp(() => ({ kind: 'mark', mark: '1' }))],
    ['指法 二指', '', () => editor.applyOp(() => ({ kind: 'mark', mark: '2' }))],
    ['指法 三指', '', () => editor.applyOp(() => ({ kind: 'mark', mark: '3' }))],
    ['指法 四指', '', () => editor.applyOp(() => ({ kind: 'mark', mark: '4' }))],
    ['空弦', '', () => editor.applyOp(() => ({ kind: 'mark', mark: '0' }))],
    ['内弦', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'nei' }))],
    ['外弦', '', () => editor.applyOp(() => ({ kind: 'mark', mark: 'wai' }))],
  ]],
  ['格式', [
    ['曲名 / 调号（改 frontmatter）', '', () => jumpToMeta('info')],
    ['速度…', '', () => focusTop('#bpm')],
    ['行距…', '', () => focusTop('#gap')],
    ['纸型…', '', () => focusTop('#paper')],
    ['方向…', '', () => focusTop('#orient')],
  ]],
  ['工具', [
    ['快捷键一览', '?', () => showHelp()],
  ]],
];

function focusTop(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  setSrcPanel(true, false);
  el.focus();
  if (el.select) el.select();
}

/** 渲染菜单栏并接管点击 */
function renderMenubar() {
  const bar = document.getElementById('menubar');
  if (!bar) return;
  // 快速按钮保留在菜单栏右端，菜单项动态生成
  const quick = bar.querySelector('.quick');
  bar.innerHTML = '';
  if (quick) bar.appendChild(quick);
  for (const [name, items] of MENUS()) {
    const b = document.createElement('div');
    b.className = 'm';
    b.textContent = name;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(b, items);
    });
    bar.appendChild(b);
  }
}

function openMenu(btn, items) {
  closeMenu();
  btn.classList.add('open');
  const pop = document.createElement('div');
  pop.className = 'menu-pop';
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom) + 'px';
  for (const it of items) {
    if (it[0] === 'sep') { const d = document.createElement('div'); d.className = 'sep'; pop.appendChild(d); continue; }
    const [label, key, fn] = it;
    const d = document.createElement('div');
    d.className = 'mi';
    d.innerHTML = `<span>${esc(label)}</span>` + (key ? `<span class="k">${esc(key)}</span>` : '');
    d.addEventListener('click', () => { closeMenu(); try { fn(); } catch (e) { toast('操作失败：' + e.message); } });
    pop.appendChild(d);
  }
  document.body.appendChild(pop);
}

function closeMenu() {
  const pop = document.querySelector('.menu-pop');
  if (pop) pop.remove();
  document.querySelectorAll('#menubar .m.open').forEach((m) => m.classList.remove('open'));
}

document.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/** 状态栏：曲名 / 光标位置 / 时值 / 选区 / 页数 / 缩放 */
function updateStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const doc = state.doc;
  const title = (doc && doc.meta && doc.meta.title) || '（未命名）';
  const bits = [];
  bits.push(`<b>${esc(title)}</b>`);
  const caret = editor && editor.caret;
  if (caret) {
    const n = caret.k;
    bits.push(`第 ${caret.line} 行 · 第 ${n + 1} 个音的位置`);
  }
  bits.push(`时值 <b>${editor ? editor.durName : ''}</b>`);
  const selN = editor ? editor.selection.length : 0;
  if (selN) bits.push(`选中 ${selN} 个音`);
  const pages = state.layout ? state.layout.pages.length : 0;
  bits.push(`共 ${pages} 页`);
  const warn = state.warnings ? state.warnings.length : 0;
  if (warn) bits.push(`<span style="color:#e0a33a">${warn} 条提示</span>`);
  bits.push(`<span class="sp"></span>`);
  bits.push(`${Math.round(zoom * 100)}%`);
  el.innerHTML = bits.join('　');
}

/* ------------------------------------------------------------------ 帮助 */

const HELP_ROWS = [
  ['打谱（光标模式）', ''],
  ['1–7', '插入音（当前时值）'],
  ['0', '插入休止符'],
  ['← →', '光标左右移（永远是移动光标，到头自动跨行）'],
  ['↑ ↓', '上一行 / 下一行'],
  ['Home / End', '行首 / 行尾'],
  ['空格', '切换音值组合（时值）'],
  ['.', '附点：加 / 去'],
  ['-', '增时线（加一拍）'],
  ['Shift + -', '减时线（减半）'],
  ['`', '升八度'],
  ['Shift + `', '降八度'],
  ['Shift + 3（或 #）', '变音记号循环（升→降→还原）'],
  ['Ctrl + ↑ / ↓', '音阶升 / 降一度'],
  ['Ctrl + ← / →', '改时值（左右键本身留给光标了）'],
  ['Alt + ←↓→↑', '插入低音 1 / 2 / 3 / 4'],
  ['\\（反斜杠）或 Tab', '插入小节线'],
  ['Delete / Backspace', '删除光标左边的音'],
  ['Esc', '取消选中，进光标模式'],
  ['', ''],
  ['选中模式（先点一下音）', ''],
  ['1–7 / 0', '改音级（0 = 休止）'],
  ['↑ ↓', '改音级（Shift+ 改八度）'],
  ['Ctrl + ← / →', '改时值（左短右长）'],
  ['拖动', '左右 = 时值，上下 = 音级'],
  ['Delete', '删除选中的音'],
  ['', ''],
  ['通用', ''],
  ['Ctrl + / ', '显示 / 隐藏源码栏'],
  ['Ctrl + S / Ctrl + Shift + S', '保存 / 另存为'],
  ['Ctrl + N / Ctrl + O', '新建 / 打开'],
  ['Ctrl + P', '打印'],
  ['Ctrl + Z / Ctrl + Shift + Z', '撤销 / 重做'],
  ['Ctrl + Enter', '播放 / 停止'],
  ['?', '打开 / 关闭本帮助'],
];

function showHelp() {
  closeFilePick();
  const box = document.getElementById('helpbox');
  if (box) { box.remove(); return; }
  const el = document.createElement('div');
  el.id = 'helpbox';
  el.className = 'fp';
  const rows = HELP_ROWS.map(([a, b]) =>
    b === ''
      ? `<div class="hk-h">${esc(a)}</div>`
      : `<div class="hk"><kbd>${esc(a)}</kbd><span>${esc(b)}</span></div>`
  ).join('');
  el.innerHTML = `<div class="fp-h"><b>快捷键</b><span class="fp-x" title="关闭">×</span></div>` +
    `<div class="hk-wrap">${rows}</div>` +
    `<div class="fp-e">参考 JP-Word 4.0 手册的快捷键，做成简谱打谱的习惯。</div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.classList.contains('fp-x') || e.target.classList.contains('fp-h')) el.remove();
  });
}

/* ---------------------------------------------------------- 源码栏（默认藏） */

const SRC_KEY = 'jianpu:srcpanel:v1';

/** 左边的源码栏默认藏起来：看谱、打谱都在右边那一大片地方 */
function setSrcPanel(show, focus) {
  const wrap = document.getElementById('wrap');
  const btn = document.getElementById('btnSrc');
  if (show) {
    wrap.classList.remove('src-hidden');
    btn.classList.add('on');
    if (focus) { srcEl.focus(); srcEl.setSelectionRange(srcEl.value.length, srcEl.value.length); }
  } else {
    wrap.classList.add('src-hidden');
    btn.classList.remove('on');
    // 焦点留在隐藏的 textarea 里的话，打谱快捷键会被它吃掉
    if (document.activeElement === srcEl) document.activeElement.blur();
  }
  try { localStorage.setItem(SRC_KEY, show ? '1' : '0'); } catch (e) { /* 无痕模式算了 */ }
}

function toggleSrcPanel() {
  setSrcPanel(document.getElementById('wrap').classList.contains('src-hidden'), true);
}

/**
 * 双击谱面上的曲名 / 副标题 / 页眉信息 → 展开源码栏并把光标放到对应的
 * frontmatter 那一行。源码栏藏起来的时候，改曲名、改调号就靠这个。
 */
function jumpToMeta(key) {
  const lines = srcEl.value.split('\n');
  let want = 'title';
  if (key === 'subtitle') want = 'subtitle';
  else if (key === 'info') want = 'key';
  let idx = lines.findIndex((l) => new RegExp('^\\s*' + want + '\\s*[:：]', 'i').test(l));
  if (idx < 0) idx = 0;
  setSrcPanel(true, false);
  srcEl.focus();
  const start = lines.slice(0, idx).join('\n').length + (idx ? 1 : 0);
  srcEl.setSelectionRange(start, start + (lines[idx] || '').length);
}

pagesEl.addEventListener('dblclick', (e) => {
  const t = e.target.closest && e.target.closest('text.meta-title');
  if (!t) return;
  jumpToMeta(t.getAttribute('data-key') || 'title');
});

/* ------------------------------------------------------------------ 导出 */
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName() {
  const t = (state.doc && state.doc.meta.title) || 'jianpu';
  return t.replace(/[\\/:*?"<>|]/g, '_');
}

function exportSvg() {
  if (!state.layout) return;
  const head = state.svg;
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${head}`;
  download(`${baseName()}.svg`, new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
}

async function exportPng() {
  const svgs = [...pagesEl.querySelectorAll('svg.page')];
  if (!svgs.length) return;
  const svg = svgs[0];
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const th = state.layout && state.layout.theme;
  const pw = th ? th.width : 794;
  const ph = th ? th.height : 1123;
  const scale = Math.round(300 / 96 * 100) / 100;    // ~300dpi
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pw * scale);
  canvas.height = Math.round(ph * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  canvas.toBlob((blob) => blob && download(`${baseName()}.png`, blob), 'image/png');
}

/* ------------------------------------------------------------------ 事件 */
btnPlay.addEventListener('click', () => (audio.raf ? stop() : play()));
$('#btnStop').addEventListener('click', stop);
$('#btnSrc').addEventListener('click', toggleSrcPanel);
$('#btnNew').addEventListener('click', newScoreDialog);
$('#btnOpen').addEventListener('click', openFile);
$('#btnSave').addEventListener('click', saveFile);
$('#btnSvg').addEventListener('click', exportSvg);
$('#btnPng').addEventListener('click', exportPng);
$('#btnPrint').addEventListener('click', () => window.print());

srcEl.addEventListener('input', (e) => {
  dirty = true;
  autoBarAtCursor(e);                   // 光标所在行按拍号自动补小节线
  if (editor) editor.forgetHistory();   // 手打的内容不进撤销栈，避免 Ctrl+Z 跳回手工编辑前
  scheduleRender();
});

/* ---------------------------------------------------------------- 纸型 */
paperEl.addEventListener('change', () => setMeta('paper', paperEl.value));
orientEl.addEventListener('change', () => setMeta('orientation', orientEl.value));

/* ------------------------------------------------------------ 行距（打印用） */

const clampGap = (v) => Math.max(60, Math.min(180, Math.round(v || 100)));

/** 按百分比写回 frontmatter `spacing:`，100% 直接去掉这个键 */
function setGap(pct) {
  const p = clampGap(pct);
  gapEl.value = String(p);
  if (p === 100) setMeta('spacing', '');
  else setMeta('spacing', (p / 100).toFixed(2));
}

const pagesAtGap = (pct) =>
  compileLayout(setMetaText(srcEl.value, 'spacing', (pct / 100).toFixed(2))).layout.pages.length;

/**
 * 压一页：二分找「还能让整首谱停在一页」的最大行距，取到就写回。
 * 之所以取最大的，是因为行距越接近 100 越好看 —— 刚好压进去就够，别压成一张饼。
 */
btnFit.addEventListener('click', () => {
  if (state.layout && state.layout.pages.length <= 1) {
    toast('已经是一页了');
    return;
  }
  if (pagesAtGap(60) > 1) {
    toast('压到最紧（60%）还是一页放不下：删点内容，或换更大纸型');
    return;
  }
  let lo = 60, hi = 100, best = 60;
  while (hi - lo > 1) {
    const mid = Math.round((lo + hi) / 2);
    if (pagesAtGap(mid) <= 1) { best = mid; lo = mid; } else { hi = mid; }
  }
  setGap(best);
  toast(`行距压到 ${best}%，整首谱一页装下`);
});

let gapTimer = 0;
gapEl.addEventListener('input', () => {
  clearTimeout(gapTimer);
  gapTimer = setTimeout(() => setGap(+gapEl.value), 320);
});
gapEl.addEventListener('change', () => { clearTimeout(gapTimer); setGap(+gapEl.value); });

let tempoTimer = 0;
bpmEl.addEventListener('input', () => {
  const v = Math.max(20, Math.min(300, Math.round(+bpmEl.value || 0)));
  if (!v) return;
  // 谱面上印的 ♩=88 也得跟着改，否则「所见即所得」就断了
  clearTimeout(tempoTimer);
  tempoTimer = setTimeout(() => {
    setMeta('tempo', v);
    if (audio.raf) play();                          // 播放中改速度 → 立即生效
  }, 220);
});
bpmEl.addEventListener('blur', () => {
  const v = Math.max(20, Math.min(300, Math.round(+bpmEl.value || 0) || 88));
  bpmEl.value = String(v);
});

zoomEl.addEventListener('input', () => {
  zoom = +zoomEl.value / 100;
  $('#zoomv').textContent = zoomEl.value + '%';
  const mv = document.getElementById('mZoomv');
  if (mv) mv.textContent = zoomEl.value + '%';
  applyZoom();
});

/** 设置缩放（菜单里的放大/缩小），range 框跟着走 */
function setZoomLevel(z) {
  zoom = Math.max(0.3, Math.min(3, z));
  const v = Math.round(zoom * 100);
  zoomEl.value = String(v);
  $('#zoomv').textContent = v + '%';
  const mv = document.getElementById('mZoomv');
  if (mv) mv.textContent = v + '%';
  applyZoom();
  updateStatus();
}

$('#tpl').addEventListener('change', (e) => {
  const key = e.target.value;
  if (key && samples[key]) {
    srcEl.value = samples[key];
    if (editor) editor.forgetHistory();
    render();
  }
  e.target.value = '';
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    audio.raf ? stop() : play();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile({ asNew: e.shiftKey });
    return;
  }
  // Ctrl+N 新建（浏览器默认是开新窗口，抢过来）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newScoreDialog();
    return;
  }
  // Esc 关掉弹层
  if (e.key === 'Escape') {
    const box = document.getElementById('newscore');
    if (box) { box.remove(); return; }
    const hb = document.getElementById('helpbox');
    if (hb) { hb.remove(); return; }
    closeFilePick();
  }
  // Ctrl+/ 切换源码栏
  if (ctrl && e.key === '/') {
    e.preventDefault();
    toggleSrcPanel();
    return;
  }
  // ? 帮助
  if (e.key === '?') {
    e.preventDefault();
    showHelp();
  }
});

/* ---------------------------------------------------------------- 编辑 */
editor = createEditor({
  srcEl,
  pagesEl,
  marqueeEl: $('#marquee'),
  onChange: render,
  onSelection: (ids, spans) => {
    toolsEl.classList.toggle('nosel', ids.length === 0);
    updateSelInfo(ids, spans);
  },
  onInfo: () => { updateSelInfo(); updateStatus(); },
});

/** 状态栏：选区信息 + 当前插入时值 + 光标提示 */
function updateSelInfo(ids, spans) {
  if (!ids || !ids.length) {
    const caret = editor && editor.caret;
    const caretTxt = caret ? `（光标在第 ${caret.line} 行）` : '点一下谱面进入打谱';
    selinfoEl.textContent = `未选中 · 时值=${editor.durName} · ${caretTxt} · 数字键打谱，空格切时值，? 看快捷键`;
    return;
  }
  const first = spans.get(ids[0]);
  selinfoEl.textContent = ids.length === 1
    ? `选中 1 个音（第 ${first.line} 行）· 左右拖 = 时值，上下拖 = 音级，Shift+ 上下 = 八度`
    : `选中 ${ids.length} 个音`;
}

toolsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button.tbtn');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'slur') return editor.slurToggle();
  if (act === 'insert') return editor.insertAfter();
  if (act === 'del') return editor.del();
  if (act === 'undo') return editor.undo();
  if (act === 'redo') return editor.redo();
  const op = b.dataset.op;
  const v = +b.dataset.v;
  if (!op) return;
  if (op === 'digit') return editor.applyAll({ kind: 'digit', digit: v });
  if (op === 'dur') {
    editor.setInsertDur(v);                    // 记住当前插入时值（空格键也会切它）
    if (editor.selection.length) editor.applyAll({ kind: 'dur', level: v });
    updateSelInfo();
    return;
  }
  if (op === 'acc') return editor.applyAll({ kind: 'acc', acc: v });
  if (op === 'dots') return editor.applyAll({ kind: 'dots', delta: v });
  if (op === 'dashes') return editor.applyAll({ kind: 'dashes', delta: v });
  if (op === 'oct') return editor.applyAll({ kind: 'oct', delta: v });
  if (op === 'mark') return editor.applyAll({ kind: 'mark', mark: b.dataset.v });
});

/* ------------------------------------------------------------------ 启动 */
// 源码栏默认隐藏（记住上次的偏好）
let srcPanelShown = false;
try { srcPanelShown = localStorage.getItem(SRC_KEY) === '1'; } catch (e) { srcPanelShown = false; }
setSrcPanel(srcPanelShown, false);

// 版式：默认 / JPWORD（记住上次的偏好）
renderMenubar();
let layoutName = 'default';
try { layoutName = localStorage.getItem(LAYOUT_KEY) || 'default'; } catch (e) { layoutName = 'default'; }
setLayout(layoutName);

document.getElementById('layoutPick').addEventListener('change', (e) => setLayout(e.target.value));

// 菜单栏右端的快速按钮
$('#mPlay').addEventListener('click', () => (audio.raf ? stop() : play()));
$('#mStop').addEventListener('click', stop);
$('#mPrint').addEventListener('click', () => window.print());
$('#mZoomIn').addEventListener('click', () => setZoomLevel(zoom * 1.1));
$('#mZoomOut').addEventListener('click', () => setZoomLevel(zoom / 1.1));

const draft = readDraft();
if (draft) {
  srcEl.value = draft.text;
  currentPath = draft.path || null;
  if (currentPath) setFileName(currentPath);
  render();
  toast(`已恢复上次编辑的草稿（${new Date(draft.t).toLocaleString()}）。想从头写就点「新建」，想存成文件按 Ctrl+S`, 6000);
} else {
  srcEl.value = samples.xiaoxingxing;
  render();
}
toolsEl.classList.add('nosel');
