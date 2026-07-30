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

## Quick Start

```bash
# Set your Gemini API key (get one free at https://aistudio.google.com/apikey)
export GEMINI_API_KEY="your-key-here"

# Start everything — GitLab, Runner, and automatic setup
docker compose up -d

# Wait for setup to complete, then test the review
# (setup runs automatically and clones sindresorhus/conf)
cd repos/conf
git checkout -b feat/add-save-method
# make some changes (e.g. add a new feature)
git add -A && git commit -m "feat: add save method"
git remote add gitlab http://root:SecureRoot789!@localhost:8929/dev-team/conf.git
git push -u gitlab feat/add-save-method
# Open MR at http://localhost:8929/dev-team/conf
# Wait for the AI review pipeline to finish
```

## Architecture

```
gitlab-ai-reviewer/
├── agent/                        # 🧠 Review engine
│   ├── ci-review.mjs             # CI pipeline script (entry point)
│   ├── review-core.js            # Shared utilities (parsing, formatting, line mapping)
│   ├── prompt.md                 # AI prompt template with {{DATE}} placeholder
│   ├── src/
│   │   ├── index.ts              # Express webhook server
│   │   ├── reviewer.ts           # Review orchestration
│   │   ├── gitlab.ts             # GitLab API client
│   │   ├── types.ts              # TypeScript types
│   │   └── ai/
│   │       ├── provider.ts       # AI provider interface
│   │       └── gemini.ts         # Gemini integration
│   ├── Dockerfile                # Container image for webhook server
│   └── package.json
├── repos/                        # 📦 Cloned test repos (gitignored)
│   └── .gitkeep
├── scripts/
│   ├── setup.sh                  # 🚀 Auto-runs via docker-compose setup service
│   └── seed-test-repo.sh         # Fallback: generates a test repo if clone fails
├── setup/
│   └── Dockerfile                # Lightweight container for setup service
├── test/
│   ├── send-webhook.sh           # Test script for webhook mode
│   └── webhook-payload.json      # Sample webhook payload
├── docker-compose.yml            # GitLab CE + Runner + Auto-setup
└── .env.example                  # Environment variables template
```

## How the CI Pipeline Runs

The review runs as a CI job inside the target project's pipeline — no external servers. The pipeline script (`ci-review.mjs`) and shared utilities (`review-core.js`) are stored in a central `dev-team/ci-templates` project and fetched at runtime via raw URL.

Target projects include the template:
```yaml
include:
  - project: dev-team/ci-templates
    file: ci-template.yml
    ref: main
```

The CI job:
1. Fetches `review-core.js` and `prompt.md` from the templates project
2. Retrieves the MR diff and full file contents from the GitLab API
3. Parses spec requirements from the MR description and `.review-rules.md`
4. Sends everything to Google Gemini with a structured prompt
5. Posts a summary note and inline comments on the MR
6. Saves `review-result.json` as a CI artifact
7. Exits with code 1 if issues found — blocking the merge

## What Gets Created

When `docker compose up` runs, the `setup` service automatically:

| Resource | Description |
|---|---|
| `dev-team` group | GitLab group for all projects |
| `dev-team/ci-templates` | CI template project with `ci-review.mjs`, `review-core.js`, `prompt.md`, `ci-template.yml` |
| `dev-team/conf` | Mirror of `sindresorhus/conf` — a real open-source TypeScript config library |
| `repos/conf/` | Local clone — edit code here and push to GitLab to test the review |
| `project-runner` | GitLab Runner registered with Docker executor |
| CI labels | `review/pass` and `review/fail` labels on the test project |

## Customization

### Use Your Own Test Repo

```bash
export SOURCE_REPO="https://github.com/your-org/your-repo.git"
docker compose up -d
```

Or run setup manually with any repo:
```bash
./scripts/setup.sh https://github.com/your-org/your-repo.git
```

### Prompt

Edit `agent/prompt.md` to change review criteria. The `{{DATE}}` placeholder is replaced at runtime. The AI always returns structured JSON:

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

### Project Rules

Create `.review-rules.md` in your project's default branch:

```markdown
## Spec
- [ ] Hardcoded API secrets must be removed before merge
- [ ] All eval() calls must be removed
```

The AI checks each rule against the diff.

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

## Pipeline Behavior

| Condition | Result |
|---|---|
| No issues found | Pipeline passes, `review-result.json` with `approved: true` |
| Issues found | Pipeline fails (exit 1), artifact saved with issues listed |
| No diff changes | Pipeline exits 0 (skip) |
| Spec requirement not met | `approved: false` regardless of other comments |

## Project Files

| File | Purpose |
|---|---|
| `agent/ci-review.mjs` | CI pipeline script |
| `agent/review-core.js` | Shared utilities |
| `agent/prompt.md` | AI prompt template |
| `agent/src/index.ts` | Webhook server |
| `agent/src/reviewer.ts` | Review orchestration |
| `agent/src/gitlab.ts` | GitLab API client |
| `scripts/setup.sh` | Auto-runs on docker compose up via setup service |
| `scripts/seed-test-repo.sh` | Fallback: generates a test repo if clone fails |
| `setup/Dockerfile` | Container for the auto-setup service |
| `docker-compose.yml` | GitLab CE + Runner + Reviewer + Auto-setup |
