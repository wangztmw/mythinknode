# tools-v2 改进总结 ✅ 完成

> **时间**：2026-08-01 | **状态**：完成

## 对照原始工具后发现的差距

| 工具 | 已改进 | 跳过原因 |
|------|--------|---------|
| **BashTool** | ✅ 危险命令检测 (7 patterns) + exit code分离 + signal处理 | 沙箱太重 |
| **FileEditTool** | ✅ 重复匹配检测(line号+上下文) + 空字符串拒绝 + 原子写入 + CRLF规范 | diff生成太重 |
| **FileReadTool** | ✅ 二进制检测 + 10MB限制 + 图片/PDF/Jupyter通知 + 绝对路径验证 | sharp太重 |
| **FileWriteTool** | ✅ 原子写入(tmp+rename) + 空内容警告 + 尾部换行提示 | |
| **GlobTool** | ✅ 排序输出 + 截断计数 + ripgrep优先(.gitignore) | |
| **GrepTool** | ✅ 上下文行(-C) + ripgrep优先(.gitignore) + 匹配计数 + 截断指导 | |

## 刻意不做的（太重）

- Bash沙箱(Bubblewrap/Seatbelt): 2,400行安全代码，个人使用不需要
- FileRead图片/PDF解析(sharp/napi): 原生模块太重
- FileEdit diff生成: 需要git集成
- 并发安全(文件锁): 单用户Agent不需要
- 权限管线(14步): 单用户不需要

## 验证

npx tsc 零错误，DeepSeek 6064ms 正常响应
