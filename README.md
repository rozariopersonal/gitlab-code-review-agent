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
# 1. Start GitLab + Runner
docker compose up -d

# 2. Set your Gemini API key
export GEMINI_API_KEY="your-key-here"

# 3. Run setup — creates templates + test repo on local GitLab
./scripts/setup.sh

# 4. Test the review
cd repos/order-service
git checkout -b feat/test-review
# make some changes...
git add -A && git commit -m "Test review"
git remote add gitlab http://root:SecureRoot789!@localhost:8929/dev-team/order-service.git
git push -u gitlab feat/test-review
# Open MR at http://localhost:8929/dev-team/order-service
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
│   └── setup.sh                  # 🚀 One-command environment setup
├── test/
│   ├── send-webhook.sh           # Test script for webhook mode
│   └── webhook-payload.json      # Sample webhook payload
├── docker-compose.yml            # GitLab CE + Runner + Reviewer
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

## Setup

### Prerequisites

- Docker & Docker Compose
- A Google Gemini API key ([get one free](https://aistudio.google.com/apikey))

### One-Command Setup

```bash
# Start GitLab and the Runner
docker compose up -d

# Run setup (creates templates project + test repo)
GEMINI_API_KEY="your-key-here" ./scripts/setup.sh
```

The setup script:
1. Waits for GitLab to be healthy
2. Creates the `dev-team/ci-templates` project with `ci-review.mjs`, `review-core.js`, `prompt.md`, and `ci-template.yml`
3. Clones a GitHub repo into `repos/<name>` (default: `order-service-test`)
4. Creates the `dev-team/<repo>` project on GitLab
5. Pushes the repo and adds `.gitlab-ci.yml` with the template include
6. Creates CI labels and sets the `GITLAB_TOKEN` variable

### Custom Test Repo

Use any GitHub repo as the test project:

```bash
./scripts/setup.sh https://github.com/your-org/your-repo.git
```

Once cloned to `repos/<name>`, you can edit code locally and push to the local GitLab to test the review.

### CI Variables

Set these in your target project's **Settings → CI/CD → Variables**:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key |
| `GITLAB_TOKEN` | GitLab PAT (Reporter scope) for posting comments |

## Customization

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
| `scripts/setup.sh` | One-command environment setup |
| `docker-compose.yml` | GitLab CE + Runner + Reviewer |
