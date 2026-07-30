# GitLab AI Code Review Agent

Automated code review for GitLab merge requests powered by Google Gemini AI. Posts inline comments, enforces spec requirements, and blocks merges on critical issues — no webhooks, no servers to maintain.

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
git add -A && git commit -m "feat: add save method"
git remote add gitlab http://root:SecureRoot789!@localhost:8929/dev-team/conf.git
git push -u gitlab feat/add-save-method
# Open MR at http://localhost:8929/dev-team/conf
# Watch the AI review pipeline run
```

## Architecture

```
gitlab-ai-reviewer/
├── agent/                        # Review engine
│   ├── ci-review.mjs             # CI pipeline script (entry point)
│   ├── review-core.js            # Shared utilities (pure functions, no deps)
│   └── prompt.md                 # AI prompt template with {{DATE}}
├── repos/                        # Cloned GitHub repos (gitignored)
│   └── .gitkeep
├── setup/
│   ├── Dockerfile                 # Container for the auto-setup service
│   ├── setup.sh                   # Auto-runs via docker-compose setup service
│   └── seed-test-repo.sh          # Fallback: generates a test repo if clone fails
│   └── Dockerfile                # Container for the auto-setup service
├── docker-compose.yml            # GitLab CE + Runner + Auto-setup
└── .env.example                  # Environment variables template
```

## How the AI Review Runs

The review runs as a CI job inside the target project's pipeline — no external servers needed.

### CI Templates Project

The pipeline script (`ci-review.mjs`) and utilities (`review-core.js`, `prompt.md`) live in a central `dev-team/ci-templates` project. Target projects include them:

```yaml
include:
  - project: dev-team/ci-templates
    file: ci-template.yml
    ref: main
```

At pipeline runtime, `ci-review.mjs` fetches `review-core.js` and `prompt.md` from the templates project via raw URL, then:

1. Retrieves the MR diff and full file contents from the GitLab API
2. Parses spec requirements from the MR description and `.review-rules.md`
3. Sends everything to Google Gemini with a structured prompt
4. Posts a summary note and inline comments on the MR
5. Saves `review-result.json` as a CI artifact
6. Exits with code 1 if issues found — blocking the merge

## What Gets Created on `docker compose up`

| Resource | Description |
|---|---|
| `dev-team` group | GitLab group for all projects |
| `dev-team/ci-templates` | CI template project with review files |
| `dev-team/conf` | Mirror of `sindresorhus/conf` (real open-source TypeScript project) |
| `repos/conf/` | Local clone — edit here and push to GitLab to test the review |
| `project-runner` | GitLab Runner registered with Docker executor |
| CI labels | `review/pass` and `review/fail` on the test project |

## Customization

### Use Your Own Repo

```bash
export SOURCE_REPO="https://github.com/your-org/your-repo.git"
docker compose up -d
```

Or run setup manually:
```bash
./setup/setup.sh https://github.com/your-org/your-repo.git
```

### Prompt

Edit `agent/prompt.md` to change how the AI evaluates code. The `{{DATE}}` placeholder is replaced at runtime. The AI must return structured JSON:

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
| `agent/review-core.js` | Shared utilities (pure functions, zero dependencies) |
| `agent/prompt.md` | AI prompt template |
| `setup/setup.sh` | Auto-runs on docker compose up via setup service |
| `setup/seed-test-repo.sh` | Fallback: generates test repo if clone fails |
| `setup/Dockerfile` | Container for the auto-setup service |
| `docker-compose.yml` | GitLab CE + Runner + Auto-setup |
