#!/usr/bin/env python3
"""全页字形聚类：发现实际出现的字形种类，输出每类特征 + ASCII 图样。

给 scan2jp.py 的原型库补上 4 / 7 / 0 等系统 1 里没出现的字形。
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan2jp import Page, read_system, bitmap  # noqa

NW, NH = 30, 44


def rows_of(b, nw=NW, nh=NH):
    m, w, h = bitmap(b)
    out = []
    for y in range(nh):
        sy = min(h - 1, int(y * h / nh))
        out.append(''.join('#' if m[sy * w + min(w - 1, int(x * w / nw))] else '.' for x in range(nw)))
    return out


def iou(a, b):
    inter = union = 0
    for ra, rb in zip(a, b):
        for x, y in zip(ra, rb):
            if x == '#' or y == '#':
                union += 1
                if x == '#' and y == '#':
                    inter += 1
    return inter / union if union else 0.0


def holes(rows):
    H, W = len(rows), len(rows[0])
    seen = [[0] * W for _ in range(H)]
    q = []
    for x in range(W):
        for y in (0, H - 1):
            if rows[y][x] == '.' and not seen[y][x]:
                seen[y][x] = 1; q.append((x, y))
    for y in range(H):
        for x in range(W):
            if x in (0, W - 1) and rows[y][x] == '.' and not seen[y][x]:
                seen[y][x] = 1; q.append((x, y))
    while q:
        cx, cy = q.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < W and 0 <= ny < H and rows[ny][nx] == '.' and not seen[ny][nx]:
                seen[ny][nx] = 1; q.append((nx, ny))
    out = []
    for y in range(H):
        for x in range(W):
            if rows[y][x] == '.' and not seen[y][x]:
                st = [(x, y)]; seen[y][x] = 1; area = 0; sy = 0
                while st:
                    cx, cy = st.pop(); area += 1; sy += cy
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < W and 0 <= ny < H and rows[ny][nx] == '.' and not seen[ny][nx]:
                            seen[ny][nx] = 1; st.append((nx, ny))
                if area >= 20:
                    out.append((area, round(sy / area / H, 2)))
    return sorted(out, reverse=True)


def runs(rows, y):
    r, s = [], None
    for x, ch in enumerate(rows[y]):
        if ch == '#' and s is None:
            s = x
        if ch != '#' and s is not None:
            r.append((s, x - 1)); s = None
    if s is not None:
        r.append((s, len(rows[y]) - 1))
    return r


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

    items = []
    for band in bands:
        D = read_system(page, *band)
        for blob, _g, _s in D['labeled']:
            items.append((rows_of(blob), blob))
    print(f'# {len(bands)} 个系统，共 {len(items)} 个字形')

    clusters = []
    for rows, blob in items:
        best, bi = 0.0, -1
        for i, c in enumerate(clusters):
            sc = iou(rows, c[0])
            if sc > best:
                best, bi = sc, i
        if best >= 0.90:
            clusters[bi][1].append(blob)
        else:
            clusters.append([rows, [blob], blob])
    clusters.sort(key=lambda c: -len(c[1]))
    print(f'# 聚出 {len(clusters)} 类\n')

    for i, (rows, mem, ex) in enumerate(clusters):
        hs = holes(rows)
        top = rows[0].count('#')
        r4 = runs(rows, 4)
        print(f'== 类{i}  {len(mem)} 个   例 {ex.w}x{ex.h}  洞={hs}  '
              f'顶横={top}/{NW}={top / NW:.2f}  y4段={len(r4)}  (x={[b.x0 for b in mem[:6]]})')
        for r in rows:
            print('   ' + r)
        print()


if __name__ == '__main__':
    main(sys.argv[1])
