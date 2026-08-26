# 执行步骤

## Step 1: agent_def.ts — 删 `private tools`

```typescript
// 删掉 L61: private tools: Tools;
// constructor 里把 this.tools 改成局部变量
```

## Step 2: agent_def.ts — 构造时读 memory

```typescript
// constructor 加: this.userMemory = new ConfigStore().loadMemory();
// buildSystemPrompt 改: const memory = this.userMemory;
```

## Step 3: agent_def.ts — toolContext 加 tavilyApiKey

```typescript
// constructor:
this.toolContext = {
  options: { tools, ..., tavilyApiKey: (config as any).tavilyApiKey },
  ...
};
```

## Step 4: WebSearchTool — 用 ctx 替代 loadConfig

```typescript
// 删: import { loadConfig } from '../../../config.js';
// call() 改: const key = ctx.options.tavilyApiKey;
```

## Step 5: config.ts — 删 loadConfig 向后兼容导出

## Step 6: 编译验证

```bash
npx tsc --noEmit && npm run build
grep -rn "loadConfig" src/  # 应仅剩 config.ts 内部使用
grep "private tools" src/agent_def.ts  # 应无结果
```

## Step 7: 烟雾测试

```bash
echo "/exit" | node dist/Mythinknode.js
```
