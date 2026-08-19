# think-coder 核心保留清单

> 重构完成后，最终保留的核心模块。

---

## 最终目录结构（目标）

```
think-coder/
├── src/
│   ├── main.ts              # 最小入口
│   ├── Tool.ts              # 工具接口定义
│   ├── tools.ts             # 工具注册表
│   ├── QueryEngine.ts       # 核心 Agent 循环
│   ├── Task.ts              # 任务管理
│   ├── context.ts           # 上下文管理
│   ├── commands.ts          # 命令注册
│   ├── tools/
│   │   ├── BashTool/        # Shell 执行
│   │   ├── FileReadTool/    # 文件读取
│   │   ├── FileWriteTool/   # 文件写入
│   │   ├── FileEditTool/    # 文件编辑
│   │   ├── GlobTool/        # 文件搜索
│   │   ├── GrepTool/        # 内容搜索
│   │   ├── MCPTool/         # MCP 代理
│   │   ├── SkillTool/       # Skill 调用
│   │   ├── WebFetchTool/    # 网页抓取
│   │   ├── WebSearchTool/   # 网页搜索
│   │   ├── TaskCreateTool/  # 任务创建
│   │   ├── TaskListTool/    # 任务列表
│   │   ├── TaskUpdateTool/  # 任务更新
│   │   └── shared/          # 共享工具函数
│   ├── services/
│   │   ├── mcp/             # MCP 核心（stdio transport）
│   │   ├── tools/           # 工具执行管道
│   │   └── compact/         # 上下文压缩
│   ├── skills/              # Skill 加载
│   ├── cli/                 # 最简 CLI
│   └── utils/               # 工具函数
├── package.json
└── tsconfig.json
```

---

## 保留的核心模块（按目录）

### src/ 根目录

| 文件 | 作用 | 保留原因 |
|------|------|---------|
| `Tool.ts` | 工具泛型接口 + buildTool 工厂 | 整个工具系统的基石 |
| `tools.ts` | 工具注册、过滤、合并 | Agent 启动时组装工具池 |
| `QueryEngine.ts` | 核心 Agent 循环 | while(true) { model→tool→model } |
| `Task.ts` | 任务数据结构 | 任务状态管理 |
| `context.ts` | 上下文管理器 | 对话历史、token 管理 |
| `commands.ts` | 命令注册（含 Skill 命令） | 斜杠命令和 Skill 发现 |

### src/tools/ — 核心工具

| 工具 | 保留原因 |
|------|---------|
| BashTool | 最核心——执行一切 |
| FileReadTool / FileWriteTool / FileEditTool | 文件操作三件套 |
| GlobTool / GrepTool | 代码搜索 |
| MCPTool | 连接外部 MCP 服务 |
| SkillTool | 加载和调用 Skill |
| WebFetchTool / WebSearchTool | 获取外部信息 |
| Task*Tool | 任务追踪 |

### src/services/

| 服务 | 保留原因 |
|------|---------|
| mcp/ | MCP 客户端、连接管理、stdio transport |
| tools/ | 工具执行管道（9阶段） |
| compact/ | 上下文压缩防止 token 爆炸 |

### src/skills/

| 文件 | 保留原因 |
|------|---------|
| loadSkillsDir.ts | 从目录加载 Skill |
| （删除 bundledSkills.ts） | 不保留内置 skills |
