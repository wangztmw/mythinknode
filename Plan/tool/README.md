# Tool 层待做功能

> **创建时间**：2026-08-03
> **隶属**：my-coder 项目 Plan
> **状态**：规划中

---

## 子内容索引

| 子页面 | 类型 | 内容 |
|--------|------|------|
| [**终端稳定性**](../terminal/) | 🔴 紧急 | 独立专题：根本矛盾分析 + 崩溃逐帧还原 + 四层输出控制 |
| **权限** | 规划 | 工具级权限控制、目录白名单/黑名单、操作确认机制 |
| **沙箱** | 规划 | 进程隔离、文件系统隔离、网络隔离、资源限制 |
| **网络稳定连接** | 规划 | 重试机制、超时控制、降级策略、连接池 |

---

## 一、安全

### 现状
- Phase 46 已实现四层自保防御（BashTool.ts）
- DANGEROUS_PATTERNS：11 个危险命令正则拦截
- PROCESS_MANAGEMENT_BLOCKED：5 个广播杀进程拦截

### 待做
- [ ] 命令注入深度防护（base64 编码绕过、换行注入、管道注入）
- [ ] 所有工具（不只 BashTool）的输入校验层
- [ ] API key 环境变量隔离——不被子进程读取
- [ ] 审计日志：记录每次危险操作的时间、命令、结果
- [ ] 敏感文件保护（~/.ssh、~/.aws、.env 等）

### 关联
- Phase 46：Agent 进程自保机制（已实施）
- `Plan/Backup/` 中有 Claude Code 原始安全层代码可参考

---

## 二、权限

### 现状
- 单人使用，无权限系统——所有工具对所有请求开放
- 无目录级访问控制

### 待做
- [ ] 工具级权限：可配置哪些工具启用/禁用
- [ ] 目录白名单：限定 Bash/Read/Write/Edit 只能操作指定目录
- [ ] 目录黑名单：禁止触碰系统目录（/etc、/usr、~/.ssh 等）
- [ ] 操作确认机制：高危操作（rm -rf、git push --force 等）需二次确认
- [ ] 网络权限：可配置是否允许 WebSearch/WebFetch 外网访问
- [ ] 权限配置文件（~/.mycoder/permissions.json）的设计

### 设计参考
- Claude Code 有 4 层权限继承（managed/user/project/local）+ 14 步权限检查
- my-coder 不需要那么重，但核心三层（工具级 + 目录级 + 操作级）应该要有

---

## 三、沙箱

### 现状
- 无沙箱——所有命令在宿主进程环境中直接执行
- BashTool 用 `execSync` / `spawn`，与 my-coder 进程共享文件系统和网络

### 待做
- [ ] 方案评估：Docker 容器 vs Bubblewrap vs 进程级隔离
- [ ] 进程隔离：子进程无法访问父进程内存/环境变量
- [ ] 文件系统隔离：限定可读写目录，其他目录只读或不可见
- [ ] 网络隔离：可配置是否允许外网、内网、本地回环
- [ ] 资源限制：CPU 时间、内存上限、磁盘写入上限
- [ ] 超时自动 kill：超过 N 秒的 Bash 命令自动终止
- [ ] 子进程清理：BashTool 退出时清理所有 detached 子进程

### 设计参考
- Claude Code 用 Bubblewrap/Seatbelt 沙箱 + Haiku 分类器
- 个人使用场景下，轻量级进程隔离（如 Node `child_process` 的 `uid`/`gid` 降权）可能够用
- 参考 `Plan/sandbox-plan.md`、`Plan/detach-exec-security-layer.md`

---

## 四、网络稳定连接

### 现状
- WebSearchTool：DuckDuckGo Lite 搜索
- WebFetchTool：原生 fetch + HTML 提取
- MCPTool：22 行 stub，未接真实 MCP
- LLM 调用无重试机制

### 待做
- [ ] 统一重试机制：指数退避 + jitter，适用于所有网络调用
- [ ] 超时控制：每类请求可配置超时（WebSearch 15s、WebFetch 30s、LLM 60s）
- [ ] 降级策略：主搜索源不可用时自动切换备选源
- [ ] 连接池：复用 HTTP 连接，减少握手开销
- [ ] MCP 真实连接：从 Backup 取 client.ts 参考，支持 stdio/SSE/WebSocket 三种传输
- [ ] 网络状态检测：启动时检测外网可达性，提前告知用户
- [ ] 请求队列：并发请求数上限，避免打爆本地网络

### 关联
- Phase 18：WebSearch 从 Anthropic Search API → DuckDuckGo Lite
- `Plan/Backup/services/mcp/client.ts`（3,348 行原始 MCP 客户端）可参考

---

## 变动追踪

> 本节点隶属于 `Plan/`，向上传导到 Plan 总览。

## 更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：安全、权限、沙箱、网络稳定连接 四个子规划 |
