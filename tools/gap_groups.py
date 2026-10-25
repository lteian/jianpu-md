#!/usr/bin/env python3
"""按行、按时值对分组，输出扫描件的间距分布。用来直接读结构，不做盲拟合。

    gap = a + b * (d1+d2)/2   （仅同行、同小节、无拍边界）
    b = 该行 px/拍   a/b = 最小占位 m（slot）
"""
import sys, statistics
sys.path.insert(0, 'tools')
import scan2jp as S
from fit_spacing import DRAFT, EXPECT, parse_line, bands_of


def row_data(page, bands, key):
    D = S.read_system(page, *bands[key])
    xs = [b.x0 for b, _, _ in D['labeled']]
    notes = parse_line(DRAFT[key])
    bars = sorted(b.cx for b in D['bars'])
    recs = []
    for i in range(len(xs) - 1):
        gap = xs[i+1] - xs[i]
        t, d, nd = notes[i]['t'], notes[i]['d'], notes[i+1]['d']
        bb = int(t + d + 1e-9) > int(t + 1e-9) and int(t + 1e-9) * 1.0 != t + 1e-9 and (t + d) % 1 < 1e-9
        bb = 1 if (int(t + d + 1e-9) > int(t + 1e-9)) else 0
        cross = any(xs[i] < b < xs[i+1] for b in bars)
        recs.append(dict(d1=d, d2=nd, gap=gap, bb=bb, cross=cross, t=t))
    return xs, recs


def regress(pts):
    """pts=[(x,y)] → (a,b)"""
    n = len(pts)
    if n < 2:
        return None
    sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
    sxx = sum(p[0]*p[0] for p in pts); sxy = sum(p[0]*p[1] for p in pts)
    det = n*sxx - sx*sx
    if abs(det) < 1e-9:
        return None
    b = (n*sxy - sx*sy)/det
    a = (sy - b*sx)/n
    return a, b


def main():
    page = S.Page('tools/_page.pbm')
    bands = bands_of(page)
    print('每行：按时值对分组的间距（px @300dpi，取左边界差）\n')
    allrecs = {}
    for key in sorted(DRAFT):
        xs, recs = row_data(page, bands, key)
        allrecs[key] = recs
        groups = {}
        for r in recs:
            if r['cross']:
                continue
            groups.setdefault((r['d1'], r['d2'], r['bb']), []).append(r['gap'])
        print(f'系统{key+1}  ({len(xs)}音, 净宽 {xs[-1]-xs[0]}px)')
        for k in sorted(groups):
            v = groups[k]
            print(f'   {k[0]:<5}→{k[1]:<5} bb={k[2]}  n={len(v):<2} 中位={statistics.median(v):5.1f}  {sorted(v)}')
        # 回归：只用无拍边界、非跨小节
        pts = [((r['d1']+r['d2'])/2, r['gap']) for r in recs if r['bb'] == 0 and not r['cross']]
        g = regress(pts)
        if g:
            a, b = g
            print(f'   → 回归 gap = {a:.1f} + {b:.1f}·x   即 {b:.1f}px/拍, m={a/b:+.3f} slot\n')
        else:
            print('   → 无法回归\n')

    # 用各行 b 的中位数定 slot；用同行 bb 差值定 G；跨小节差值定 B
    bs = []
    for key, recs in allrecs.items():
        pts = [((r['d1']+r['d2'])/2, r['gap']) for r in recs if r['bb'] == 0 and not r['cross']]
        g = regress(pts)
        if g and g[1] > 0:
            bs.append((key, g[0], g[1]))
    print('各行 px/拍：', '  '.join(f'{k+1}:{b:.0f}(m={a/b:+.2f})' for k, a, b in bs))

    Gs = []
    for key, recs in allrecs.items():
        b = dict((k, bb) for k, a, bb in bs).get(key)
        if not b:
            continue
        for r in recs:
            if r['bb'] and not r['cross']:
                base = b*((r['d1']+r['d2'])/2)
                Gs.append(r['gap'] - base)
    if Gs:
        print(f'\n拍边界额外留白（已扣时值项）: 中位 {statistics.median(Gs):.1f}px  n={len(Gs)}  {sorted(round(g) for g in Gs)}')
    Bs = []
    for key, recs in allrecs.items():
        b = dict((k, bb) for k, a, bb in bs).get(key)
        if not b:
            continue
        for r in recs:
            if r['cross']:
                base = b*((r['d1']+r['d2'])/2)
                Bs.append(r['gap'] - base)
    if Bs:
        print(f'跨小节额外留白: 中位 {statistics.median(Bs):.1f}px  n={len(Bs)}  {sorted(round(g) for g in Bs)}')


if __name__ == '__main__':
    main()
