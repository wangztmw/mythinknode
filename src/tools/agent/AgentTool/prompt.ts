export const DESCRIPTION = `Manage sub-agents and background tasks with 5 actions:

spawn   — Launch a sub-agent. Use background=true for parallel work.
check   — Read an agent's full report and status.
wait_any — Wait until any agent completes/blocked/fails. Returns immediately on first change.
direct  — Inject a new instruction into a running agent (redirect blocked ones).
kill    — Stop a running agent.

Coordination flow: spawn(N agents) → wait_any → check → decide(direct/kill/continue waiting) → summarize for user.`;
