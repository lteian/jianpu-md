/**
 * Obsidian 插件：简谱（jianpu-md）
 *
 * 像 mermaid 那样用：
 *
 *     ```jianpu
 *     ---
 *     title: 小星星
 *     key: 1=C
 *     time: 4/4
 *     ---
 *     | 1 2 3 4 | 5 5 5 5 |
 *     ```
 *
 * 代码块里可以带 frontmatter（和 jianpu-md 的文件格式完全一样），
 * 渲染引擎直接复用仓库里的 src/，所以工作台里看到的谱面这里一字不差。
 */
import { Notice, Plugin, PluginSettingTab, Setting, type App } from 'obsidian';
import { compile } from '../src/index.js';
import { buildBlock, playDoc, renderJianpu, stopAll } from './render.js';

interface JianpuSettings {
  /** 默认纸型：空 = 跟随代码块里的 frontmatter */
  paper: string;
  /** 默认方向 */
  orientation: string;
  /** 工具条 */
  toolbar: boolean;
  /** 播放时高亮当前音 */
  highlight: boolean;
  /** 缩放：0 = 适应宽度 */
  zoom: number;
}

const DEFAULT_SETTINGS: JianpuSettings = {
  paper: '',
  orientation: '',
  toolbar: true,
  highlight: true,
  zoom: 0,
};

export default class JianpuPlugin extends Plugin {
  settings: JianpuSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // ```jianpu 代码块
    this.registerMarkdownCodeBlockProcessor('jianpu', (source, el) => {
      renderJianpu(source, el, this.opts());
    });

    this.addCommand({
      id: 'copy-svg',
      name: '复制当前笔记的简谱 SVG',
      callback: async () => {
        const text = await this.currentNoteSource();
        if (text == null) return;
        const svg = this.toSvg(text);
        if (!svg) return;
        await navigator.clipboard.writeText(svg);
        new Notice('简谱 SVG 已复制到剪贴板');
      },
    });

    this.addCommand({
      id: 'export-svg',
      name: '把当前笔记的简谱导出成 SVG 文件',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('先打开一个笔记'); return; }
        const text = await this.currentNoteSource();
        if (text == null) return;
        const svg = this.toSvg(text);
        if (!svg) return;
        const path = file.path.replace(/\.md$/i, '') + '.svg';
        try {
          await this.app.vault.create(path, svg);
          new Notice(`已导出 ${path}`);
        } catch (e) {
          new Notice('导出失败：' + (e instanceof Error ? e.message : String(e)));
        }
      },
    });

    this.addCommand({
      id: 'play-note',
      name: '播放当前笔记的简谱',
      callback: async () => {
        const text = await this.currentNoteSource();
        if (text == null) return;
        const r = buildBlock(text, this.opts());
        if ('error' in r) { new Notice(r.error); return; }
        await playDoc(r.doc, undefined, this.settings.highlight);
      },
    });

    this.addSettingTab(new JianpuSettingTab(this.app, this));
  }

  onunload(): void {
    stopAll();
  }

  private opts() {
    return {
      paper: this.settings.paper,
      orientation: this.settings.orientation,
      toolbar: this.settings.toolbar,
      highlight: this.settings.highlight,
      zoom: this.settings.zoom,
    };
  }

  /** 当前笔记 → SVG 文本（多页拼在一起） */
  private toSvg(source: string): string | null {
    try {
      const o: { paper?: string; orientation?: string } = {};
      if (this.settings.paper) o.paper = this.settings.paper;
      if (this.settings.orientation) o.orientation = this.settings.orientation;
      const r = compile(source, o);
      if (!r.layout.pages.length) return null;
      return `<?xml version="1.0" encoding="UTF-8"?>\n${r.svg.replace(/<\?xml[^>]*\?>/g, '')}`;
    } catch (e) {
      new Notice('渲染失败：' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  private async currentNoteSource(): Promise<string | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('先打开一个笔记'); return null; }
    if (file.extension !== 'md') { new Notice('当前不是 Markdown 笔记'); return null; }
    return await this.app.vault.read(file);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class JianpuSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JianpuPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('默认纸型').setDesc('留空 = 跟随代码块里的 frontmatter（paper: A4）')
      .addText((t) => t.setValue(this.plugin.settings.paper).setPlaceholder('A4 / A5 / B5 / Letter')
        .onChange(async (v) => { this.plugin.settings.paper = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('默认方向').setDesc('留空 = 跟随代码块里的 frontmatter')
      .addText((t) => t.setValue(this.plugin.settings.orientation).setPlaceholder('portrait / landscape')
        .onChange(async (v) => { this.plugin.settings.orientation = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('显示工具条')
      .addToggle((t) => t.setValue(this.plugin.settings.toolbar)
        .onChange(async (v) => { this.plugin.settings.toolbar = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('播放时高亮当前音')
      .addToggle((t) => t.setValue(this.plugin.settings.highlight)
        .onChange(async (v) => { this.plugin.settings.highlight = v; await this.plugin.saveSettings(); }));
  }
}
