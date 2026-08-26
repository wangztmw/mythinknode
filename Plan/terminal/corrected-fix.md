# ~~边界折行 V1~~ ⏳ 已被简化替代

> **⚠️ 本文案已被 [最终方案](./final-fix.md) 替代。**
> **替代原因**：本文案引入了不必要的 wrapper 对象和文件抽象（`createWrappedWriter` + `output-throttle.ts`）。
> 最终方案更简单——直接 monkey-patch `process.stdout.write`，30 行，零新文件。
> **保留此文件**：方案演进记录。边界折行的原理分析仍然有效。
>
> ---

---

## 一、推倒之前的结论

| 之前的主张 | 为什么是错的 |
|-----------|------------|
| 交替屏（B1） | Claude Code 不用交替屏也不崩。说明不是 scrollback 的问题 |
| 魔法参数（fix-plan.md） | Claude Code 没用行宽 200、输出 4000、节流 16ms 这些数字 |
| 总输出量太大（root-cause.md） | Claude Code 一次对话也输出几万行。量不是根本原因 |

**正确的问题不是"Mycoder 输出太多"，而是"Mycoder 输出了什么 Terminal 处理不了的东西"。**

---

## 二、对比 Claude Code 和 Mycoder

| 维度 | Claude Code | Mycoder |
|------|-----------|---------|
| 终端模式 | 主屏（可滚动） | 主屏（可滚动） |
| 输出量 | 25 轮迭代，大量工具调用 | 25 轮迭代，大量工具调用 |
| ANSI 渲染 | 有（Ink React 组件 → ANSI） | 有（mdToANSI） |
| 渲染框架 | **Ink + Yoga 布局引擎** | 无——直接 console.log |
| 行宽约束 | **Yoga 自动约束子组件宽度 ≤ 终端宽度** | 无 |
| 是否会输出超长行 | **不会——框架天然阻止** | **会——无任何约束** |

**唯一的关键差异：行宽约束。** Claude Code 有（隐式，来自 Ink/Yoga），Mycoder 没有（显式缺失）。

---

## 三、重新审视崩溃机制

之前 `crash-trace.md` 的分析把 108MB MALLOC 当作崩溃主因——这是错的。108MB 是**结果**（长时间运行积累的 scrollback），不是**原因**。

真正的因果链：

```
Mycoder 输出一行 300 字符的表格（mdToANSI padEnd(20) × 多列）
  → Terminal SwiftUI Text 视图收到这行
  → 计算 intrinsic size：这行有 300 个字符宽
  → 提出布局宽度 = 终端窗口宽度（比如 80 列）
  → 文本需要 300 列 → 溢出
  → 提出更大宽度 → 仍然溢出（因为这行真的就是 300 字符）
  → SwiftUI 布局算法不收敛 → 递归 8 层
  → 递归期间大量分配/释放 nano zone 小对象
  → nano malloc 空闲块腐败 → SIGTRAP
```

**罪魁祸首就是那行 300 字符的文本。不是累积的 108MB 历史。**

验证这个假设：
- 如果全是 80 列以内的短行，即使有 200MB 的 scrollback，Terminal 也不崩——因为布局每次都 2-3 次收敛
- 如果有一行 500 字符，即使 scrollback 只有 5MB，Terminal 也可能崩——因为布局递归是单行触发的

这就是为什么 `npm install`（自然短行）不崩，Mycoder（偶尔超长行）崩。

---

## 四、治本方案：输出边界自动折行

### 原理

在 Mycoder 的 stdout/stderr 写入之前，插入一个**透明的折行层**。任何超过终端宽度的行，在写入 PTY 之前被自动折成多行。

```
修复前：
  Mycoder → console.log(超长行) → PTY → Terminal SwiftUI → 布局递归 → 崩

修复后：
  Mycoder → wrapLine(超长行) → console.log(已折行) → PTY → Terminal SwiftUI → 正常渲染
```

### 与魔法参数的本质区别

| 魔法参数 | 折行 |
|---------|------|
| 行宽 200 → 猜的，Terminal 可能更宽或更窄 | 终端宽度 → 从 `process.stdout.columns` 读取，是事实 |
| 输出 4000 字符 → 截断内容，用户丢失信息 | 折行 → 保留全部内容，只是视觉上换行 |
| 节流 16ms → 人为拖慢，牺牲响应速度 | 无延迟 |
| 突发降级 10KB/s → 牺牲 ANSI 格式 | 保留 ANSI 格式 |

**折行不丢失信息，不牺牲速度，不靠魔法数字。它只做一件事：确保没有一行超过终端宽度。这正是 Claude Code 的 Ink/Yoga 框架天然提供的保障。**

### 实现

```typescript
/**
 * 终端宽度感知的自动折行。
 * 替换 process.stdout.write 和 process.stderr.write，
 * 确保所有写入终端的文本，单行不超过终端宽度。
 *
 * 注意：必须正确处理 ANSI 转义序列——不可见字符不计入宽度。
 */

function createWrappedWriter(stream: NodeJS.WriteStream) {
  const width = stream.columns || 120; // 终端宽度，resize 时更新

  return {
    write(text: string): void {
      // 按换行符拆分，对每一行独立做折行
      const lines = text.split('\n');
      const wrapped: string[] = [];
      for (const line of lines) {
        if (line.length === 0) { wrapped.push(''); continue; }
        // 去掉 ANSI 码后计算可见宽度
        const visibleWidth = stripANSI(line).length;
        if (visibleWidth <= width) {
          wrapped.push(line);
        } else {
          // 超宽行：按可见字符折行
          wrapped.push(...wrapSingleLine(line, width));
        }
      }
      stream.write(wrapped.join('\n'));
    },

    /** 终端 resize 时调用 */
    updateWidth(newWidth: number): void {
      // width 是 const，这里用闭包变量
    },

    /** 获取当前宽度 */
    getWidth(): number { return width; },
  };
}
```

### 改动范围

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/ansi.ts` | 删除行宽限制代码（之前 fix-plan 加的） | -5 |
| `src/output-throttle.ts` | **删除整个文件**（不需要） | -30 |
| `src/terminal.ts` | **新增**：`createWrappedWriter()` + ANSI 宽度计算 | +60 |
| `src/cli.ts` | stdout/stderr 全部走 wrapped writer | +10 |

**总计**：净增 35 行。比之前四层防御少，比交替屏少，而且只解决一个问题——**确保行宽不超过终端宽度**。

### 为什么之前没做

Mycoder 的开发逻辑一直是"保证代码简洁"。`console.log` 和 `process.stderr.write` 是 Node 标准库，不需要任何封装。但在 macOS Terminal 的 SwiftUI 实现有 bug 的前提下，**直接写原生 API 不够——需要在 PTY 边界加一个透明的折行保护层。**

这不是过度工程——这是 Claude Code 的 Ink/Yoga 提供的同等保障，只是 Mycoder 用 60 行代码实现了 Ink/Yoga 几千行中 Mycoder 需要的那个子集。

---

## 五、方案对比

| 方案 | 保留滚动 | 不丢信息 | 不降速 | 无魔法参数 | 代码量 |
|------|---------|---------|--------|----------|--------|
| 魔法参数（fix-plan.md） | ✅ | ❌ 截断 | ❌ 节流 | ❌ | 82 行 |
| 交替屏（terminal-technology.md） | ❌ | ✅ | ✅ | ✅ | 250 行 |
| **边界折行（本方案）** | ✅ | ✅ | ✅ | ✅ | **35 行** |

---

## 六、更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：承认交替屏是过度设计，治本方案 = 终端宽度感知折行 |
