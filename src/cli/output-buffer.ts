/**
 * OutputBuffer — 备用屏滚动缓冲（纯数据层）。
 *
 * 程序接管屏幕渲染：所有输出先进内存缓冲（lines），屏幕只显示可视窗口。
 * 历史内容滚出窗口后仍留在内存，鼠标滚轮上下滑动回看。
 *
 * 为什么需要它：Terminal.app 的渲染层（CoreGraphics/Metal）有 malloc 内存损坏 bug，
 * 当「历史 + 多行输入」同时可见、屏幕内容复杂时，每次重绘都可能踩雷崩溃。
 * 程序自建缓冲 + 只渲染简单可视窗口，从源头控制屏幕复杂度。
 */
export class OutputBuffer {
  /** 全部历史输出行（权威数据，滚出窗口不丢） */
  private lines: string[] = [];
  /** 视窗起始行（0 = 最新内容在底部）。值越大视窗越靠上 = 看到越旧内容 */
  private scrollPos = 0;

  /** 追加一段输出（可能含 \n，按行拆进 lines），并自动滚到底部 */
  append(text: string): void {
    const parts = text.split('\n');
    for (const p of parts) this.lines.push(p);
    this.scrollPos = Math.max(0, this.lines.length - 1);
  }

  /** 滚动：正数向下（看更新），负数向上（看更旧） */
  scroll(delta: number): void {
    this.scrollPos = Math.max(0, Math.min(this.lines.length - 1, this.scrollPos + delta));
  }

  /** 清空缓冲（新会话） */
  clear(): void {
    this.lines = [];
    this.scrollPos = 0;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get currentScroll(): number {
    return this.scrollPos;
  }

  /**
   * 返回可视窗口的历史行（旧在上、新在下）。
   * @param viewportHeight 可视窗口高度（行数）
   */
  visible(viewportHeight: number): string[] {
    const h = Math.max(1, viewportHeight);
    const start = Math.max(0, this.scrollPos - h + 1);
    return this.lines.slice(start, this.scrollPos + 1);
  }
}
