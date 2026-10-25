#!/usr/bin/env python3
"""用系统 1 的原型给全页字形打标签，剩下的未知字形单独聚类并打印 1:1 图样。"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan2jp import Page, read_system, bitmap  # noqa

SHIFT = 2


def padded(b, pad=SHIFT + 2):
    m, w, h = bitmap(b)
    W, H = w + 2 * pad, h + 2 * pad
    g = [[0] * W for _ in range(H)]
    for y in range(h):
        for x in range(w):
            if m[y * w + x]:
                g[y + pad][x + pad] = 1
    return g, w, h


def iou_shift(A, B):
    """A,B = (grid,w,h)；以左上角对齐 + 平移搜索，取最大 IoU"""
    ga, wa, ha = A
    gb, wb, hb = B
    best = 0.0
    for dy in range(-SHIFT, SHIFT + 1):
        for dx in range(-SHIFT, SHIFT + 1):
            inter = union = 0
            ya0 = max(0, dy); yb0 = max(0, -dy)
            xa0 = max(0, dx); xb0 = max(0, -dx)
            hh = min(ha - ya0, hb - yb0)
            ww = min(wa - xa0, wb - xb0)
            if hh <= 0 or ww <= 0:
                continue
            for y in range(hh):
                ra = ga[ya0 + y]
                rb = gb[yb0 + y]
                for x in range(ww):
                    a = ra[xa0 + x]; b = rb[xb0 + x]
                    if a or b:
                        union += 1
                        if a and b:
                            inter += 1
            if union:
                v = inter / union
                if v > best:
                    best = v
    return best


def ascii_of(b, label=''):
    m, w, h = bitmap(b)
    print(f'   {label}{w}x{h}')
    for y in range(h):
        print('   ' + ''.join('#' if m[y * w + x] else '.' for x in range(w)))


def main(path):
    page = Page(path)
    prof = [int.from_bytes(page.data[y * page.stride:(y + 1) * page.stride], 'big').bit_count()
            for y in range(page.H)]
    bands, s, last = [], None, 0
    for y, v in enumerate(prof):
        if v >= 120:
            if s is None: s = y
            last = y
        else:
            if s is not None and last - s >= 25:
                bands.append((s, last))
            s = None
    if s is not None and last - s >= 25:
        bands.append((s, last))
    bands = [b for b in bands if 40 <= b[1] - b[0] + 1 <= 60]

    allg = []
    for i, band in enumerate(bands):
        D = read_system(page, *band)
        allg.append(D['digits'])

    # 原型：系统 1 每个几何判定的类取中位样本
    first = allg[0]
    from scan2jp import guess
    by = {}
    for b in first:
        by.setdefault(guess(b), []).append(b)
    protos = {}
    for g, lst in by.items():
        P = [padded(b) for b in lst]
        best_i, best_v = 0, -1
        for i, a in enumerate(P):
            v = sum(iou_shift(a, c) for j, c in enumerate(P) if i != j) / max(1, len(P) - 1)
            if v > best_v:
                best_i, best_v = i, v
        protos[g] = P[best_i]
    print('原型:', {g: f'{p[1]}x{p[2]}' for g, p in protos.items()}, '\n')

    stats = {g: [0, 0.0] for g in protos}
    unknown = []
    for si, lst in enumerate(allg, 1):
        row = []
        for b in lst:
            A = padded(b)
            best, sc = '?', 0.0
            for g, P in protos.items():
                v = iou_shift(A, P)
                if v > sc:
                    best, sc = g, v
            if sc >= 0.85:
                stats[best][0] += 1
                stats[best][1] += sc
            else:
                unknown.append((si, b, sc, best))
            row.append(f'{best}{"" if sc >= 0.85 else "?"}')
        print(f'系统{si}: ' + ' '.join(row))
    print()
    for g in sorted(stats):
        n, tot = stats[g]
        print(f'  {g}: {n} 个  平均分 {tot/n if n else 0:.3f}')
    print(f'\n未知字形 {len(unknown)} 个')

    # 未知字形自聚类
    clusters = []
    for si, b, sc, best in unknown:
        A = padded(b)
        hit = None
        for c in clusters:
            if iou_shift(A, c[0]) >= 0.84:
                hit = c; break
        if hit:
            hit[1].append((si, b))
        else:
            clusters.append([A, [(si, b)]])
    clusters.sort(key=lambda c: -len(c[1]))
    print(f'未知聚成 {len(clusters)} 类')
    for i, (A, mem) in enumerate(clusters):
        print(f'\n== 未知类{i}: {len(mem)} 个  '
              f'出现于 ' + ','.join(f's{a}#{k}' for k, (a, _) in enumerate(mem[:8], 1)))
        ascii_of(mem[0][1], f'{mem[0][1].w}x{mem[0][1].h} ')


if __name__ == '__main__':
    main(sys.argv[1])
