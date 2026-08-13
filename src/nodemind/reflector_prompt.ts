/**
 * Reflector 反思提示词 — 基于 Skill Building Complete Guide 方法论。
 * 适配 NodeMind 数据结构（keywords + content + attrs + children）。
 */

export interface ReflectPromptInput {
  sessionSummary: string;
  outcome: string;
  rounds: number;
  treeSummary: string;
}

export function buildReflectPrompt(input: ReflectPromptInput): string {
  const { sessionSummary, outcome, rounds, treeSummary } = input;

  return `Analyze this completed session. Create ONE experience node if it produced reusable knowledge.

## Session
- Outcome: ${outcome}
- Rounds: ${rounds}

${sessionSummary}

## Existing Tree
${treeSummary || '(empty)'}

---

## Remember vs Reflector — Division of Labor

**Remember** captures in-the-moment discoveries. Each tag should be:
- Structurally complete: Symptom → Root Cause → Fix, with exact commands/errors/versions
- Data-accurate: copy-paste-able values in fields
- As comprehensive as possible: try to tag everything notable you encounter

**Reflector** is the safety net. Your job:
- If Remember tags exist → their data is trustworthy. Use them as building blocks. Also check the full tool log — there may be additional discoveries the agent didn't get a chance to tag. Expand the story, don't just repeat the tags.
- If Remember tags are absent but tools were used → build the node from scratch from the tool log.
- In all cases: the tool log is your primary evidence.

## Cross-Session Awareness

**[REMEMBER_TAG] markers** may reference tool work done in a PRIOR session — if the Tool Execution Log is sparse but tags exist, look at **Prior Session Summaries** ([S{n}] blocks) for the actual tool execution. Tags provide the insight; prior summaries provide the evidence.

**If [REMEMBER_TAG] markers exist → always create a node.** Override any skip condition.

The Tool Execution Log and Prior Session Summaries together tell the complete story. Read them segment by segment for: tool names, commands, file paths, error codes, decision pivots. Reference like "R3.2: Bash curl → 403".

---

## Step 1 — Worth Recording? (Decision Tree)

If [REMEMBER_TAG] markers exist → skip this step, go directly to Step 2. Tags override all skip conditions.

Otherwise, answer these four questions. If ALL are YES → create. Otherwise → {"action":"skip"}.

1. **Repeatable?** Will this task or tool usage recur across sessions?
2. **Error-prone?** Are there known failure patterns the agent hits without guidance?
3. **Resource-dependent?** Are there specific commands, configs, selectors, or code the agent can't derive on its own?
4. **Verifiable?** Is there a clear way to tell if the approach worked?

**Skip if:** simple Q&A, no tools used, or nothing beyond what any competent agent would know.

---

## Step 2 — Classify the Node Type

Choose the dominant pattern — it determines how you structure the content:

| Type | Signal | Content Structure |
|---|---|---|
| **Workflow** | Multi-phase task, pipeline, generate, scaffold | Invocation → Phase 0…N → Report |
| **Tool** | Single operation, convert, format, transform | Trigger → Process (numbered steps) → Output → Error Table |
| **Reference** | Rules, patterns, data, "remind me about X" | Purpose → When to Apply → Data → Never Do |
| **Integration** | External API, MCP tool, database connection | Setup → API Pattern → Error Mapping → Gotchas |
| **Swarm** | Multi-agent coordination, parallel dimensions | Decomposition → Per-agent briefs → Merge Rules |

---

## Step 3 — Write the keywords (routing trigger)

**keywords** is the routing field — it determines whether future searches find this node.

Rules:
- Include: task domain + specific technologies + ALL significant tool names used
- Be specific enough to avoid false triggers, broad enough to catch variations
- Example: ["form-filling","browser-automation","anti-crawl","puppeteer","Chrome-CDP","Bash","FileWrite"]
- This enables queries like "what tasks used Bash?" or "form automation pitfalls"

---

## Step 4 — Write the content (the Skill body)

**CRITICAL PRINCIPLES — apply throughout:**

### Delta Principle
Only record what the model CANNOT derive on its own. Do NOT write:
- Generic quality statements ("ensure code is clean and performant")
- Explanations of standard concepts (HTTP, JSON, Git)
- Filler that any competent agent already knows

Ask yourself: "Would the agent get this wrong without this line?" If no → delete it.

### Procedure Over Declaration
Do NOT write "output must be valid." Instead, write the verification procedure:
"Run \`npx tsc --noEmit\` → if errors, fix the first reported line → repeat until clean."

### Default Over Menu
At every decision point, provide a default. Mention alternatives only when the default explicitly fails.

### Explain WHY
Don't use ALL-CAPS NEVER/ALWAYS. Explain why a constraint exists. Models with causal understanding outperform models following blind rules.

### Content Structure (follow the classified type from Step 2):

## Task Background
- What was the user's goal? Context, constraints, environment.
- Why was this non-trivial?

## Planning
- How was the task decomposed? What strategy was chosen and why?
- What alternatives were considered but not attempted (and why)?

## Execution (step by step — preserve temporal order)
For EACH significant attempt:
- **Tool + key parameters** → **Result** (success or exact error message, include error codes)
- If error → **What was tried next and why**
- Reference the Tool Execution Log: "R3.2: Bash curl → HTTP 403..."
- Reference attrs inline: (见attrs:xxx)

Record the FULL chain — failed attempts are MORE valuable than successes.

## Outcome
- Final result. What worked and why.
- What failed and why? Include specific errors, codes, symptoms, versions.

## Gotchas (MANDATORY — this is the soul of the Skill)
Record every concrete pitfall from the execution. Follow the Gotcha Checklist:
1. **Repeatable** — would this happen again?
2. **High-cost** — is the consequence severe (data loss, security, wasted hours)?
3. **Code-invisible** — can you spot this from reading the code, or only at runtime?

Format each gotcha as: **Symptom** → **Root Cause** → **Fix**.
Store detailed gotchas as attrs of type "note" and reference them here.
Example: "First render blank after adding filter → Filter must be registered before app.init() (见attrs:filter-registration)"

## Key Learnings
- What to remember for next time.
- What to AVOID and WHY.
- Decision rules: "When you see X, do Y, because Z."

---

## Step 5 — Extract Attrs

Attrs = copy-paste-able artifacts. Four types:

| Type | What to store | Examples |
|---|---|---|
| **code** | Code snippets (≥3 lines), library imports, function calls | puppeteer.connect({browserURL}) |
| **command** | Exact CLI commands, shell scripts, tool invocations | chrome --remote-debugging-port=9222 |
| **config** | Configuration values, env vars, ports, URLs, selectors | #name, #phone, .submit-btn |
| **note** | Gotchas, observations, warnings, error codes with explanations | HTTP 403 → Cloudflare WAF |

Rules:
- Fields MUST contain copy-paste-able values — not vague descriptions
- Do NOT create attrs for content already fully described in the content body
- Gotchas stored as attrs should include: symptom, root cause, fix, first-seen date
- One attr per distinct artifact; don't cram unrelated things into one attr

---

## Step 6 — Self-Check Before Returning (P0 — must pass)

- [ ] keywords cover: domains + technologies + ALL significant tools used
- [ ] Content is written as standing rules ("When X, always Y"), not one-shot instructions
- [ ] Delta principle applied — no filler, no standard-concept explanations
- [ ] Procedures are specific ("run X → fix first error → repeat"), not declarative ("output must be valid")
- [ ] Execution section preserves temporal order with tool references from the log
- [ ] Gotchas section has ≥1 entry (if the session had failures) or ≥0 (if pure success)
- [ ] Each gotcha answers: symptom, root cause, fix
- [ ] Attrs are concrete and copy-paste-able; no vague notes as attrs
- [ ] Content is ≤600 words (if longer, move details to attrs)

---

## Anti-Patterns (DO NOT)

- ❌ One node per tool — merge everything for one task into ONE node
- ❌ Encyclopedia node — covering unrelated domains in one node
- ❌ Declarative instructions — "output must be valid JSON" without saying HOW
- ❌ Filler content — "ensure code quality," "follow best practices"
- ❌ No gotchas after a session full of errors — every failure is a gotcha
- ❌ Hardcoded paths, IDs, or credentials in content or attrs

---

## GOOD EXAMPLE (reference structure)

### keywords
["form-filling","browser-automation","anti-crawl","puppeteer","Chrome-CDP","Bash","Read","Write","FileEdit"]

### Content

## Task Background
User needed to auto-fill a recruitment website form behind Cloudflare WAF. The form had dynamic selectors that changed per session.

## Planning
Agent chose 3 approaches in order of increasing complexity: 1)Direct HTTP POST 2)Selenium browser automation 3)CDP over existing Chrome instance. Rationale: start simple, escalate only on failure.

## Execution
### Attempt 1: Direct HTTP POST
Bash: curl POST to form endpoint → HTTP 403, Cloudflare WAF challenge page (见attrs:waf-403). The site detects non-browser User-Agent headers.

### Attempt 2: Selenium
Bash: npx selenium-webdriver, Chrome headless mode → navigator.webdriver=true detected by site, CAPTCHA triggered (见attrs:selenium-detection). Stealth plugin (selenium-stealth) failed — the site uses behavior-based detection beyond property masking.

### Attempt 3: CDP (success)
Bash: chrome --remote-debugging-port=9222 --user-data-dir=./profile. Key pre-condition: manually browsed the site for 2 minutes first to warm the browser session. Write: automation script connecting via puppeteer.connect({browserURL}) (见attrs:cdp-script). Read: extracted form selectors (见attrs:form-selectors). Bash: node cdp-fill.js → form submitted successfully.

## Outcome
Success via CDP. Critical factor: manual browser warm-up before automation. Without warm-up, even CDP failed once (session appeared bot-like).

## Gotchas
- **CDP fails without warm-up** → Chrome must have organic browsing history before connecting, or site still flags the session. Fix: manually browse target site ≥2min before running CDP script (见attrs:cdp-warmup).
- **Selenium stealth insufficient** → Modern WAF uses behavior analysis beyond navigator.webdriver masking. Fix: prefer CDP over Selenium for anti-crawl scenarios.
- **Form selectors are session-specific** → Selectors changed between sessions. Fix: always re-extract selectors at runtime; never hardcode (见attrs:form-selectors).

## Key Learnings
- Cloudflare WAF blocks direct HTTP → must use real browser channel
- Selenium detectable even with stealth → CDP is the escalation path
- Browser warm-up is the single most critical step — skip it and everything fails
- When selectors are dynamic, extract them fresh each session

### Attrs
(See GOOD EXAMPLE attrs below)

---

## GOOD EXAMPLE — attrs format

[
  {"title":"CDP launch script","type":"code","content":"Chrome DevTools Protocol connection","fields":{"library":"puppeteer-core@21","command":"chrome --remote-debugging-port=9222 --user-data-dir=./profile","connection":"puppeteer.connect({browserURL: 'http://localhost:9222'})","warmup":"manually browse target site ≥2min before connecting"}},
  {"title":"Form selectors","type":"config","content":"Recruitment site form field selectors (session-specific)","fields":{"name":"#candidate_name","phone":"#phone_number","submit":".apply-btn-primary","note":"selectors change per session — always re-extract"}},
  {"title":"WAF 403 error","type":"note","content":"Cloudflare WAF blocks direct HTTP to form endpoint","fields":{"symptom":"HTTP 403 with Cloudflare challenge page","root_cause":"Site detects non-browser requests via User-Agent and TLS fingerprint","fix":"Use real browser via CDP, not direct HTTP"}},
  {"title":"Selenium detection","type":"note","content":"Site detected Selenium despite stealth plugin","fields":{"symptom":"CAPTCHA triggered, navigator.webdriver=true detected","root_cause":"Site uses behavior-based detection beyond property masking","fix":"Abandon Selenium; escalate to CDP"}}
]

---

**parentNode:** Existing node ID to place under (match by keywords). Omit for root.

Return ONLY JSON — no markdown, no explanation:
{"action":"skip"|"create","parentNode":"...","title":"...","keywords":[...],"content":"...","attrs":[...]}`;
}
