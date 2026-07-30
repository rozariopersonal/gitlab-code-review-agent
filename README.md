# GitLab AI Code Review Agent

Automated code review for GitLab merge requests powered by Google Gemini AI. Posts inline comments, enforces spec requirements, and blocks merges on critical issues — no webhooks required.

## How It Works

```
Developer pushes MR ──► GitLab CI triggers review job
                              │
                              ▼
                    ci-review.mjs runs in pipeline
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              Fetch diff +        Parse spec requirements
              full files          from MR description +
                                  .review-rules.md
                    │                    │
                    └─────────┬──────────┘
                              ▼
                    Send to Google Gemini
                    with structured prompt
                              │
                              ▼
                    Parse JSON response
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              Post summary note    Post inline comments
              (MR discussion)      (per-line on diff)
                              │
                              ▼
                    Save review artifact
                    (review-result.json)
                              │
                              ▼
                    Quality gate: exit 1
                    if issues found → blocks merge
```

## Architecture

```
gitlab-ai-reviewer/
├── agent/
│   ├── ci-review.mjs          # CI pipeline script (entry point)
│   ├── review-core.js          # Shared utilities (parsing, formatting, line mapping)
│   ├── prompt.md               # AI prompt template with {{DATE}} placeholder
│   ├── src/
│   │   ├── index.ts            # Express webhook server
│   │   ├── reviewer.ts         # Review orchestration
│   │   ├── gitlab.ts           # GitLab API client
│   │   ├── types.ts            # TypeScript types
│   │   └── ai/
│   │       ├── provider.ts     # AI provider interface
│   │       └── gemini.ts       # Gemini integration
│   ├── Dockerfile              # Container image for webhook server
│   ├── package.json
│   └── tsconfig.json
├── mock/
│   └── src/index.ts            # Mock GitLab API for local development
├── test/
│   ├── send-webhook.sh         # Test script for webhook mode
│   └── webhook-payload.json    # Sample webhook payload
├── docker-compose.yml          # Full dev environment (GitLab + Runner + Agent)
└── .env.example                # Environment variables template
```

## Two Deployment Modes

### 1. CI Pipeline Mode (Primary)

The review runs as a job inside your GitLab CI pipeline — no webhooks, no servers to maintain.

**Setup:**

#### A. Create a CI Templates project

Create a project (e.g., `dev-team/ci-templates`) and add these files:

**ci-template.yml** — The reusable CI template:

```yaml
stages:
  - review

ai-review:
  stage: review
  image: node:22-alpine
  before_script:
    - apk add --no-cache curl
    - curl -sO http://gitlab:8929/dev-team/ci-templates/-/raw/main/ci-review.mjs
  script:
    - node ci-review.mjs
  artifacts:
    when: always
    paths:
      - review-result.json
    expire_in: 30 days
  variables:
    NODE_ENV: production
    GITLAB_URL: http://gitlab:8929
  rules:
    - if: $CI_MERGE_REQUEST_IID
```

Add `ci-review.mjs` and `review-core.js` to the same project. These are fetched at pipeline runtime by the CI job.

#### B. Configure CI variables

| Variable | Description |
|---|---|
| `GITLAB_TOKEN` | GitLab PAT with Reporter scope (for posting comments) |
| `GEMINI_API_KEY` | Your Google Gemini API key |

Set these in **Settings → CI/CD → Variables** on the target project.

#### C. Enable the review in your project

Add one file — `.gitlab-ci.yml`:

```yaml
include:
  - project: dev-team/ci-templates
    file: ci-template.yml
    ref: main
```

That's it. Every MR will automatically trigger an AI review.

#### D. (Optional) Add project rules

Create `.review-rules.md` in your project's default branch with a `## Spec` section:

```markdown
## Spec
- [ ] Hardcoded API secrets must be removed before merge
- [ ] All eval() calls must be removed
- [ ] Payment failures must be propagated, not silently logged
```

The AI will check each rule against the diff.

### 2. Webhook Server Mode

For non-CI environments or offline review:

```bash
# Start the server
docker compose up reviewer
```

Configure GitLab to send MR webhooks to `http://reviewer:3005/webhook/gitlab`.

## What the AI Checks

- Logic bugs and race conditions
- Security flaws (hardcoded secrets, eval, injection)
- Performance problems
- Error handling gaps
- Missing documentation on exported functions/APIs
- Over-engineering / YAGNI violations
- Reinventing the wheel
- Breaking changes (signature changes, interface changes)
- Side effects and mutation
- Unused code
- High cyclomatic complexity
- Algorithmic complexity concerns (unnecessary O(n²) vs O(n))
- Spec requirement compliance
- Project rule enforcement

## Customizing the Prompt

Edit `prompt.md` to change how the AI evaluates code. The `{{DATE}}` placeholder is replaced with today's date at runtime. The AI always returns structured JSON matching the expected schema:

```json
{
  "summary": "1-line summary",
  "approved": true,
  "comments": [
    { "note": "Issue description", "path": "file.ts", "line": 42 }
  ],
  "specResults": [
    { "text": "requirement", "satisfied": true },
    { "text": "another", "satisfied": false, "reason": "explanation" }
  ]
}
```

## Local Development

```bash
# Copy environment config
cp .env.example .env
# Edit .env with your tokens

# Start full environment
docker compose up -d

# GitLab is available at http://localhost:8929
# Reviewer server at http://localhost:3005
```

The mock server provides a fake GitLab API for testing review logic without a real instance:

```bash
docker compose up mock
```

## Pipeline Behavior

| Condition | Result |
|---|---|
| No issues found | Pipeline passes, `review-result.json` saved with `approved: true` |
| Issues found | Pipeline fails (exit 1), artifact saved with issues listed |
| No diff changes | Pipeline exits 0 (skip) |
| Spec requirement not met | `approved: false` regardless of other comments |

## Project Files

| File | Purpose |
|---|---|
| `agent/ci-review.mjs` | Main CI pipeline script |
| `agent/review-core.js` | Shared utilities shared by CI and webhook modes |
| `agent/prompt.md` | AI prompt template |
| `agent/src/index.ts` | Webhook server |
| `agent/src/reviewer.ts` | Review orchestration logic |
| `agent/src/gitlab.ts` | GitLab REST API client |
| `mock/src/index.ts` | Mock GitLab API for testing |
