# tools-v2: 按原架构重写工具库

> **状态**：进行中 | **时间**：2026-08-01

## 目标

将 Claude Code 工具库按原始架构用干净代码重写，零断裂依赖。

## 架构规范

每个工具遵循 Claude Code 原始模式：

```
tools-v2/
├── Tool.ts              ← 精简版 Tool 接口
├── index.ts             ← getAllTools()
├── GlobTool/
│   ├── GlobTool.ts      ← buildTool() + call()
│   └── prompt.ts        ← 系统提示词
├── GrepTool/
├── WebSearchTool/
├── FileWriteTool/
├── FileEditTool/
├── FileReadTool/
├── WebFetchTool/
├── MCPTool/
├── SkillTool/
└── BashTool/
```

### 每个工具的文件结构

```
ToolName/
├── ToolName.ts    ← buildTool({ name, inputSchema, call, isReadOnly, ... })
└── prompt.ts      ← export const DESCRIPTION
```

### Tool 接口（精简版）

```typescript
type Tool = {
  name: string
  description(): Promise<string>
  inputSchema: ZodObject
  call(args, context): Promise<ToolResult>
  isReadOnly(args): boolean
  isEnabled(): boolean
  checkPermissions(args, context): Promise<PermissionResult>
  prompt(opts): Promise<string>
  userFacingName(args): string
}
```

## 构建顺序（简→难）

1. GlobTool — 最简单
2. GrepTool
3. WebSearchTool
4. FileWriteTool
5. FileEditTool
6. FileReadTool
7. WebFetchTool
8. MCPTool
9. SkillTool
10. BashTool

## 与原桥接层的关系

- 当前 `tools-bridge.ts` 保持不变，继续运行
- `tools-v2/` 完成后，`main.ts` 切换到 `import { getAllTools } from './tools-v2/index.js'`
- 切换后删除 `tools-bridge.ts`
