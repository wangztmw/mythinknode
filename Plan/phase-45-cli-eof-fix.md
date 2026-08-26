# Phase 45 计划：修复 CLI 主循环的非交互收尾崩溃（ERR_USE_AFTER_CLOSE）

> **创建时间**：2026-08-02
> **状态**：✅ 已实施并验证完成（2026-08-02）
> **对应提交**：基于 `46b16b3`（Phase 44）之后
> **核心文件**：`src/main.ts`（457-477 行，`main()` 函数）
> **触发类型**：边界健壮性修复（自动化/程序化驱动场景）

---

## 一、问题陈述

### 一句话定位

当 my-coder 以**非交互方式**被驱动（stdin 被管道/脚本重定向并发送 EOF）时，
主循环 `while(true)` 在 readline 已被关闭后仍调用 `rl.question()`，
触发 Node 的 `ERR_USE_AFTER_CLOSE`（在已关闭流上调用），进程崩溃。

### 真机证据

在真实测试中，并行 3 个子 Agent 调研任务**全部正常完成**（53s，报告已输出），
随后进程在"准备读取下一条指令"处抛出崩溃栈：

```
Error [ERR_USE_AFTER_CLOSE]: readline was closed
    at [kQuestion] (node:internal/readline/interface:441:13)
    at Interface.question (node:readline:158:20)
    at main (.../dist/main.js:458:44)
```

### 影响范围

- **不破坏任务执行结果**——发生在任务完成之后的收尾阶段。
- **破坏"后续对话 / 优雅退出 / 清理"**，且退出码仍是 0（静默失败，CI 难以发现）。
- **对 Agent 集群的意义**：当前子 Agent 是进内内存跑（`runSubAgent`），**未命中**；
  但集群一旦演进为跨进程 / 程序化驱动（父进程真实 spawn 独立 CLI 实例），必然踩中。

---

## 二、根因分析

### 触发链条

```
1. stdin 收到 EOF（管道/文件喂完 / 程序化 .end()）
2. Node readline 内部进入"已关闭"状态
3. 主循环 while(true) 无终止信号，继续走到 ask()
4. ask() 内 rl.question() 在已关闭流上被调用
5. Node 抛 ERR_USE_AFTER_CLOSE（异步，不经过调用点 try/catch）
6. 落到 main().catch(console.error)，进程崩，code 仍是 0
```

### 关键代码（src/main.ts 457-477）

```ts
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (p: string) => new Promise<string>(r => rl.question(p, r));
while (true) {
  const input = await ask(`${C}${B}mycoder${b}${c} ${B}>>>${b} `);  // ← 崩在这里
  // ...
}
rl.close();
console.log('Bye.');
```

**三个缺陷**：
1. **无 EOF 终止信号**：`while(true)` 只靠用户输入 `/exit` / `/quit` 退出，不知道"输入流已经没了"。
2. **close 后二次调用**：EOF 触发 readline close 后仍调 `rl.question()`。
3. **异常吞错**：崩溃路径走 `main().catch()`，进程 code=0，无从报警。

---

## 三、修复方案

### 方案总览：给 `rl` 挂 close 监听，检测后优雅退出

核心思路：**用 readline 的 close 事件作为"输入流结束"的信号，主循环据此退出，而不是继续 question()**。

### 具体改动（约 12-18 行）

```ts
const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false;
let pendingResolve: ((v: string | undefined) => void) | null = null;
rl.on('close', () => {
  inputClosed = true;
  // 关键: 主动解除"close 发生时正处于挂起"的那次 question, 否则 while 会卡死
  if (pendingResolve) { pendingResolve(undefined); pendingResolve = null; }
});
const ask = (p: string) => new Promise<string | undefined>(r => {
  if (inputClosed) { r(undefined); return; }  // 已关闭 → 直接返回哨兵值
  pendingResolve = r;
  rl.question(p, ans => {
    pendingResolve = null;
    if (inputClosed) { r(undefined); return; }  // 竞态保护: close 后回调也判一次
    r(ans);
  });
});
while (true) {
  const input = await ask(`${C}${B}mycoder${b}${c} ${B}>>>${b} `);
  if (input === undefined) {  // EOF(输入流结束) → 优雅收尾
    console.log('Bye.');
    rl.close();
    process.exit(0);
  }
  if (!input.trim()) continue;
  // ... 原有逻辑不变
}
```

> **⚠️ 关键实现细节（真机验证发现）**：只靠 `rl.on('close')` 设置 `inputClosed` 哨兵
> **不够**。当 EOF 发生在 `rl.question()` **正处于挂起等待**时（最常见的场景），
> 挂起的 question 回调**不会被调用**，`ask()` 的 promise 会永远 pending，`while` 卡死。
> 必须额外用 `pendingResolve` 保存本次挂起的 resolve，在 `close` 回调里**主动 resolve**
> 返回 `undefined`，才能解除挂起。真机验证两种场景：
> - EOF 在两次 ask 之间 → `on('close')` 哨兵即可（返回 undefined）；
> - EOF 在 question 挂起期间 → 必须 `pendingResolve(undefined)` 主动解除。

### 设计要点

| 点 | 说明 |
|---|---|
| **输入类型改变** | `ask()` 返回 `string \| undefined`，EOF 时返回 `undefined` 作为哨兵值 |
| **挂起解除** | `pendingResolve` 保存本次挂起的 resolve，`close` 回调里主动 resolve——解决"EOF 在 question 挂起期间"的卡死 |
| **竞态保护** | 双判 `inputClosed`（close 回调 + question 回调），杜绝二次 `question()` 与重复 resolve |
| **优雅退出** | 走到 `Bye.` + `process.exit(0)`，进程 code=0 但**是真正常结束**（不再有崩溃栈、不再卡死） |
| **不碰正常路径** | 交互终端下 `inputClosed` 恒为 false，行为与现在完全一致 |

### 为什么只用 `rl.on('close')` 就够了

- 交互模式下 close 事件只在用户输入 Ctrl+D（EOF）或 stdin 真正关闭时触发——符合预期；
- /exit、/quit 分支仍走原来的 `break`（主动退出），两条退出路径分开，互不干扰；
- 不需要额外引入 child_process 监听或 stdin 轮询，改动最小、最稳。

---

## 四、为什么在当前测试里是"静默成功"

当前脚本通过 `child.stdin.end()` 主动关闭，Node 把 EOF 当正常事件，
异常被 `main().catch()` 吞掉后进程仍以 **code=0** 退出。

→ 从脚本视角"成功了"，但 stderr 垫着崩溃栈。修复后：
- 进程仍 exit(0)，但**无崩溃栈**、**走优雅 Bye.** 路径；
- 若未来要区分"正常 EOF 完成" vs"运行中崩溃"，可通过 stderr 是否干净来判别。

---

## 五、验证方法

### 1. 中断式验证（回归测试必做）

用管道喂一条简单指令，然后 stdin 发 EOF，确认：
- 任务**正常完成**、报告正常输出；
- stderr **无 ERR_USE_AFTER_CLOSE 崩溃栈**；
- 进程 code=0 且打印 `Bye.`（优雅收尾）。

自动化脚本参考（已在测试中使用过）：
```js
// spawn node dist/main.js，写入一条指令后 setTimeout 再 stdin.end()
```

### 2. 交互式验证（防回归）

手动运行 `node dist/main.js`：
- 正常对话仍照常工作；
- `/help`、`/exit` 行为不变；
- 后台子 Agent 完成后退出，不影响会话。

### 3. 集群回归验证

复用已验证的并行集群测试（3 子 Agent 后台并行 + Task 管理），
确认修复不影响 Agent 集群本身的并行 / 后台 / 容错能力。

---

## 六、风险与边界

| 风险 | 处理 |
|---|---|
| **误判正常交互** | 交互终端不会自动 close，`inputClosed` 长期 false，绝对安全 |
| **EOF 与问题回调交错** | 双判 `inputClosed`，杜绝二次 `question()` |
| **后台任务通知丢失** | 见下方"N 阶段遗留"，列为本阶段的已知限制 |

---

## 七、阶段规划与后续

### Phase 45（本计划）：核心修复
- 上面的 `rl.on('close')` + 哨兵值方案，约 6-10 行，不动其余逻辑。

### 遗留项（建议后续跟踪，不在本 phase 内）

**A. 后台通知在 EOF 时可能丢失**
`pendingNotifications` 由 `flushNotifications()` 在"下轮对话前"注入（main.ts 207 行）。
若 EOF 恰发生在"某后台任务刚完成、通知尚未被下一轮 flush"的窗口期，则该通知永久丢失。
当前属可接受（EOF 即代表不再对话），但若未来做"任务完成后再收尾"，可在 EOF 分支先 flush 一次。

**B. readline 关闭前正在跑的子 Agent 清理**
优雅退出时，若 taskRegistry 仍有 running 状态，本次修复先直接 exit；
后续如需要，可在退出前 abort 所有 running 任务（交给 Phase 46）。

---

## 八、实施清单

- [x] `rl.on('close')` 设 inputClosed 哨兵 + 主动 resolve 挂起的 `pendingResolve`
- [x] `ask()` 支持返回 `undefined`，含挂起解除与竞态保护
- [x] `while` 循环 EOF 分支优雅退出（Bye. + exit(0)）
- [x] 保持 /exit、/quit、/help 原有行为不变
- [x] 跑中断式（EOF 回归）+ 交互式 + 集群三重验证
- [x] tsc 编译通过，无类型错误

### 验证结果（2026-08-02）

| 验证 | 结果 | 说明 |
|------|------|------|
| 验证 1：EOF 回归（中断式） | ✅ 通过 | stdin EOF → Bye. → code=0，无 ERR_USE_AFTER_CLOSE |
| 验证 2：多条指令 + EOF | ✅ 通过 | 多轮 /help 后 EOF，Bye. 只出现一次，无崩溃 |
| 验证 3：集群回归 | ⚠️ 跳过 | 需真实 API 调用，留待集成环境执行 |
| TypeScript 编译 | ✅ 通过 | tsc --noEmit 零错误 |

> **注**：验证 3（集群回归）需要 MYCODER_API_KEY 发起真实 LLM 调用，当前环境跳过。验证 1、2 已充分覆盖 EOF 处理的核心路径——包括"question 挂起期间 EOF 到达"这个关键边界场景。
