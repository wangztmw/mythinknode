# Claude Code 工具系统完整架构

> 源码路径：`study/claude-code/claude-code-main/src/`

---

## 1. 原理模型

CC 工具系统遵循一个简单模型：

```
人工写 Zod Schema → 自动转 JSON Schema → 发给 API → 模型返回 tool_use →
Zod 校验 → 权限 + hooks → 执行 → 结果映射 → 注入消息数组
```

**JSON Schema 是自动化桥梁**：Zod 负责类型安全，JSON Schema 负责跟 API 通信，两者之间全自动转换。

---

## 2. 工具定义：buildTool() 模式

每个工具都是 `buildTool({...})` 的产物。

**核心类型**（`Tool.ts` 第 362 行）：

```typescript
Tool<Input extends AnyObject, Output, P extends ToolProgressData> {
  name: string                    // 唯一标识
  inputSchema: Input              // Zod v4 schema（lazy 初始化）
  inputJSONSchema?: ToolInputJSONSchema  // MCP 工具用，直接给 JSON Schema
  outputSchema?: z.ZodType        // 输出类型（编译期约束，非运行时校验）
  
  call(args, context, ...)        // 实际执行逻辑
  description(input, options)     // 动态描述（可随输入变化）
  prompt(options)                 // 生成 API-level 工具描述文本
  mapToolResultToToolResultBlockParam(content, toolUseID)  // 输出 → API 格式
  validateInput?(input, context)  // 预执行校验（无 I/O）
  
  isReadOnly(input): boolean      // 是否只读 → 控制并发
  isConcurrencySafe(input): boolean  // 是否并发安全
  shouldDefer?: boolean           // 懒加载（不随初始 prompt 发送）
  
  checkPermissions(input, ctx)    // 工具特定权限逻辑
  renderToolUseMessage(...)       // UI 渲染
  maxResultSizeChars: number      // 超出则磁盘持久化
}
```

**`buildTool(def)`**（`Tool.ts` 第 783 行）：接收 `ToolDef`（所有字段可选），合并默认值后返回完整的 `Tool`。

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  checkPermissions: () => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  // ...
}
```

每个工具定义示例（TaskListTool）：

```typescript
export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  inputSchema: lazySchema(() => z.strictObject({})),  // 无参数
  async *call(_args, _context) { /* ... */ },
  // ...
} satisfies ToolDef<InputSchema, Output>)
```

---

## 3. JSON Schema 自动化管线

### 3.1 Zod → JSON Schema（`zodToJsonSchema.ts`）

```typescript
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)  // WeakMap<ZodTypeAny, JsonSchema7Type>
  if (hit) return hit
  const result = toJSONSchema(schema)  // Zod v4 原生方法，非第三方库
  cache.set(schema, result)
  return result
}
```

关键设计：
- `WeakMap` 缓存：`lazySchema()` 保证相同 Zod 对象 identity 在整个会话中不变 → 缓存命中率 ~100%
- Zod v4 原生 `toJSONSchema()`：不需要第三方适配库
- `.describe()` 字符串直接成为 JSON Schema 的 `description` 字段 → 建模给模型看的

### 3.2 工具描述到 API 对象（`utils/api.ts` 第 119 行 `toolToAPISchema()`）

```
toolToAPISchema():
  ├── inputJSONSchema 存在？（MCP 工具）→ 直接使用
  ├── 否则 → zodToJsonSchema(tool.inputSchema)
  ├── tool.prompt() → description 字段（自然语言使用指南）
  └── 逐请求覆盖层：defer_loading / cache_control / strict / eager_input_streaming
```

**双层缓存策略**：

| 缓存层 | 存储 | Key | 缓存什么 |
|--------|------|-----|---------|
| `zodToJsonSchema` | WeakMap | ZodTypeAny identity | Zod → JSON Schema 转换结果 |
| `toolSchemaCache` | Map | tool.name + schema hash | API 序列化结果（name + description + input_schema） |

原因：避免 GrowthBook 功能开关在会话中途变化 → tool bytes 变化 → 服务端 prompt cache 从工具位置 2 起全部失效。

### 3.3 懒加载（`ToolSearch` / `shouldDefer`）

`shouldDefer: true` 的工具不随初始 prompt 发送完整 schema。模型先看到 `<available-deferred-tools>` 名称列表，需要时通过 `ToolSearch` 工具按需获取。MCP 工具全量懒加载。

---

## 4. 完整 10 步生命周期

```
1. SCHEMA 定义（模块加载时，lazy）
   └── Zod inputSchema + prompt.ts 描述文本

2. API 工具列表组装（每次 API 请求）
   └── toolToAPISchema() → { name, description, input_schema, ... }
   └── 发送到 API 作为 tools 数组

3. 模型响应（流式）
   └── content_block: { type: tool_use, id, name, input: {...} }

4. 输入校验
   ├── tool.inputSchema.safeParse(input)  ← Zod 校验
   │   └── 失败 → formatZodValidationError() → 错误 tool_result
   └── tool.validateInput?(parsedInput, context)
       └── 语义校验（无 I/O）

5. PreToolUse Hooks
   ├── 可 allow / deny / ask / passthrough
   ├── 可 preventContinuation、附加 additionalContext
   └── Hook allow 后仍需过 checkRuleBasedPermissions()

6. 权限检查
   ├── checkRuleBasedPermissions()：alwaysAllow/Deny/Ask 规则
   ├── tool.checkPermissions()：工具特定权限
   ├── canUseTool()：交互对话框 or 自动分类器
   └── Deny → 返回错误 + PermissionDenied hooks

7. 工具执行
   └── tool.call(parsedInput, context, canUseTool, parentMessage, onProgress)
       └── onProgress 回调 → UI 更新

8. 结果映射
   └── tool.mapToolResultToToolResultBlockParam(data, toolUseID)
       └── 类型化 Output → API ToolResultBlockParam
       └── 超出 maxResultSizeChars → 磁盘持久化

9. PostToolUse Hooks
   ├── 可修改输出（MCP 工具）
   ├── 可附加 additionalContext、preventContinuation
   └── 可 blockingError 阻断后续

10. 注入消息数组
    └── 结果包装为 createUserMessage({ type: 'tool_result', ... })
    └── 下一轮 API 请求时模型"看到"结果
```

---

## 5. MCP 工具的特殊路径

MCP 服务器本身输出 JSON Schema。CC 不做 Zod 转换：

```typescript
// services/mcp/client.ts 第 1813 行
inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema']
```

```
MCP Server → JSON Schema → inputJSONSchema 字段 → 绕过 zodToJsonSchema()
                                                       ↓
                                              toolToAPISchema() 直接使用
```

MCP 工具的 Zod schema 只是一个 `z.object({}).passthrough()` 占位符（`tools/MCPTool/MCPTool.ts` 第 14 行）。

---

## 6. 并发模型

`toolOrchestration.ts`：

```
tools 列表
  ├── isConcurrencySafe === true 的 → 并行执行（最大并发数 = getMaxToolUseConcurrency()，默认 10）
  └── isConcurrencySafe === false 的 → 串行执行，一个一个来
```

流式工具执行（`StreamingToolExecutor.ts`）：细粒度流式 → 工具的 input 完整后就执行，不等待整个 assistant 消息完成。结果按原始顺序 yield。Bash 错误级联：一个 Bash 工具失败 → siblingAbortController 取消同级。

---

## 7. prompt.ts 的角色

每个工具目录下有 `prompt.ts`（或内联 `prompt()` 方法），返回**自然语言使用指南**。这不是 JSON Schema 的 `description` 字段（那是给每个参数加的），而是**整个工具的用法教学**：

- 什么时候用 / 什么时候不用
- 参数组合的最佳实践
- 边界情况和错误处理
- 跟其他工具的协调方式

这个文本成为 API 工具定义的 `description` 字段 → 模型逐个字符读到。这是 JSON Schema 做不到的——Schema 只能描述参数形状，prompt.ts 描述**使用智慧**。

---

## 8. 关键源文件

| 文件 | 核心内容 |
|------|---------|
| `Tool.ts:1-800+` | Tool 类型、buildTool()、ToolDef、validateInput |
| `utils/api.ts:119-220` | toolToAPISchema() —— Zod→API 的最终组装点 |
| `utils/zodToJsonSchema.ts` | Zod 原生 toJSONSchema() 的薄包装 + WeakMap 缓存 |
| `utils/lazySchema.ts` | 延迟初始化 Zod schema（模块加载时不构建） |
| `utils/toolSchemaCache.ts` | 会话级 API 序列化缓存 |
| `utils/toolPool.ts` | assembleToolPool() —— 内建 + MCP 工具合并 |
| `tools.ts:193-220` | getAllBaseTools() —— 工具注册表 |
| `tools/MCPTool/MCPTool.ts` | MCP 工具包装器（inputJSONSchema 路径） |
| `services/mcp/client.ts:1813` | MCP tool.inputSchema → inputJSONSchema 赋值点 |
| `tools/FileReadTool/prompt.ts` | 工具 prompt.ts 示例 |
| `constants/prompts.ts` | 全局系统提示词（教模型使用工具生态） |
