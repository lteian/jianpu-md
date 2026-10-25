/**
 * 浏览器预览版：不依赖 Obsidian，用来在浏览器里验证渲染效果与播放高亮
 * （Obsidian 里就是这套 DOM + plugin/styles.css）。
 */
import { renderJianpu } from './render.js';

const SRC = `---
title: 小星星
key: 1=C
time: 4/4
tempo: 96
tuning: 1-5 弦（内 D / 外 A）
---

| 1 2 3 4 | 5 5 5 5 | 3 3 3 3 | 1 1 1 1 |
| 2 4 4 3 | 2 2 2 - | 4 4 3 3 | 2 2 1 - |
`;

const host = document.getElementById('out') as HTMLElement;
renderJianpu(SRC, host, { toolbar: true, highlight: true, zoom: 0 });

// 再来一段带记号和休止的
const host2 = document.getElementById('out2') as HTMLElement;
renderJianpu(`---
title: 记号与光标
key: 1=D
time: 2/4
---

| 1'/@la ( 1'// 2'// ) 1'/ ( 6// 5// ) | 5@> 4@> 3@> 2@> |
`, host2, { toolbar: true, highlight: true, zoom: 0 });
