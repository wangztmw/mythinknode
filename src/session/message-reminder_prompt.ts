/**
 * 记忆召回提示词 — 让 LLM 从候选关键词里选出与当前输入相关的。
 * 只「选」不「生成」，避免选出的词对不上索引。
 */
export function buildReminderPrompt(userInput: string, candidates: string[]): string {
  return `You are a memory retriever for an AI coding agent. Given the user's current input and a list of topic keywords extracted from earlier in this conversation, select the keywords most relevant to the current input.

## Current input:
${userInput}

## Candidate keywords:
${candidates.join(', ')}

## Rules:
- Select 0-5 keywords. Choose ONLY from the candidate list above — do not invent new keywords.
- If the current input is a brand-new topic unrelated to any candidate, output an empty array [].
- Prefer concrete keywords (file names, error terms, specific features) over vague ones.

## Output:
A JSON array of selected keywords. Example: ["终端崩溃", "二维屏幕缓冲"]
Output ONLY the JSON array, nothing else.`;
}
