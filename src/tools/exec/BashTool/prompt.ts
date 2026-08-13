export const DESCRIPTION = `Execute a shell command. Primary tool for: running code, tests, git, npm, file ops.

⚠️ PROCESS SAFETY RULES (HARD CONSTRAINTS — ignored commands WILL be blocked):
- NEVER use pkill, killall, or any broadcast process-kill command
- NEVER use "ps | grep ... | xargs kill" or similar pipelines
- NEVER use kill -9 1, reboot, shutdown, or halt
- NEVER use rm -rf / (or any variant with trailing /)
- NEVER use fork bombs: :(){ :|:& };:, or similar recursive functions
- NEVER use chmod -R 777 / or chmod 777 on system paths
- NEVER target the process identified by SELF_PID or SELF_IDENTITY

TIME: use timeout param for long tasks (default 120s, max 600s). Run blocking commands (sleep, long builds) with run_in_background: true.`;
