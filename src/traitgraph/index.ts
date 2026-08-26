/**
 * traitgraph 模块级当前会话 —— 工具与召回共用。
 *
 * session_loop 在 runSession 开头 setTraitGraphSessionId(session.id),
 * 结尾 clearTraitGraphSessionId()。工具据此定位"当前会话的 traitraw/"。
 * 对齐 nodemind 的 setSearchLLM / infermem 的 setInfermemLLM 模式。
 */

let _sessionId: string | null = null;

export function setTraitGraphSessionId(sessionId: string): void {
  _sessionId = sessionId;
}

export function clearTraitGraphSessionId(): void {
  _sessionId = null;
}

export function getTraitGraphSessionId(): string {
  return _sessionId ?? 'default';
}

export function hasTraitGraphSessionId(): boolean {
  return _sessionId !== null;
}
