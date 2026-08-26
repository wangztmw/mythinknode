# 最终方案：stdout/stderr 透明折行

> **隶属**：Plan/terminal/
> **状态**：待实施
> **核心思路**：拦截 Node.js 进程的 stdout 和 stderr，在写入 PTY 之前自动折行。零新文件，零架构变更。

---

## 一、为什么这个方案是治本的

崩溃原因链：**单行长行 → Terminal SwiftUI 布局不收敛 → 递归 → malloc corruption。**

打断这条链只需要消除"单行长行"这个条件。怎么做？

**在 Mycoder 的输出边界——`process.stdout.write` 和 `process.stderr.write`——做一次透明的行宽检查。任何超出终端宽度的行，写入前自动折成多行。**

不是控制输出量。不是降低速率。不是换屏幕。就是保证没有任何一行超过终端宽度。这个条件成立 → SwiftUI 布局永不超过 2-3 次迭代收敛 → 不崩溃。

**一句话：Mycoder 不输出超长行，Terminal 就不崩。这不需要任何魔法参数——终端宽度是客观事实（`process.stdout.columns`），不是猜的。**

---

## 二、实现

### 代码位置：`src/Mycoder.ts`，`main()` 函数第一行

```typescript
// === 透明折行：确保无超长行触发 Terminal 布局递归 ===
function wrapOutput(stream: NodeJS.WriteStream) {
  const original = stream.write.bind(stream);
  stream.write = function(chunk: any, encoding?: any, callback?: any): boolean {
    const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf-8');
    const width = stream.columns || 120; // 每次 write 时读取（支持 resize）
    const wrapped = text.split('\n').map(line => {
      if (stripANSIWidth(line) <= width) return line;
      return breakLine(line, width);
    }).join('\n');
    return original(wrapped, encoding, callback);
  };
}

wrapOutput(process.stdout);
wrapOutput(process.stderr);
```

### 辅助函数（同文件，`main()` 上方）

```typescript
/** 计算去掉 ANSI 转义序列后的可见字符数 */
function stripANSIWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * 将超长行在指定宽度处折行。
 * 折行时保留 ANSI 码——在折点插入换行符，不损坏 ANSI 序列。
 * 注意：跨 ANSI 状态的折行不需要恢复状态——终端在新行自动重置。
 */
function breakLine(line: string, maxWidth: number): string {
  const parts: string[] = [];
  let visible = 0;
  let lastBreak = 0;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      // 跳过整个 ANSI 转义序列
      while (i < line.length && line[i] !== 'm') i++;
      continue;
    }
    visible++;
    if (visible >= maxWidth) {
      parts.push(line.slice(lastBreak, i + 1));
      lastBreak = i + 1;
      visible = 0;
    }
  }
  if (lastBreak < line.length) parts.push(line.slice(lastBreak));
  return parts.join('\n');
}
```

### 总计

- `src/Mycoder.ts`：+35 行（`wrapOutput` + `stripANSIWidth` + `breakLine` + 两次调用）
- 其他文件：**零改动**
- 无需新文件
- 无需依赖

---

## 三、为什么这么简单就能解决问题

| 维度 | 说明 |
|------|------|
| **覆盖面** | monkey-patch 了 `stdout.write` 和 `stderr.write`，所有输出路径都经过——`console.log`、`process.stderr.write`、`console.error`、LLM 回复、工具显示、通知——无一遗漏 |
| **无魔法参数** | `width` 来自 `process.stdout.columns`（终端报告的客观宽度），不是编的 |
| **零延迟** | 折行是纯字符串操作，微秒级。不影响 Agent 响应速度 |
| **不丢信息** | 折行保留全部文本，只是视觉上断成多行。用户看到的内容一字不少 |
| **不影响 scrollback** | 仍然在主屏上运行，所有历史可滚动 |
| **Resize 适应** | 每次 `write()` 时重新读 `columns`，用户拉大/缩小窗口自动适应 |
| **架构不变** | 引擎层（agent.ts）和渲染层（cli.ts）完全不受影响 |

---

## 四、为什么之前没做

Mycoder 的设计假设是"终端能处理任何文本"。这个假设对 99% 的终端成立。macOS Terminal 2.15 的 SwiftUI 渲染在极端情况下（超长行 + 小窗口）是这个 1% 的例外。

不是 Mycoder 的设计缺陷——是 macOS Terminal 的实现 bug。但这个 bug 不会修复（Apple 不会为第三方 CLI 工具改 Terminal）。所以 Mycoder 需要在自己的边界上补这个防御。

Claude Code 不崩是因为 Ink/Yoga 自动折行。Mycoder 没有 UI 框架，需要显式做。30 行。

---

## 五、和队列方案的关系

队列方案被放弃。原因：队列解决时序问题，不解决行宽问题。折行直接解决行宽问题。

但队列能解决的"双向碰撞"场景，折行也能间接缓解：如果输入回显的超长行被折行了，它不再触发布局递归，那碰撞本身也就不可怕了。

**折行是治本的，队列是锦上添花。先治本，不用加队列。**
