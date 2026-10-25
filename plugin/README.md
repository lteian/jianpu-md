# 简谱（jianpu-md）· Obsidian 插件

在 Obsidian 笔记里像 mermaid 一样写简谱：

````markdown
```jianpu
---
title: 小星星
key: 1=C
time: 4/4
tempo: 96
---

| 1 2 3 4 | 5 5 5 5 | 3 3 3 3 | 1 1 1 1 |
```
````

渲染出来就是打印级的谱面，可以直接播放（二胡音色），播放时当前音会变红。

## 安装

插件就是三个文件，拷进 vault 的插件目录即可：

```
<你的 vault>/.obsidian/plugins/jianpu-md/
    main.js
    manifest.json
    styles.css
```

**Windows 上的路径**是：

```
%APPDATA%\obsidian\<你的库名>\.obsidian\plugins\jianpu-md\
```

拷好以后：Obsidian → 设置 → 第三方插件 → 先关掉「安全模式」→ 找到「Jianpu MD」→ 打开。

### 下载打包好的插件

每次 Release 都会带上打包好的 zip，从 GitHub Releases 页面下载即可：

- 插件包：GitHub Releases 里的 `jianpu-md.zip`
- 也可以只取 Release 附件里的 `main.js` / `manifest.json` / `styles.css` 三个文件

下载 zip 解压，把里面的 `jianpu-md` 文件夹整个丢进 `.obsidian/plugins/` 就行。

## 用法

### 代码块

````
```jianpu
（frontmatter 可省）
---
paper: A5            # A3 / A4 / A5 / B5 / Letter
orientation: 横版
spacing: 0.93
tempo: 120
---

（谱面，跟工作台的 .md 文件一模一样）
| 1'/@la ( 1'// 2'// ) 1'/ ( 6// 5// ) |

R18                    ← 整段不演奏（多小节休止）
```
````

代码块里的内容就是 jianpu-md 文件本身，**工作台里能写的一切这里都能写**：
八度点、弓法、指法与弦位、附点、增时线、减时线、多小节休止、行距…

### 工具条

每段谱子右上角有一条小工具栏：

- **▶ 播放** —— 二胡音色播放，当前音会变红
- **■** 停止
- **− / ＋ / 适应** —— 缩放（「适应」= 铺满笔记宽度）

### 命令（命令面板里搜「简谱」）

- 复制当前笔记的简谱 SVG
- 把当前笔记的简谱导出成 SVG 文件
- 播放当前笔记的简谱

### 设置（设置 → 简谱）

- 默认纸型 / 默认方向：留空 = 跟随代码块里的 frontmatter
- 显示工具条
- 播放时高亮当前音

## 自己编译

```bash
npm install
npm run plugin:pack       # → plugin/main.js + dist-plugin/
```

`plugin/preview.html` 是浏览器预览版（不依赖 Obsidian），改完样式可以先看效果：
`python3 tools/serve.py 8080` 之后打开 <http://127.0.0.1:8080/plugin/preview.html>。
