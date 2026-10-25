#!/usr/bin/env python3
"""scan2jp.py — 把印刷版简谱扫描图转成 jianpu-md 文本（半自动，M1 用）。

不是通用 OCR：它只认「同一张图、同一字体」的数字字形。
用一行已知结果当原型库，再拿原型匹配其余行，匹配不上标 `?` 交人眼复核。

用法：
    python3 tools/scan2jp.py page.pbm            # 逐系统输出识别明细 + jianpu-md 草稿
    python3 tools/scan2jp.py page.pbm --md       # 只输出 jianpu-md 草稿
依赖：ImageMagick（生成 PBM）、纯 Python 标准库
"""
from collections import deque
import sys

PAD_TOP, PAD_BOT = 32, 46      # 上留八度点，下留减时线，避开上一行的歌词
X0, X1 = 150, 2360
CONF = 0.90                    # 字形匹配阈值，低于此标 ?
RULE_MODE = '--rule' in __import__('sys').argv   # 用几何判据代替原型匹配


# ---------- PBM (P4) ----------
class Page:
    def __init__(self, path):
        raw = open(path, 'rb').read()
        i, toks = 0, []
        while len(toks) < 3:
            while raw[i:i+1].isspace(): i += 1
            j = i
            while not raw[j:j+1].isspace(): j += 1
            toks.append(raw[i:j]); i = j
        assert toks[0] == b'P4', toks[0]
        self.W, self.H = int(toks[1]), int(toks[2])
        self.stride = (self.W + 7) // 8
        self.data = raw[i+1:i+1 + self.stride * self.H]

    def crop_bits(self, x0, y0, x1, y1):
        w, h = x1 - x0, y1 - y0
        buf = bytearray(w * h)
        for y in range(h):
            base = (y0 + y) * self.stride
            rowbits = int.from_bytes(self.data[base:base+self.stride], 'big')
            bits = bin(rowbits | (1 << (8 * self.stride)))[3:]
            bt = buf
            off = y * w
            for x in range(w):
                if bits[x0 + x] == '1':
                    bt[off + x] = 1
        return buf, w, h


class Blob:
    __slots__ = ('x0','y0','x1','y1','n','pts')
    def __init__(self, x0,y0,x1,y1,n,pts):
        self.x0,self.y0,self.x1,self.y1,self.n,self.pts = x0,y0,x1,y1,n,pts
    @property
    def w(self): return self.x1 - self.x0 + 1
    @property
    def h(self): return self.y1 - self.y0 + 1
    @property
    def cx(self): return (self.x0 + self.x1) / 2


def blobs(buf, w, h):
    seen = bytearray(w * h); out = []
    for y in range(h):
        for x in range(w):
            k0 = y*w+x
            if buf[k0] and not seen[k0]:
                q = deque([(x, y)]); seen[k0] = 1
                mnx = mxx = x; mny = mxy = y; pts = []
                while q:
                    cx, cy = q.popleft(); pts.append((cx, cy))
                    if cx < mnx: mnx = cx
                    if cx > mxx: mxx = cx
                    if cy < mny: mny = cy
                    if cy > mxy: mxy = cy
                    for dy in (-1, 0, 1):
                        ny = cy + dy
                        if ny < 0 or ny >= h: continue
                        for dx in (-1, 0, 1):
                            nx = cx + dx
                            if nx < 0 or nx >= w: continue
                            k = ny*w+nx
                            if buf[k] and not seen[k]:
                                seen[k] = 1; q.append((nx, ny))
                out.append(Blob(mnx,mny,mxx,mxy,len(pts),pts))
    return out


# ---------- 字形 ----------
def bitmap(b):
    w, h = b.w, b.h
    m = bytearray(w * h)
    for px, py in b.pts:
        m[(py-b.y0)*w + (px-b.x0)] = 1
    return m, w, h

def iou(A, B):
    am, aw, ah = A; bm, bw, bh = B
    inter = union = 0
    for y in range(ah):
        sy = min(bh-1, y*bh//ah)
        row = sy*bw
        arow = y*aw
        for x in range(aw):
            p = am[arow+x]
            q = bm[row + min(bw-1, x*bw//aw)]
            if p or q:
                union += 1
                if p and q: inter += 1
    return inter/union if union else 0.0

def holes(b):
    m, w, h = bitmap(b)
    seen = bytearray(w*h); q = deque()
    for x in range(w):
        for y in (0, h-1):
            k = y*w+x
            if not m[k] and not seen[k]: seen[k] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w-1):
            k = y*w+x
            if not m[k] and not seen[k]: seen[k] = 1; q.append((x, y))
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = cx+dx, cy+dy
            if 0 <= nx < w and 0 <= ny < h:
                k = ny*w+nx
                if not m[k] and not seen[k]: seen[k] = 1; q.append((nx, ny))
    res = []; seen2 = bytearray(w*h)
    for y in range(h):
        for x in range(w):
            k = y*w+x
            if not m[k] and not seen[k] and not seen2[k]:
                q = deque([(x, y)]); seen2[k] = 1; area = 0; sy = 0
                while q:
                    cx, cy = q.popleft(); area += 1; sy += cy
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                        nx, ny = cx+dx, cy+dy
                        if 0 <= nx < w and 0 <= ny < h:
                            kk = ny*w+nx
                            if not m[kk] and not seen[kk] and not seen2[kk]:
                                seen2[kk] = 1; q.append((nx, ny))
                if area >= 25: res.append((area, round(sy/area/h, 2)))
    res.sort(reverse=True)
    return res

def widest_run(b, y):
    m, w, h = bitmap(b)
    best = cur = 0
    for x in range(w):
        if m[y*w+x]: cur += 1; best = max(best, cur)
        else: cur = 0
    return best

def nruns(b, y):
    m, w, h = bitmap(b)
    n = 0; prev = 0
    for x in range(w):
        v = m[y*w+x]
        if v and not prev: n += 1
        prev = v
    return n

def classify(b):
    """按几何判据定字形。阈值不是拍脑袋，是对本页 258 个字形逐类量出来的：
      1  宽 15-17
      4  有洞且洞在半高（relY~0.5，中横上方的三角）
      6  有洞且洞偏下（relY~0.7）
      7  无洞，顶横 >=0.92W（平顶横满，下方无碗）
      5  无洞，顶横 0.72-0.90W（平顶横略窄于整宽，下方有碗）
      2  无洞，窄顶 + 底横 >=0.85W（顶弧→左下斜→底横）
      3  无洞，窄顶 + 无底横（上下两个左侧开口的碗）
    """
    W, H = b.w, b.h
    if W < 22: return '1'
    hs = holes(b)
    if hs:
        return '4' if hs[0][1] <= 0.58 else '6'
    top = widest_run(b, 0)
    bot = widest_run(b, H - 1)
    if top >= 0.92 * W: return '7'
    if top >= 0.72 * W: return '5'
    if bot >= 0.85 * W: return '2'
    return '3'


def guess(b):
    """纯几何判字形，只用于从校准行建原型库"""
    W, H = b.w, b.h
    if W < 22: return '1'
    hs = holes(b)
    if hs: return '6' if hs[0][1] > 0.55 else '9'
    if widest_run(b, 0) >= 0.72 * W: return '5'
    if nruns(b, min(H-1, 4)) >= 2: return '3'
    if nruns(b, min(H-1, 2)) >= 2: return '4'
    return '2'


# ---------- 单系统 ----------
def read_system(page, ytop, ybot, protos=None):
    buf, w, h = page.crop_bits(X0, ytop - PAD_TOP, X1, ybot + PAD_BOT)
    bs = blobs(buf, w, h)
    D = dict(digits=[], bars=[], beams=[], slurs=[], dots=[], dashes=[], other=[])
    for b in bs:
        if b.h >= 55 and b.w <= 10:                     D['bars'].append(b)
        elif b.h <= 6 and b.w >= 40:                    D['beams'].append(b)
        elif 38 <= b.h <= 54 and 12 <= b.w <= 42:       D['digits'].append(b)
        elif 6 <= b.h <= 30 and b.w >= 40 and b.n/(b.w*b.h) < 0.45: D['slurs'].append(b)
        elif b.h <= 13 and b.w <= 13:                   D['dots'].append(b)
        elif b.h <= 9 and 12 <= b.w <= 36:              D['dashes'].append(b)
        else:                                           D['other'].append(b)
    for k in ('digits','bars','beams','slurs','dots','dashes','other'):
        D[k].sort(key=lambda b: b.x0)
    D['ox'], D['oy'] = X0, ytop - PAD_TOP
    D['ytop'], D['ybot'] = ytop, ybot

    # 字形识别
    labeled = []
    for b in D['digits']:
        if RULE_MODE:
            labeled.append([b, classify(b), 1.0])
            continue
        bb = bitmap(b)
        if protos:
            best, sc = '?', 0.0
            for name, pb in protos.items():
                s = iou(bb, pb)
                if s > sc: best, sc = name, s
        else:
            best, sc = guess(b), 1.0
        labeled.append([b, best, sc])
    D['labeled'] = labeled
    if protos is None:                 # 校准模式：顺便建原型
        by = {}
        for b, g, _ in labeled: by.setdefault(g, []).append(b)
        protos = {}
        for g, lst in by.items():
            bmps = [bitmap(b) for b in lst]
            best_i, best_v = 0, -1
            for i, a in enumerate(bmps):
                v = sum(iou(a, c) for j, c in enumerate(bmps) if i != j) / max(1, len(bmps)-1)
                if v > best_v: best_i, best_v = i, v
            protos[g] = bmps[best_i]
        D['protos'] = protos
    return D


def to_md(D):
    """把单系统识别结果拼成 jianpu-md 一行；同时给出每小节拍数自检。

    几何识别难免误挂附点/增时线。这里用**节拍算术当校验器**：某小节时值不为
    2 拍时，枚举该小节内可撤销的记号，取"撤销最少且刚好合 2 拍"的组合。
    这比继续调几何阈值可靠——误挂必然破坏算术，而真记号撤销后算术就对不上。
    """
    from itertools import combinations
    lab = D['labeled']
    if not lab: return '', []
    # 减时线层级（自上而下第几条）
    ys = sorted({b.y0 for b in D['beams']})
    levels = {y: i for i, y in enumerate(ys)}
    def beams_at(b):
        return {levels[bm.y0] for bm in D['beams']
                if bm.x0 - 4 <= b.cx <= bm.x1 + 4 and bm.y0 > b.y1 - 2}

    # ---- 记号归属（按音符下标存）----
    #
    # 出版谱里**附点和增时线都居中排在下一个拍位**，不在字的紧右边
    # （实测离字心 36–84px），所以不能拿"紧贴右侧"的半径去卡；但放太宽又会把
    # 下一个音的高音点抢过来。正确条件是"落在本音与下一个音之间的空档里"。
    up, dn, dot, hold = {}, {}, {}, {}
    cx_all = [t[0].cx for t in lab]
    def left_idx(x):
        k = -1
        for i, c in enumerate(cx_all):
            if c < x: k = i
            else: break
        return k
    def right_idx(x):
        for i, c in enumerate(cx_all):
            if c > x: return i
        return len(cx_all)
    for d in D['dots']:
        t0 = lab[0][0]
        if d.y1 < t0.y0 - 1 or d.y0 > t0.y1 + 1:
            # 八度点画在字的**正上/正下方**，是居中的，不能按"落在字右边"归属，
            # 否则 d.x0 常常略小于字心，会被判给前一个音（低八度记号就会整体错位）。
            near = min(range(len(lab)), key=lambda i: abs(cx_all[i] - d.cx))
            if abs(cx_all[near] - d.cx) > 16: continue    # 离得太远，不是这个音的
            if d.y1 < t0.y0 - 1: up[near] = up.get(near, 0) + 1   # 上方 → 高八度
            else:                dn[near] = dn.get(near, 0) + 1   # 下方 → 低八度
            continue
        li = left_idx(d.x0)
        if li < 0: continue
        t = lab[li][0]
        ri = right_idx(d.x1)
        if ri < len(lab) and d.cx >= lab[ri][0].x0: continue   # 中间还隔着别的音
        if d.cx > t.cx:          dot[li] = 1                   # 同高在右 → 附点
    # 增时线：与字同高的短横。三个坑：
    #   1) s.y0 是裁剪内坐标，yt/yb 是整页坐标，必须换算（用 oy）。
    #   2) D['dashes'] 里混着减时线碎片（h<=9、贴在梁线高度），要按时值线高度
    #      过滤掉，否则会把减时线误算成增时线、凭空加拍。
    #   3) 增时线居中排在下一个拍位，离字可以很远，只能按"落在两音之间"归属。
    for s_ in D['dashes']:
        sy = s_.y0 + D['oy']
        if not (D['ytop'] + 8 <= sy <= D['ytop'] + 34): continue
        li = left_idx(s_.x0)
        if li < 0: continue
        ri = right_idx(s_.x1)
        if ri < len(lab) and s_.cx >= lab[ri][0].x0: continue
        hold[li] = hold.get(li, 0) + 1

    # ---- 圆滑线覆盖 ----
    slur_ranges = []
    for s_ in D['slurs']:
        cover = [i for i, t in enumerate(lab) if s_.x0 - 12 <= t[0].cx <= s_.x1 + 12]
        if len(cover) >= 2: slur_ranges.append((cover[0], cover[-1]))
    slur_open, slur_close = {}, set()
    for a, b_ in slur_ranges:
        slur_open[a] = slur_open.get(a, 0) + 1
        slur_close.add(b_)

    # ---- 小节切分 ----
    nb_all = [len(beams_at(t[0])) for t in lab]
    base = [0.25 * (2 ** max(0, 2 - n)) if n else 1.0 for n in nb_all]  # 16/8/4 分
    bar_xs = sorted(b.cx for b in D['bars'])
    while bar_xs and bar_xs[0] < lab[0][0].x0 - 10: bar_xs.pop(0)
    meas, cur, bx = [], [], list(bar_xs)
    for i, t in enumerate(lab):
        while bx and bx[0] < t[0].x0:
            if cur: meas.append(cur); cur = []
            bx.pop(0)
        cur.append(i)
    if cur: meas.append(cur)

    def dur(i, dt, hd):
        d = base[i]
        if i in dt: d *= 1.5
        return d + hd.get(i, 0)

    # ---- 用节拍算术修补误挂的记号 ----
    repaired = []
    for idxs in meas:
        if abs(sum(dur(i, dot, hold) for i in idxs) - 2) <= 1e-6: continue
        cand = [(i, 'dot') for i in idxs if i in dot]
        cand += [(i, 'hold') for i in idxs if hold.get(i, 0) > 0]
        fixed = False
        for k in range(1, min(4, len(cand)) + 1):
            for sub in combinations(cand, k):
                dt, hd, ok = set(dot), dict(hold), True
                for i, kind in sub:
                    if kind == 'dot':
                        if i not in dt: ok = False; break
                        dt.discard(i)
                    else:
                        if hd.get(i, 0) <= 0: ok = False; break
                        hd[i] -= 1
                if not ok: continue
                if abs(sum(dur(i, dt, hd) for i in idxs) - 2) <= 1e-6:
                    dot, hold, fixed = dt, hd, True
                    break
            if fixed: break
        if fixed: repaired.append(sum(dur(i, dot, hold) for i in idxs))

    # ---- 输出 ----
    out, beat = ['|'], []
    for idxs in meas:
        for i in idxs:
            g = lab[i][1]
            tok = g if g != '?' else '?'
            tok += "'" * up.get(i, 0) + ',' * dn.get(i, 0)
            tok += '-' * hold.get(i, 0)
            tok += '/' * nb_all[i]
            if i in dot: tok += '.'
            out.append('(' * slur_open.get(i, 0) + tok + (')' if i in slur_close else ''))
        out.append('|')
        beat.append(round(sum(dur(i, dot, hold) for i in idxs), 4))
    return ' '.join(out), beat


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'page.pbm'
    only_md = '--md' in sys.argv
    page = Page(path)
    prof = [int.from_bytes(page.data[y*page.stride:(y+1)*page.stride], 'big').bit_count()
            for y in range(page.H)]
    bands, s, last = [], None, 0
    for y, v in enumerate(prof):
        if v >= 120:
            if s is None: s = y
            last = y
        else:
            if s is not None and last - s >= 25: bands.append((s, last))
            s = None
    if s is not None and last - s >= 25: bands.append((s, last))
    # 末行常被压成 27px 高的行带（下半页墨迹少，阈值把它切掉了），放宽下界。
    bands = [b for b in bands if 20 <= b[1]-b[0]+1 <= 60]

    D1 = read_system(page, *bands[0])
    protos = D1.pop('protos')

    # 二阶段：先扫一遍找"不像任何已知字形"的，聚类后按几何特征补进原型库
    # （4：中下部有贯穿横 + 下方竖；7：平顶横 + 左斜，无下碗）
    if '--no-discover' not in sys.argv:
        unk = []
        for i, band in enumerate(bands, 1):
            D = read_system(page, *band) if i == 1 else read_system(page, *band, protos=protos)
            for b, g, sc in D['labeled']:
                if sc < 0.85:
                    unk.append(b)
        clusters = []
        for b in unk:
            bm = bitmap(b)
            hit = None
            for c in clusters:
                if iou(bm, c[0]) >= 0.84:
                    hit = c; break
            if hit: hit[1].append(b)
            else:   clusters.append([bm, [b]])
        for bm, mem in clusters:
            rep = max(mem, key=lambda b: sum(iou(bitmap(b), bitmap(c)) for c in mem))
            W, H = rep.w, rep.h
            cross = max(widest_run(rep, int(H*0.62)), widest_run(rep, int(H*0.72)))
            name = '4' if cross >= 0.9 * W else '7'
            if name not in protos:
                protos[name] = bitmap(rep)
                print(f'# 补原型 {name}：{len(mem)} 个，例 {W}x{H}')

    md = []
    for i, band in enumerate(bands, 1):
        D = read_system(page, *band, protos=protos) if i > 1 else D1
        line, beats = to_md(D)
        md.append((i, band, D, line))
        if only_md: continue
        print(f'\n## 系统 {i}   y={band[0]}-{band[1]}  {len(D["labeled"])} 音')
        print('   ' + line)
        bad = [(j+1, b) for j, b in enumerate(beats) if abs(b - 2.0) > 1e-6]
        print('   拍数 ' + ' '.join(f'{b:g}' for b in beats) +
              ('   ⚠ 不合 2 拍: 第 ' + ','.join(str(j) for j, _ in bad) + ' 小节' if bad else '   ✓ 全部 2 拍'))
        low = [(k, g, sc) for k, (b, g, sc) in enumerate(D['labeled'], 1) if sc < CONF]
        if low: print('   ⚠ 低置信: ' + ' '.join(f'#{k}:{g}({sc:.2f})' for k, g, sc in low))
        if D['other']:
            print('   ? 未归类 ' + ' '.join(f'({b.x0+D["ox"]},{b.y0+D["oy"]},{b.w}x{b.h})' for b in D['other']))
        if D['dashes']:
            print('   dash ' + ' '.join(f'{b.x0+D["ox"]}@{b.y0+D["oy"]}' for b in D['dashes']))
    if only_md:
        print('\n'.join(l for _, _, _, l in md))
    else:
        print('\n\n===== jianpu-md 草稿 =====')
        for i, band, D, line in md:
            print(line)


if __name__ == '__main__':
    main()
