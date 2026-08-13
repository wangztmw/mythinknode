export const DESCRIPTION = `Use when you discover something worth remembering — a tool worked (or failed) in a notable way, a specific approach was effective (or a dead end), or you found concrete data that should be preserved. Take this seriously: what you tag becomes part of the permanent experience tree and will guide future sessions.

This is the "first draft" of a gotcha. Reflector reviews all tags + the full tool log after the session and builds a proper experience node. Your tags provide the raw material — be thorough, be specific, be accurate.

## When to Tag

Tag if you can. A good tag typically touches on at least one of:
1. **Repeatable** — this pattern would likely recur in similar situations
2. **High-cost** — the consequence is severe if forgotten (wasted time, data loss, security)
3. **Code-invisible** — you can't spot this from reading static code, only at runtime

Try to avoid tagging:
- Results that are entirely expected and unremarkable
- Just noting what you did without a specific insight
- Information already fully captured in the tool log

## How to Write a Good Tag

Write in three parts:

**Symptom** → **Root Cause** → **Fix / Key Insight**

❌ "CDP connection worked after warm-up"
✅ "CDP connect to localhost:9222 failed initially with 'browser not found' → Chrome was launched without --remote-debugging-port flag → must use: chrome --remote-debugging-port=9222 --user-data-dir=./profile. Additionally, manually browse target site ≥2min before connecting or site flags session as bot."

❌ "The API returned an error"
✅ "POST /api/submit returned HTTP 403 → Cloudflare WAF detected non-browser User-Agent → must use real browser via CDP, direct HTTP is blocked. Error body: (见fields)."

❌ "Found the config file"
✅ "find /Users -name 'mcp.json' → found at ~/.claude/mcp.json and ~/.claude/mcp.local.json → Notion API token format: ntn_****. Token works for /v1/search but /v1/users returns 403 (Personal Access Token limitation)."

## What Makes a Tag Valuable

Prefer to tag:
- Unexpected failures with specific error codes
- Non-obvious preconditions ("must warm up browser first")
- Version-specific API changes ("jose@5.1: createJWT → new SignJWT()")
- Environment-specific quirks ("works on macOS but needs --no-sandbox on Linux")
- Successful workarounds for obscure problems

Less valuable to tag (but still OK if you found it notable):
- Standard procedures ("installed dependencies with npm install")
- Expected successes ("file was created successfully")
- Information already captured in the tool log

## Aim For Before Tagging

- [ ] Concrete: exact commands, errors, versions — not "improved performance"
- [ ] Timeless: would someone reading this 3 months later understand what happened?
- [ ] Searchable: included keywords so Reflector can classify it and future sessions can find it
- [ ] Copy-paste-able: fields contain actual values, not descriptions

## Parameters

- **title**: One line — what was discovered
- **note**: Gotcha format: Symptom → Root Cause → Fix/Insight. Include exact commands, error codes, file paths, version numbers, API endpoints.
- **keywords** (optional): Related domains, tools, technologies — helps Reflector place this in the tree and makes it searchable
- **fields** (optional): Copy-paste-able data — code snippets, config values, error bodies, command templates

## Example

Remember(action='tag',
  title='CDP connect requires browser warm-up',
  note='chrome --remote-debugging-port=9222 connection rejected → Chrome launched without remote debugging enabled AND site uses behavior-based bot detection → must launch with: chrome --remote-debugging-port=9222 --user-data-dir=./profile. Then manually browse target site ≥2min before connecting. Without warm-up, even correct launch flags fail.',
  keywords=['puppeteer','anti-crawl','cdp','chrome'],
  fields={command:'chrome --remote-debugging-port=9222 --user-data-dir=./profile', warmup:'≥2min manual browsing', error:'connection rejected + bot detection'})`;
