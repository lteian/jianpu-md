#!/usr/bin/env python3
"""把渲染结果和扫描件用同一套探针量，逐时值对比间距。

用法: python3 tools/vs_scan.py <in.md> [--html]
步骤: compile → SVG → rsvg-convert -w 2480 → 二值化 PBM → 行带 → 连通块 → 间距分组
"""
import sys, os, subprocess, statistics, tempfile
sys.path.insert(0, 'tools')
import scan2jp as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'bin', 'jianpu.mjs')


def render(pdf_md, outdir):
    svg = os.path.join(outdir, 'cmp.svg')
    png = os.path.join(outdir, 'cmp.png')
    pbm = os.path.join(outdir, 'cmp.pbm')
    subprocess.run(['node', CLI, pdf_md, '-o', svg, '--quiet'], check=True, cwd=ROOT)
    subprocess.run(['rsvg-convert', '-w', '2480', svg, '-o', png], check=True)
    subprocess.run(['convert', png, '-colorspace', 'Gray', '-threshold', '55%',
                    '-compress', 'Zip', 'pbm:' + pbm], check=True)
    return pbm


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


def main():
    md = sys.argv[1]
    with tempfile.TemporaryDirectory() as td:
        pbm = render(md, td)
        page = S.Page(pbm)
        bands = bands_of(page)
        print(f'{os.path.basename(md)}: {len(bands)} 行带  {page.W}×{page.H}')
        for k, (y0, y1) in enumerate(bands):
            D = S.read_system(page, y0, y1)
            xs = [b.x0 for b, _, _ in D['labeled']]
            bars = sorted(b.cx for b in D['bars'])
            if len(xs) < 3:
                continue
            print(f'\n行{k+1} y={y0}-{y1} {len(xs)}音 净宽{xs[-1]-xs[0]}px 首x={xs[0]} 末x={xs[-1]}')
            gaps = [xs[i+1]-xs[i] for i in range(len(xs)-1)]
            print(f'  间距: {gaps}')
            cross = [g for i, g in enumerate(gaps) if any(xs[i] < b < xs[i+1] for b in bars)]
            print(f'  跨小节间距: {cross}')
    # 扫描件同项对照
    sp = S.Page(os.path.join(ROOT, 'tools', '_page.pbm'))
    sb = bands_of(sp)
    print('\n—— 扫描件对照 ——')
    for k in (0, 1, 7):
        y0, y1 = sb[k]
        D = S.read_system(sp, y0, y1)
        xs = [b.x0 for b, _, _ in D['labeled']]
        bars = sorted(b.cx for b in D['bars'])
        gaps = [xs[i+1]-xs[i] for i in range(len(xs)-1)]
        print(f'  系统{k+1}: {len(xs)}音 净宽{xs[-1]-xs[0]}px 首x={xs[0]} 末x={xs[-1]}')


if __name__ == '__main__':
    main()
