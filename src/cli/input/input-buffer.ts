/**
 * 输入缓冲 — 自建行编辑器（模式无关）：raw mode + 自管 stdin + bracketed paste + 光标编辑 + 折行 echo。
 * 状态机在 input-model.ts（纯逻辑）；本文件只负责 I/O 驱动 + 渲染（经 ScreenStateLike）。
 *
 * 模式特有行为（滚动键、追加 echo、退出清理）通过 InputDriver 注入，本文件不感知具体模式，
 * 让备用屏/主屏可以独立设计、独立解决问题。
 */
import { createModel, applyChunk } from './input-model.js';
import type { ScreenStateLike, InputDriver } from '../render/types.js';

/**
 * 从输入流切出一个「完整单元」：转义序列（方向键/PgUp/PgDn/鼠标 SGR 等）作为一个单元，
 * 普通文本取到下一个 \x1b 前的连续段作为一个单元。
 * 返回 null 表示当前是残缺转义序列（如只剩 \x1b 或 \x1b[<64），需等后续 chunk 拼齐。
 *
 * 背景：终端可能把多次按键/鼠标事件合并进同一个 chunk（\x1b[D\x1b[D），
 * 也可能把一个转义序列拆成多个 chunk（\x1b 和 [D 分开）。若不按单元切分，
 * 合并的箭头键会被当普通文本、拆开的鼠标事件会污染输入（光标/删除键异常）。
 */
/** 从待处理缓冲里切出一个可处理单元（普通文本段 / 完整转义序列）。导出供回归测试。 */
export function extractUnit(s: string): string | null {
  if (s[0] !== '\x1b') {
    let i = 0;
    while (i < s.length && s[i] !== '\x1b') i++;
    return s.slice(0, i);  // 普通文本段（可为空，仅当 s 首字符是 \x1b 时不会走到这里）
  }
  if (s.length < 2) return null;  // 只剩 \x1b，等后续
  const c1 = s.charCodeAt(1);
  if (c1 === 0x5b /* [ */ || c1 === 0x4f /* O */) {
    // CSI/SS3：终止字节在 0x40-0x7e（字母/~ 等）
    for (let i = 2; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return s.slice(0, i + 1);
    }
    return null;  // 不完整，等后续
  }
  return s.slice(0, 2);  // 两字节转义（如 \x1bM）
}

/**
 * 把「文字 + 结尾回车」拆成两段。
 *
 * 为什么需要：一次 stdin read 里同时拿到「文字\r」很常见（打字快、粘贴后立刻回车、
 * 慢链路上字节合并）。整段交给 applyChunk 时 chunk !== '\r'，会走「普通输入」分支，
 * 回车被当成**内容换行**塞进缓冲区 —— 表现为「按了回车却没提交」，
 * 输入框里还多一个看不见的换行。
 *
 * 只拆结尾这一个：段中间的 \r 仍按多行粘贴的内容处理
 * （见 test-suite「粘贴多行」用例）。
 */
export function splitTrailingNewline(unit: string): { body: string; newline: string } {
  if (unit.length > 1 && (unit.endsWith('\r') || unit.endsWith('\n'))) {
    return { body: unit.slice(0, -1), newline: unit.slice(-1) };
  }
  return { body: unit, newline: '' };
}

export function createInputBuffer(ss: ScreenStateLike, driver: InputDriver) {
  let resolveLine: ((value: string) => void) | null = null;
  const model = createModel();
  let closed = false;

  // 进入 raw mode（保 IME composition 状态机）
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  // 启用 bracketed paste：让终端用 \x1b[200~ 和 \x1b[201~ 包裹粘贴内容，
  // 从而可靠区分"粘贴内容里的换行"和"用户按的回车提交"。
  ss.emit('\x1b[?2004h');

  /** 重绘整块（编辑操作：方向键/退格/中间插入）—— 两个模式都用 rewriteInput。 */
  const redraw = () => {
    const { line, col } = ss.cursorPos(model.chars, model.cursor);
    ss.rewriteInput(ss.foldInput(model.chars), ss.contentLines(model.chars), line, col);
  };

  // 处理一个完整单元（转义序列或普通文本段）。
  const handleUnit = (unit: string): void => {
    // 模式特有：滚动键/鼠标等消费 unit（备用屏自实现 scrollback）
    if (driver.consumeChunk?.(unit)) return;

    const oldCursor = model.cursor;
    const effect = applyChunk(model, unit);

    if (effect.exit) {
      driver.cleanup?.();
      ss.emit('\nBye.\n');
      process.exit(0);
      return;
    }

    if (effect.submit != null) {
      const rawText = model.chars.join('');  // 捕获原始输入（清空前），供提交行进历史
      model.chars = [];
      model.cursor = 0;
      if (resolveLine) {
        const resolve = resolveLine;
        resolveLine = null;
        resolve(effect.submit);
      }
      if (effect.newline) ss.submitInput(rawText);
      return;
    }

    if (effect.edit === 'append') {
      driver.append(model.chars, oldCursor);
    } else if (effect.edit === 'redraw') {
      redraw();
    }
  };

  let pending = '';
  process.stdin.on('data', (chunk: string) => {
    if (closed) return;
    pending += chunk;
    while (pending.length > 0) {
      const unit = extractUnit(pending);
      if (unit === null) break;   // 残缺转义序列，等后续 chunk 拼齐
      pending = pending.slice(unit.length);
      // 文字段结尾的回车要单独喂：否则回车会被当成内容换行，提交被吞掉。
      const { body, newline } = splitTrailingNewline(unit);
      if (body) handleUnit(body);
      if (closed) return;
      if (newline) handleUnit(newline);
      if (closed) return;
    }
  });

  return {
    setBusy(busy: boolean): void {
      if (busy) {
        process.stdin.pause();
      } else {
        process.stdin.resume();
      }
    },

    readLine(): Promise<string> {
      return new Promise(resolve => {
        resolveLine = resolve;
        model.chars = [];
        model.cursor = 0;
        ss.printPrompt();
      });
    },

    close(): void {
      closed = true;
      // 模式特有清理（备用屏恢复主屏）+ 关闭 bracketed paste + 恢复 raw mode
      driver.cleanup?.();
      ss.emit('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      ss.emit('Bye.\n');
      process.exit(0);
    },
  };
}
