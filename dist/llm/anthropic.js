/**
 * Anthropic Provider 实现
 */
import { z } from 'zod/v4';
import { fetchWithRetry } from './retry.js';
export const anthropicProvider = {
    name: 'anthropic',
    formatTools(tools) {
        return tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: z.toJSONSchema(t.inputSchema),
        }));
    },
    formatToolResult(toolCallId, output) {
        return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCallId, content: output }],
        };
    },
    async call(systemPrompt, messages, apiKey, model, tools, openaiBase, maxTokens) {
        const body = {
            model,
            max_tokens: maxTokens ?? 384000,
            system: systemPrompt,
            messages: messages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => ({ role: m.role, content: m.content })),
            tools,
        };
        const r = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });
        if (!r.ok)
            throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d = await r.json();
        return {
            content: d.content || [],
            stop_reason: d.stop_reason || '',
        };
    },
};
