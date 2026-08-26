# 沙箱机制 — 核心原理与实现计划

> **创建时间**：2026-08-01
> **核心关键词**：沙箱、Bubblewrap、Seatbelt、sandbox-exec、隔离
> **参考源码**：`utils/sandbox/sandbox-adapter.ts`（997行）+ `@anthropic-ai/sandbox-runtime`

---

## 一、Claude Code 的沙箱是怎么做的

### 核心原理：不是 Docker，是"一次性包装纸"

Claude Code 的沙箱在每个 Bash 命令外面包一层隔离——命令执行完，沙箱就销毁。不是先创建容器再把命令放进去跑，而是直接用系统内核的隔离机制把命令"裹"起来。

```
# 没有沙箱:
bash -c "ls -la /etc/passwd"           → 随便读

# Linux + bwrap:
bwrap \
  --ro-bind / / \                       # 整个根目录只读挂载
  --bind /home/user/project /home/user/project \  # 项目目录可写
  --proc /proc \                        # 独立的进程空间
  --dev /dev \                          # 最小设备访问
  --unshare-all \                       # 隔离所有命名空间
  bash -c "ls -la /etc/passwd"          → 能读（只读挂载允许）
  
# macOS + Seatbelt:
sandbox-exec -f /tmp/my-coder.sb \
  bash -c "ls -la /etc/passwd"          → 能读还是不能，取决于 .sb 文件
```

底层用的是 Linux 内核的 namespace（命名空间）和 macOS 的 Sandbox.kext（强制访问控制），不是虚拟机，不是容器。启动时间 < 10ms——对比 Docker 的 500ms+。这就是为什么能做到"每条命令包一次"——如果是 Docker，等它启动完命令已经跑完了。

### 两个平台，同一个接口

| | Linux (Bubblewrap) | macOS (Seatbelt) |
|---|---|---|
| 实现 | `bwrap` 命令（bubblewrap 包） | `sandbox-exec -f profile.sb`（系统自带） |
| 原理 | 用户命名空间 + 挂载命名空间 + PID 隔离 | 内核级强制访问控制（MAC） |
| 安装 | `apt install bubblewrap` | 不需要安装（macOS 内置） |
| 文件控制 | tmpfs 空白根 + ro-bind 按需注入目录 | .sb 配置文件：(allow file-read* ...) |
| 网络控制 | 命名空间仅回环设备 | .sb 配置：(deny network*) |
| 进程隔离 | PID 命名空间, 看不到宿主机进程 | 沙箱内的进程有独立标签 |

---

## 二、核心机制拆解

### 2.1 文件系统隔离 — "白名单"模式

错误的方式："黑名单"——列出/home/user/.ssh 不可读。

正确的方式："白名单"——整个根目录不可读，明确列出几个允许的目录。

```
bwrap 启动时:
  1. 创建空白 tmpfs 为根目录           → 什么都看不到
  2. --ro-bind /usr /usr              → /usr/bin, /usr/lib 可读不可写
  3. --ro-bind /lib /lib              → 运行时库可读
  4. --bind /home/user/project /home/user/project  → 项目目录可读写
  5. --ro-bind /etc /etc              → 配置文件只读
  6. --proc /proc                     → 独立的 /proc
  7. --dev /dev                       → 最小 /dev
  8. --tmpfs /tmp                     → 临时文件在沙箱内不可见
  
  结果: 程序能看到 /usr, /lib, /etc, /home/user/project
        看不到 /home/user/.ssh, /root, /var/log, /opt
        /home/user/project 以外的任何写操作都失败
```

Claude Code 的 `convertToSandboxRuntimeConfig()` 从权限规则中提取允许的路径：Write 工具允许的目标目录 → allowWrite，deny 规则里禁掉的路径 → denyWrite。动态生成的。

### 2.2 网络隔离 — "默认全断"

```
# Linux bwrap 的网络隔离:
--unshare-net                          → 独立的网络命名空间
  → 只有 loopback (127.0.0.1)
  → 没有 eth0, 没有 wlan0
  → curl google.com → 直接失败

# 需要网络时:
--share-net                            → 共享主机的网络命名空间
  → 但配合 seccomp 过滤 connect() 系统调用
  → 只允许 WebFetch 的预批准域名
```

Claude Code 从权限规则里提取 `WebFetch(domain:*)` 的域名白名单——你允许访问的域名，沙箱才放行 DNS 解析和 TCP connect。

### 2.3 进程隔离

```
# Linux PID 命名空间:
--unshare-pid
  → 沙箱内的进程看不到宿主机的进程列表
  → ps aux 只显示沙箱内启动的几个进程
  → kill -9 <父进程> 无效 — 找不到那个 PID

# Seccomp 过滤器 (可选):
  限制可执行的系统调用
  → fork() — 允许
  → execve() — 允许
  → ptrace() — 禁止
  → mount() — 禁止
  → 防止沙箱内再创建沙箱
```

### 2.4 生命周期 — 即用即毁

```
每条 Bash 命令 = 一次沙箱创建与销毁

用户输入 "ls":
  SandboxManager.wrapWithSandbox("ls")
    → 生成 bwrap/sandbox-exec 命令
    → child_process.spawn(bwrapped_command)
    → 等待子进程退出
    → 沙箱随进程退出自动销毁
    → cleanup (删除临时 sb 文件等)

总耗时: bwrap 包装 ~8ms + 实际命令时间
```

不是长生命周期的容器。每次都是全新的隔离环境——没有状态残留、不需要清理上一个命令的临时文件。

---

## 三、配置文件是怎么生成的

### macOS Seatbelt (.sb 文件)

`.sb` 文件是 Scheme 风格的 DSL：

```lisp
(version 1)
(deny default)                          ; 默认全禁

; 文件读写 — 白名单
(allow file-read* (subpath "/usr"))     ; 系统库可读
(allow file-read* (subpath "/lib"))
(allow file-read* (subpath "/etc"))
(allow file-read* 
  (subpath "/home/user/project"))       ; 项目目录可读写
(allow file-write*
  (subpath "/home/user/project"))

; 网络 — 全禁
(deny network*)

; 进程 — 最小权限
(allow process-exec)                    ; 允许执行
(allow process-fork)                    ; 允许fork
(deny signal (target self))             ; 不能发信号给其他进程
```

生成方式：`convertToSandboxRuntimeConfig()` 从设置文件中读取 allowedDomains、deniedPaths、allowedPaths → 翻译成 `.sb` 文件的 DSL → 写入临时文件 → `sandbox-exec -f /tmp/xxx.sb command`。

### Linux Bubblewrap (命令行参数)

```
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /etc /etc \
  --bind /home/user/project /home/user/project \
  --tmpfs /tmp \
  --proc /proc \
  --dev /dev \
  --unshare-all \
  --unshare-net \
  bash -c "your command here"
```

更简单——没有 DSL 文件，直接在命令行参数里拼。生成方式相同：从配置提取限制规则 → 翻译成 bwrap 参数。

---

## 四、我们怎么实现

因为实际的沙箱逻辑在 `@anthropic-ai/sandbox-runtime` 闭源包里，我们看不到。但可以从 `sandbox-adapter.ts`（997 行）逆推出需要做的事：

### Phase 1：命令行包装（最简单）

不引入新依赖，直接在 BashTool 里包命令行：

```typescript
// BashTool.call() 里:
function wrapWithSandbox(command: string): string {
  if (process.platform === 'linux') {
    return `bwrap --ro-bind / / --bind ${cwd} ${cwd} --proc /proc --dev /dev --unshare-all bash -c "${command}"`;
  }
  if (process.platform === 'darwin') {
    const profile = generateSeatbeltProfile(cwd);
    return `sandbox-exec -f ${profile} bash -c "${command}"`;
  }
  return command; // 不支持的平台, 不包沙箱
}
```

### Phase 2：配置文件生成

根据 `.mycoder/sandbox.json` 生成 Seatbelt 配置文件或 Bubblewrap 参数：

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "allowRead": ["/usr", "/lib", "/etc"],
      "allowWrite": [".", "~/.mycoder/tmp"],
      "denyWrite": ["~/.ssh", "~/.aws", "~/.claude/settings.json"]
    },
    "network": {
      "allowedDomains": ["api.anthropic.com", "api.deepseek.com"]
    }
  }
}
```

### Phase 3：集成到 BashTool

在 `BashTool.call()` 的 execSync 前加沙箱包装。配合权限规则——deny 规则里禁掉的路径同时生成沙箱限制。

---

## 五、实施估计

| Phase | 内容 | 代码量 | 难度 |
|---|---|---|---|
| 1 | 命令行包装 (bwrap + sandbox-exec) | ~80 行 | 低 |
| 2 | 配置文件生成 | ~150 行 | 中 |
| 3 | BashTool 集成 + 权限联动 | ~100 行 | 中 |
| **总计** | | **~330 行** | |

关键是步骤 1-2 不依赖任何外部 npm 包。bwrap 是 Linux 包管理器安装的独立二进制，sandbox-exec 是 macOS 系统自带。我们的沙箱只做命令包装——不需要维护状态、不需要跨平台抽象层。

---

## 六、Claude Code vs 我们的简化方案

| | Claude Code | 我们的 Phase 1 |
|---|---|---|
| 平台检测 | 自动切换 bwrap/seatbelt | 同 |
| 配置文件 | 从 4 层 settings 继承提取 | JSON 一个文件 |
| 网络控制 | 域名黑白名单 | 配置开关（开/关） |
| 文件控制 | 按路径 + glob 精细化 | 按目录白名单 |
| 询问回调 | sandbox 违规时弹 React UI | console 日志 + 自动 deny |
| 代码量 | 997 行 + 闭源运行时 | ~330 行 |
| 依赖 | @anthropic-ai/sandbox-runtime | 仅系统自带的 bwrap/sandbox-exec |
