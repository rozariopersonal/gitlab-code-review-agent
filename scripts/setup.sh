#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# GitLab AI Reviewer — Full Environment Setup
#
# 1. Creates the CI templates project (dev-team/ci-templates)
#    and uploads agent/ files (ci-review.mjs, review-core.js,
#    prompt.md) as the CI template.
# 2. Clones a GitHub repo and pushes it as a test project
#    so you can open MRs and verify the AI review.
#
# Usage:
#   ./scripts/setup.sh [github-repo-url]
#
# Default: https://github.com/sindresorhus/conf.git (247 KB, TypeScript)
#
# Prerequisites:
#   docker compose up -d       (gitlab + runner services)
# ─────────────────────────────────────────────────────────

GITLAB_URL="${GITLAB_URL:-http://localhost:8929}"
ROOT_PAT="${ROOT_PAT:-glpat-mNRpiNXX6W6U7i9ucUTokG86MQp1OjEH.01.0w12dz3vp}"
ROOT_PASSWORD="${ROOT_PASSWORD:-SecureRoot789!}"
BOT_PAT="${BOT_PAT:-glpat-U03T2HSPKo1hDa3rxzMYQW86MQp1OjMH.01.0w1kjblyw}"

SOURCE_REPO="${1:-${SOURCE_REPO:-}}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Default: clone a small real open-source project
if [ -z "$SOURCE_REPO" ]; then
  SOURCE_REPO="https://github.com/sindresorhus/conf.git"
fi

REPO_NAME="$(basename "$SOURCE_REPO" .git)"
REPO_DIR="$PROJECT_DIR/repos/$REPO_NAME"
if [ -d "$REPO_DIR" ]; then
  echo "Repo exists at $REPO_DIR — pulling latest..."
  git -C "$REPO_DIR" pull --rebase 2>/dev/null || true
else
  echo "Cloning $SOURCE_REPO ..."
  git clone "$SOURCE_REPO" "$REPO_DIR" || {
    echo "Clone failed, seeding local test repo instead ..."
    bash "$PROJECT_DIR/scripts/seed-test-repo.sh" "$REPO_DIR"
  }
fi

GROUP_NAME="${GROUP_NAME:-dev-team}"
TEMPLATE_PROJECT="${TEMPLATE_PROJECT:-ci-templates}"

echo "=== GitLab AI Reviewer — Full Setup ==="
echo ""

# ── Wait for GitLab ──────────────────────────────────
echo "Waiting for GitLab to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "$GITLAB_URL/-/health" >/dev/null 2>&1; then
    echo "  GitLab is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ERROR: GitLab not healthy. Run 'docker compose up -d' first."
    exit 1
  fi
  sleep 5
done

# ── Helper: create or find group ─────────────────────
ensure_group() {
  local name="$1"
  local gid
  gid=$(curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
    "$GITLAB_URL/api/v4/groups?search=$name" \
    | python3 -c "import sys,json; groups=json.load(sys.stdin); print(groups[0]['id'] if groups else '')" 2>/dev/null || true)
  if [ -z "$gid" ]; then
    gid=$(curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
      --header "Content-Type: application/json" \
      --data "{\"name\": \"$name\", \"path\": \"$name\"}" \
      "$GITLAB_URL/api/v4/groups" \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
    echo "  Created group '$name' id=$gid"
  else
    echo "  Using group '$name' id=$gid"
  fi
  echo "$gid"
}

# ── Helper: create or find project ───────────────────
ensure_project() {
  local name="$1"
  local ns_id="$2"
  local pid
  pid=$(curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
    "$GITLAB_URL/api/v4/projects?search=$name" \
    | python3 -c "
import sys,json
projects=json.load(sys.stdin)
match=[p for p in projects if p.get('namespace',{}).get('id')==$ns_id]
print(match[0]['id'] if match else '')" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    pid=$(curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
      --header "Content-Type: application/json" \
      --data "{\"name\": \"$name\", \"namespace_id\": $ns_id, \"visibility\": \"public\"}" \
      "$GITLAB_URL/api/v4/projects" \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
    echo "  Created project '$name' id=$pid"
  else
    echo "  Using project '$name' id=$pid"
  fi
  echo "$pid"
}

# ── Helper: push files to a GitLab project ───────────
push_to_gitlab() {
  local dir="$1"
  local project="$2"
  local remote_name="gitlab-$(date +%s)"
  git -C "$dir" remote add "$remote_name" \
    "http://root:$ROOT_PASSWORD@${GITLAB_URL#http://}/$GROUP_NAME/$project.git" 2>/dev/null || true
  git -C "$dir" push -f "$remote_name" HEAD:main
  git -C "$dir" remote remove "$remote_name" 2>/dev/null || true
}

# ── Register Runner ─────────────────────────────────
echo ""
echo "--- Step 1: Register Runner ---"

# Wait for runner container
for i in $(seq 1 10); do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^gitlab-runner$'; then
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "  WARNING: Runner container not found. CI jobs will not execute."
    echo "  Register manually: docker exec -it gitlab-runner gitlab-runner register"
  fi
  sleep 3
done

# Check if runner is already registered via GitLab API
REGISTERED=$(curl -s --header "PRIVATE-TOKEN: $ROOT_PAT" \
  "$GITLAB_URL/api/v4/runners" 2>/dev/null \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print('yes' if r else 'no')" 2>/dev/null || echo "no")

if [ "$REGISTERED" = "no" ]; then
  echo "  Registering runner (project-runner, docker executor)..."
  # Get registration token from GitLab admin settings
  REG_TOKEN=$(curl -s --header "PRIVATE-TOKEN: $ROOT_PAT" \
    "$GITLAB_URL/api/v4/application/settings" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('runner_registration_token',''))" 2>/dev/null || true)
  if [ -z "$REG_TOKEN" ]; then
    echo "  WARNING: Could not get runner registration token from API."
    echo "  Register manually: docker exec -it gitlab-runner gitlab-runner register"
  else
    docker exec gitlab-runner gitlab-runner register \
      --non-interactive \
      --url "http://gitlab:8929" \
      --registration-token "$REG_TOKEN" \
      --executor "docker" \
      --docker-image "node:22-alpine" \
      --docker-network-mode "gitlab-ai-reviewer_gitlab-review-net" \
      --docker-volumes "/var/run/docker.sock:/var/run/docker.sock" \
      --tag-list "project-runner" \
      --description "project-runner" \
      --run-untagged="true" \
      --locked="false" 2>&1 | tail -3
    echo "  Runner registered."
  fi
else
  echo "  Runner already registered."
fi

# ── 2. CI Templates Project ──────────────────────────
echo ""
echo "--- Step 1: CI Templates ---"

GROUP_ID=$(ensure_group "$GROUP_NAME")
TEMPLATE_ID=$(ensure_project "$TEMPLATE_PROJECT" "$GROUP_ID")

# Create a temp dir with only the needed template files
TMPDIR=$(mktemp -d)
cp "$PROJECT_DIR/agent/ci-review.mjs" "$TMPDIR/"
cp "$PROJECT_DIR/agent/review-core.js" "$TMPDIR/"
cp "$PROJECT_DIR/agent/prompt.md" "$TMPDIR/"

# Create ci-template.yml
cat > "$TMPDIR/ci-template.yml" << 'YAML'
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
YAML

git init "$TMPDIR"
git -C "$TMPDIR" add -A
git -C "$TMPDIR" commit -m "Initial CI templates" --no-verify --allow-empty
push_to_gitlab "$TMPDIR" "$TEMPLATE_PROJECT"
rm -rf "$TMPDIR"
echo "  CI templates pushed."

# Configure CI variable: GITLAB_TOKEN (bot PAT for comments)
# Also configure on the template project so the CI job can use it
# (In practice, this is set per-target-project; setting it here is a convenience)
curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
  --header "Content-Type: application/json" \
  --request PUT \
  --data "{\"key\": \"GITLAB_TOKEN\", \"value\": \"$BOT_PAT\", \"protected\": false, \"masked\": true, \"environment_scope\": \"*\"}" \
  "$GITLAB_URL/api/v4/projects/$TEMPLATE_ID/variables/GITLAB_TOKEN" >/dev/null 2>&1 || true

# ── 3. Test Repo Project ──────────────────────────────
echo ""
echo "--- Step 2: Test Repo ---"

PROJECT_ID=$(ensure_project "$REPO_NAME" "$GROUP_ID")

# Ensure .gitlab-ci.yml includes the template
if [ ! -f "$REPO_DIR/.gitlab-ci.yml" ]; then
  echo 'include:
  - project: dev-team/ci-templates
    file: ci-template.yml
    ref: main' > "$REPO_DIR/.gitlab-ci.yml"
  git -C "$REPO_DIR" add .gitlab-ci.yml
  git -C "$REPO_DIR" commit -m "Add AI review CI template" --no-verify 2>/dev/null || true
fi

push_to_gitlab "$REPO_DIR" "$REPO_NAME"

# Create CI labels
curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
  --header "Content-Type: application/json" \
  --data "{\"name\": \"review/pass\", \"color\": \"#108548\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/labels" >/dev/null 2>&1 || true
curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
  --header "Content-Type: application/json" \
  --data "{\"name\": \"review/fail\", \"color\": \"#6699cc\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/labels" >/dev/null 2>&1 || true

# Configure CI variables on the test project
curl -sf --header "PRIVATE-TOKEN: $ROOT_PAT" \
  --header "Content-Type: application/json" \
  --request PUT \
  --data "{\"key\": \"GITLAB_TOKEN\", \"value\": \"$BOT_PAT\", \"protected\": false, \"masked\": true, \"environment_scope\": \"*\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/variables/GITLAB_TOKEN" >/dev/null 2>&1 || true

# Determine external URL for user-facing messages
if echo "$GITLAB_URL" | grep -q 'gitlab:8929'; then
  EXT_URL="http://localhost:8929"
else
  EXT_URL="$GITLAB_URL"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Templates:    $EXT_URL/$GROUP_NAME/$TEMPLATE_PROJECT"
echo "  Test repo:    $EXT_URL/$GROUP_NAME/$REPO_NAME"
echo "  Local clone:  $REPO_DIR"
echo ""
echo "To test the AI review:"
echo "  1. cd $REPO_DIR"
echo "  2. Create a branch and make a change:"
echo "     git checkout -b feat/my-change"
echo "  3. Commit and push to GitLab:"
echo "     git remote add gitlab http://root:SecureRoot789!@localhost:8929/$GROUP_NAME/$REPO_NAME.git"
echo "     git push -u gitlab feat/my-change"
echo "  4. Open an MR at $EXT_URL/$GROUP_NAME/$REPO_NAME"
echo "  5. Watch the AI review pipeline run"
