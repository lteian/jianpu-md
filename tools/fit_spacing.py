#!/usr/bin/env python3
"""从扫描件反解排版度量（间距模型）。

出版谱每行都两端对齐，所以行内所有间距被同一个比例 s_i 拉伸。把 s_i 当自由
参数，和全局参数 (m, G, B) 做交替最小二乘：

    gap_ij / s_sys = m + (d_i + d_j)/2 + G*拍边界 + B*跨小节

    m = 最小占位（slot）  G = 拍边界额外留白  B = 跨小节额外留白
    d = 时值（拍）        gap = 相邻音左边界距离（px @300dpi）

w(d) = m + d 是"音符占位"，相邻中心距 = w_i/2 + w_j/2 + 额外 = m + (d_i+d_j)/2 + 额外。
把 m 吸收进常数项，所以 RHS 的常数就是 m。

用法: python3 tools/fit_spacing.py
"""
import sys, statistics
sys.path.insert(0, 'tools')
import scan2jp as S

# ── 已知转录（系统 1-4、8-10 已通过节拍自检）──────────────────────────
DRAFT = {
    0:  "5/ (5// 6//) 5/ (3// 2//) | 5/ (5// 6//) 5/ (3// 2//) | 5// 6// 5// 2// 5// 6// 5// 2// | 3/ (3// 2//) (1// 2//) 3/",
    1:  "5/ (5// 6//) 5/ (3// 2//) | 5/ (5// 6//) 5/ (3// 2//) | 5// 6// 5// 2// 5// 6// 5// 2// | (1// 2//) 6,// 5,// 1 | 3/ (3// 5//) 2/ (2// 5//)",
    2:  "3/ (3// 5//) 2/ (2// 5//) | 4// 5// 4// 3// 2// 3// 2// 1// | 7,// 1// 2// 5// 2// 3// 2// 1// | 7,/ (7,// 1//) 7,/ (7,// 1//)",
    3:  "2/ (2// 5//) 4/ 3/ | 2// 3// 5// 6// 3// 2// 1// 5,// | 1 1 | 5,/ 1// 2// 1/ 5,/ | 5,/ 1// 2// 1/ 5,/",
    7:  "5/ (5// 6//) 5/ (3// 2//) | 5/ (5// 6//) 5/ (3// 2//) | 5// 6// 5// 2// 5// 6// 5// 2// | 3/ (3// 2//) (1// 2//) 3/",
    8:  "5/ (5// 6//) 5/ (3// 2//) | 5/ (5// 6//) 5/ (3// 2//) | 5// 6// 5// 2// 5// 6// 5// 2// | (1// 2//) 6,// 5,// 1 | 3/ (3// 5//) 2/ (2// 5//)",
    9:  "4// 5// 4// 3// 2// 3// 2// 1// | 7,// 1// 2// 5// 2// 3// 2// 1// | 7,/ (7,// 1//) 7,/ (7,// 1//) | 2/ (2// 5//) 4/ 3/",
}
EXPECT = {0: 26, 1: 31, 2: 28, 3: 25, 7: 26, 8: 31, 9: 27}


def duration(tok):
    core = tok.strip('()')
    slashes = len(core) - len(core.rstrip('/'))
    dashes = len(core) - len(core.rstrip('-'))
    dots = len(core) - len(core.rstrip('.'))
    d = 0.5 ** slashes
    d += dashes
    return d * 1.5 ** dots


def parse_line(text):
    out = []
    for mi, meas in enumerate(text.split('|')):
        toks = meas.replace('(', ' ').replace(')', ' ').split()
        t = 0.0
        for j, tk in enumerate(toks):
            d = duration(tk)
            out.append(dict(d=d, t=t, cross=(mi > 0 and j == 0)))
            t += d
    return out


def bands_of(page, thresh=120, minh=20):
    prof = [int.from_bytes(page.data[y*page.stride:(y+1)*page.stride], 'big').bit_count()
            for y in range(page.H)]
    res, s, last = [], None, 0
    for y, v in enumerate(prof):
        if v >= thresh:
            if s is None:
                s = y
            last = y
        else:
            if s is not None and last - s >= minh:
                res.append((s, last))
            s = None
    if s is not None and last - s >= minh:
        res.append((s, last))
    return res


def collect():
    page = S.Page('tools/_page.pbm')
    bands = bands_of(page)
    rows = []
    for key, text in sorted(DRAFT.items()):
        D = S.read_system(page, *bands[key])
        xs = [b.x0 for b, _, _ in D['labeled']]
        notes = parse_line(text)
        if len(xs) != len(notes) or len(xs) != EXPECT[key]:
            print(f'  ! 系统{key+1}: 检出 {len(xs)} 音 / 转录 {len(notes)} / 期望 {EXPECT[key]} — 跳过')
            continue
        bars = sorted(b.cx for b in D['bars'])
        pairs = []
        for i in range(len(xs) - 1):
            gap = xs[i+1] - xs[i]
            cross = any(xs[i] < bb < xs[i+1] for bb in bars)
            t, d = notes[i]['t'], notes[i]['d']
            bb = 1.0 if int(t + d + 1e-9) > int(t + 1e-9) else 0.0
            pairs.append((notes[i]['d'], notes[i+1]['d'], gap, bb, cross))
        rows.append((key, pairs))
        print(f'  系统{key+1}: {len(xs)} 音 {len(pairs)} 间距  中位={statistics.median(p[2] for p in pairs):.0f}px')
    return rows


def lsq3(rows, scale):
    A = [[0.0]*3 for _ in range(3)]
    y = [0.0]*3
    for k, pairs in rows:
        s = scale[k]
        for d1, d2, gap, bb, cross in pairs:
            rhs = gap / s - (d1 + d2) / 2
            row = [1.0, bb, cross]
            for a in range(3):
                for b in range(3):
                    A[a][b] += row[a]*row[b]
                y[a] += row[a]*rhs
    M = [A[i][:] + [y[i]] for i in range(3)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r in range(3):
            if r != c:
                f = M[r][c] / M[c][c]
                for cc in range(c, 4):
                    M[r][cc] -= f * M[c][cc]
    return [M[i][3]/M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(3)]


def fit(rows, iters=80):
    m, G, B = 0.10, 0.30, 0.60
    scale = {k: 1.0 for k, _ in rows}
    for _ in range(iters):
        for k, pairs in rows:                       # ① 固定参数 → 解每行拉伸比
            num = den = 0.0
            for d1, d2, gap, bb, cross in pairs:
                f = m + (d1+d2)/2 + G*bb + B*cross
                num += f*gap
                den += f*f
            scale[k] = num/den if den else 1.0
        m, G, B = lsq3(rows, scale)                 # ② 固定拉伸比 → 解参数
    return m, G, B, scale


def main():
    print('扫描件行带与转录对齐：')
    rows = collect()
    if not rows:
        print('无可对齐数据'); return
    m, G, B, scale = fit(rows)
    print(f'\n解出（slot 单位）： m={m:.4f}  G={G:.4f}  B={B:.4f}')
    print('每行拉伸比 s：' + '  '.join(f'{k+1}:{v:.3f}' for k, v in sorted(scale.items())))

    # 1 slot = ? px：用同一时值对（无额外留白）的间距反推
    vals = []
    for k, pairs in rows:
        for d1, d2, gap, bb, cross in pairs:
            if bb == 0 and not cross:
                vals.append(gap / scale[k] / (m + (d1+d2)/2))
    slotpx = statistics.median(vals)
    print(f'\n1 slot = {slotpx:.2f} px @300dpi   （2/4 一小节 = 2 slot = {2*slotpx:.0f} px）')
    for name, d in (('16分', .25), ('8分', .5), ('4分', 1.0), ('2分', 2.0)):
        print(f'  w({name}) = {(m+d)*slotpx:6.1f} px')
    print(f'  拍边界额外 = {G*slotpx:.1f} px    跨小节额外 = {B*slotpx:.1f} px')

    # 换算到 SVG 用户单位（viewBox 794 宽对应 2480px → 3.123 px/unit）
    PXU = 2480/794
    print(f'\n换算到 layout.ts（1 unit = {PXU:.4f} px）：')
    print(f'  MIN_SLOT   = {m:.4f}      （原 0.217）')
    print(f'  slot       = {slotpx/PXU:.2f}   （原 38.2）')
    print(f'  BEAT_GAP_SLOT = {G:.4f}   （原 0.267）')
    print(f'  PAD        = {B/2*slotpx/PXU:.2f}   （原 12.4）')


if __name__ == '__main__':
    main()
