#!/usr/bin/env python3
"""
本地预览服务器 + 一个小的保存接口（带 no-store，改完刷新就能看到）。

    python3 tools/serve.py            # http://0.0.0.0:8080/
    python3 tools/serve.py 9000       # 换端口

为什么要自己写：工作台要能"保存"，而 `python3 -m http.server` 只能读。
这里多出三个接口（只用标准库——这台机器上 numpy / PIL 都是坏的）：

    GET  /api/ping           → {"ok": true, "root": "..."}
    GET  /api/files          → examples/ 和 scores/ 下的 .md/.txt 列表
    POST /api/save           → {"path": "scores/foo.md", "text": "..."} 写文件

写入范围**只限** examples/ 与 scores/ 下的 .md/.txt，越界一律 403。
"""
import os
import re
import sys
import json
import hashlib
import functools
import http.server
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

ALLOW_DIRS = ('examples', 'scores')
ALLOW_EXT = ('.md', '.txt')
MAX_BODY = 4 * 1024 * 1024

# 静态资源里的 `?v=00000000` 是占位符，发出去前换成内容指纹。
# 指纹固定 8 位十六进制，替换后长度不变，所以 Content-Length 不用重算。
REF_RE = re.compile(r"""(["'])((?:\.\.?/)[A-Za-z0-9_.\-/]+\.(?:js|css))\?v=[0-9a-fA-F]{8}\1""")
FINGERPRINTED = ('.html', '.js', '.css')


def fingerprint(fp):
    """8 位内容指纹：mtime + size + 前 4KB 的哈希。改一个字就会变。"""
    try:
        st = os.stat(fp)
        with open(fp, 'rb') as f:
            head = f.read(4096)
        h = hashlib.sha1(head)
        h.update(b'%d:%d' % (st.st_mtime_ns, st.st_size))
        return h.hexdigest()[:8]
    except OSError:
        return '00000000'


def resolve(rel):
    """把前端给的相对路径变成绝对路径；不合法返回 (None, 原因)"""
    if not isinstance(rel, str) or not rel.strip():
        return None, '路径为空'
    rel = rel.strip().lstrip('/')
    if '..' in rel.split('/'):
        return None, '不允许 ..'
    p = os.path.normpath(os.path.join(ROOT, rel))
    if not (p == ROOT or p.startswith(ROOT + os.sep)):
        return None, '越出项目目录'
    top = os.path.relpath(p, ROOT).split(os.sep)[0]
    if top not in ALLOW_DIRS:
        return None, '只能写到 ' + ' / '.join(ALLOW_DIRS)
    if not p.lower().endswith(ALLOW_EXT):
        return None, '只能写 .md / .txt'
    return p, None


def rewrite_versions(raw, base, _cache=None):
    """把 `./app.js?v=00000000` 换成 `./app.js?v=<指纹>`（路径按 base 解析）"""
    cache = _cache if _cache is not None else {}

    def repl(m):
        q, rel = m.group(1), m.group(2)
        fp = os.path.normpath(os.path.join(base, rel))
        if fp not in cache:
            cache[fp] = fingerprint(fp)
        return '%s%s?v=%s%s' % (q, rel, cache[fp], q)

    return REF_RE.sub(repl, raw)


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = 'jianpu-serve/1.0'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/ping':
            return self.send_json({'ok': True, 'root': ROOT, 'port': self.server.server_address[1]})
        if path == '/api/files':
            out = []
            for d in ALLOW_DIRS:
                full = os.path.join(ROOT, d)
                if not os.path.isdir(full):
                    continue
                for name in sorted(os.listdir(full)):
                    if not name.lower().endswith(ALLOW_EXT):
                        continue
                    fp = os.path.join(full, name)
                    if not os.path.isfile(fp):
                        continue
                    st = os.stat(fp)
                    out.append({'path': d + '/' + name, 'name': name, 'dir': d,
                                'size': st.st_size, 'mtime': int(st.st_mtime)})
            return self.send_json(out)
        return super().do_GET()

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        if self.path.split('?')[0] != '/api/save':
            return self.send_json({'ok': False, 'error': '不认识的接口'}, 404)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self.send_json({'ok': False, 'error': '长度不对'}, 400)
        if n <= 0 or n > MAX_BODY:
            return self.send_json({'ok': False, 'error': '内容为空或太大'}, 400)
        try:
            payload = json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception as e:
            return self.send_json({'ok': False, 'error': 'JSON 解析失败：%s' % e}, 400)

        p, err = resolve(payload.get('path'))
        if err:
            return self.send_json({'ok': False, 'error': err}, 403)
        text = payload.get('text')
        if not isinstance(text, str):
            return self.send_json({'ok': False, 'error': 'text 必须是字符串'}, 400)

        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            # 先写临时文件再改名，写到一半断掉不会把原文件毁掉
            tmp = p + '.tmp-%d' % os.getpid()
            with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
            os.replace(tmp, p)
        except Exception as e:
            return self.send_json({'ok': False, 'error': '写入失败：%s' % e}, 500)

        rel = os.path.relpath(p, ROOT).replace(os.sep, '/')
        sys.stderr.write('saved %s (%d bytes)\n' % (rel, len(text.encode('utf-8'))))
        return self.send_json({'ok': True, 'path': rel, 'size': len(text.encode('utf-8'))})

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def copyfile(self, source, outputfile):
        """把 HTML/JS/CSS 里的 `?v=00000000` 换成真实指纹再发出去。

        为什么非做不可：`no-store` 只在「浏览器每次都会问服务器」时管用。
        用户之前用旧版服务器打开过页面，缓存里躺着一份 app.js，之后改代码刷新
        还是跑旧逻辑（这节就是被这个坑坑出来的）。URL 一变缓存必然失效。
        指纹 8 位定长，替换后字节数不变，Content-Length 天然对得上。
        """
        fp = getattr(source, 'name', '') or self.translate_path(self.path)
        if fp.lower().endswith(FINGERPRINTED) and os.path.isfile(fp):
            try:
                with open(fp, 'rb') as f:
                    raw = f.read().decode('utf-8')
                data = rewrite_versions(raw, os.path.dirname(fp)).encode('utf-8')
                if len(data) == os.path.getsize(fp):
                    outputfile.write(data)
                    return
            except Exception:
                pass
        return super().copyfile(source, outputfile)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    handler = functools.partial(Handler, directory=ROOT)
    with Server(('0.0.0.0', PORT), handler) as httpd:
        print(f'jianpu-md 预览服务器  http://0.0.0.0:{PORT}/web/   (根目录 {ROOT})', flush=True)
        print(f'保存接口：POST /api/save（只写 {" / ".join(ALLOW_DIRS)} 下的 .md/.txt）', flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
