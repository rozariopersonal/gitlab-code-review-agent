#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# GitLab AI Reviewer — Full Environment Setup
#
# Creates everything from scratch on a fresh GitLab instance:
#   1. Users: review-bot (Reporter), developer1 (Maintainer)
#   2. Group: dev-team
#   3. CI templates project (dev-team/ci-templates)
#   4. Clones/pushes a test repo for MR review testing
#   5. Registers the GitLab Runner
#
# Usage:
#   ./setup/setup.sh [github-repo-url]
#
# Default test repo: https://github.com/sindresorhus/conf.git (247 KB)
#
# Prerequisites:
#   docker compose up -d       (gitlab + runner services)
# ─────────────────────────────────────────────────────────

GITLAB_URL="${GITLAB_URL:-http://localhost:8929}"
ROOT_PASSWORD="${ROOT_PASSWORD:-SecureRoot789!}"

SOURCE_REPO="${1:-${SOURCE_REPO:-}}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Default: clone a small real open-source project
if [ -z "$SOURCE_REPO" ]; then
  SOURCE_REPO="https://github.com/sindresorhus/conf.git"
fi

REPO_NAME="$(basename "$SOURCE_REPO" .git)"
REPO_DIR="$PROJECT_DIR/repos/$REPO_NAME"

GROUP_NAME="${GROUP_NAME:-dev-team}"
TEMPLATE_PROJECT="${TEMPLATE_PROJECT:-ci-templates}"

BOT_USER="${BOT_USER:-review-bot}"
BOT_NAME="${BOT_NAME:-Review Bot}"
BOT_EMAIL="${BOT_EMAIL:-bot@example.com}"
BOT_PASSWORD="${BOT_PASSWORD:-Password123!}"

DEV_USER="${DEV_USER:-developer1}"
DEV_NAME="${DEV_NAME:-Alice Developer}"
DEV_EMAIL="${DEV_EMAIL:-alice@example.com}"
DEV_PASSWORD="${DEV_PASSWORD:-Password123!}"

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

# ── Authenticate as root and get a session token ──────
echo ""
echo "--- Step 0: Authenticate ---"

ROOT_TOKEN=$(curl -sf --request POST "$GITLAB_URL/api/v4/session" \
  --data "login=root&password=$ROOT_PASSWORD" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('private_token',''))" 2>/dev/null || true)

if [ -z "$ROOT_TOKEN" ]; then
  echo "  ERROR: Failed to authenticate as root. Check ROOT_PASSWORD."
  exit 1
fi
echo "  Root session token obtained."

API="$GITLAB_URL/api/v4"
AUTH="PRIVATE-TOKEN: $ROOT_TOKEN"

# ── Ensure a root PAT exists for CI variable usage ────
ensure_pat() {
  local uid="$1"
  local name="$2"
  local pat
  pat=$(curl -sf --header "$AUTH" "$GITLAB_URL/api/v4/users/$uid/personal_access_tokens" 2>/dev/null \
    | python3 -c "import sys,json; tokens=json.load(sys.stdin); print(tokens[0]['token'] if tokens else '')" 2>/dev/null || true)
  if [ -z "$pat" ]; then
    pat=$(curl -sf --request POST --header "$AUTH" \
      --header "Content-Type: application/json" \
      --data "{\"name\": \"$name\", \"scopes\": [\"api\"], \"expires_at\": \"$(date -d '+1 year' +%Y-%m-%d)\"}" \
      "$GITLAB_URL/api/v4/users/$uid/personal_access_tokens" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)
  fi
  echo "$pat"
}

# ── Create users ──────────────────────────────────────
echo ""
echo "--- Step 1: Create Users ---"

create_user() {
  local username="$1" name="$2" email="$3" password="$4"
  local uid
  uid=$(curl -sf --header "$AUTH" "$GITLAB_URL/api/v4/users?username=$username" \
    | python3 -c "import sys,json; u=json.load(sys.stdin); print(u[0]['id'] if u else '')" 2>/dev/null || true)
  if [ -z "$uid" ]; then
    uid=$(curl -sf --request POST --header "$AUTH" \
      --header "Content-Type: application/json" \
      --data "{\"username\": \"$username\", \"name\": \"$name\", \"email\": \"$email\", \"password\": \"$password\", \"skip_confirmation\": true}" \
      "$GITLAB_URL/api/v4/users" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
    echo "  Created user '$username' id=$uid"
  else
    echo "  User '$username' exists id=$uid"
  fi
  echo "$uid"
}

BOT_UID=$(create_user "$BOT_USER" "$BOT_NAME" "$BOT_EMAIL" "$BOT_PASSWORD")
DEV_UID=$(create_user "$DEV_USER" "$DEV_NAME" "$DEV_EMAIL" "$DEV_PASSWORD")

BOT_PAT=$(ensure_pat "$BOT_UID" "ci-review-bot")
echo "  review-bot PAT: ${BOT_PAT:0:10}..."

# ── Create group ──────────────────────────────────────
echo ""
echo "--- Step 2: Create Group ---"

GROUP_ID=$(curl -sf --header "$AUTH" "$GITLAB_URL/api/v4/groups?search=$GROUP_NAME" \
  | python3 -c "import sys,json; groups=json.load(sys.stdin); print(groups[0]['id'] if groups else '')" 2>/dev/null || true)
if [ -z "$GROUP_ID" ]; then
  GROUP_ID=$(curl -sf --request POST --header "$AUTH" \
    --header "Content-Type: application/json" \
    --data "{\"name\": \"$GROUP_NAME\", \"path\": \"$GROUP_NAME\"}" \
    "$GITLAB_URL/api/v4/groups" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  echo "  Created group '$GROUP_NAME' id=$GROUP_ID"
else
  echo "  Group '$GROUP_NAME' exists id=$GROUP_ID"
fi

# Add users to group with appropriate roles
curl -sf --request POST --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"user_id\": $BOT_UID, \"access_level\": 20}" \
  "$GITLAB_URL/api/v4/groups/$GROUP_ID/members" >/dev/null 2>&1 || true
echo "  Added $BOT_USER as Reporter"

curl -sf --request POST --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"user_id\": $DEV_UID, \"access_level\": 40}" \
  "$GITLAB_URL/api/v4/groups/$GROUP_ID/members" >/dev/null 2>&1 || true
echo "  Added $DEV_USER as Maintainer"

# ── Register Runner ─────────────────────────────────
echo ""
echo "--- Step 3: Register Runner ---"

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

REGISTERED=$(curl -s --header "$AUTH" "$GITLAB_URL/api/v4/runners" 2>/dev/null \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print('yes' if r else 'no')" 2>/dev/null || echo "no")

if [ "$REGISTERED" = "no" ]; then
  echo "  Registering runner (project-runner, docker executor)..."
  REG_TOKEN=$(curl -s --header "$AUTH" "$GITLAB_URL/api/v4/application/settings" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('runner_registration_token',''))" 2>/dev/null || true)
  if [ -z "$REG_TOKEN" ]; then
    echo "  WARNING: Could not get runner registration token."
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

# ── CI Templates Project ─────────────────────────────
echo ""
echo "--- Step 4: CI Templates ---"

TEMPLATE_ID=$(curl -sf --header "$AUTH" "$GITLAB_URL/api/v4/projects?search=$TEMPLATE_PROJECT" \
  | python3 -c "
import sys,json
projects=json.load(sys.stdin)
match=[p for p in projects if p.get('namespace',{}).get('id')==$GROUP_ID]
print(match[0]['id'] if match else '')" 2>/dev/null || true)

if [ -z "$TEMPLATE_ID" ]; then
  TEMPLATE_ID=$(curl -sf --request POST --header "$AUTH" \
    --header "Content-Type: application/json" \
    --data "{\"name\": \"$TEMPLATE_PROJECT\", \"namespace_id\": $GROUP_ID, \"visibility\": \"public\"}" \
    "$GITLAB_URL/api/v4/projects" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  echo "  Created project '$TEMPLATE_PROJECT' id=$TEMPLATE_ID"
else
  echo "  Using project '$TEMPLATE_PROJECT' id=$TEMPLATE_ID"
fi

TMPDIR=$(mktemp -d)
cp "$PROJECT_DIR/agent/ci-review.mjs" "$TMPDIR/"
cp "$PROJECT_DIR/agent/review-core.js" "$TMPDIR/"
cp "$PROJECT_DIR/agent/prompt.md" "$TMPDIR/"

cat > "$TMPDIR/ci-template.yml" << YAML
stages:
  - review

ai-review:
  stage: review
  image: node:22-alpine
  before_script:
    - apk add --no-cache curl
    - curl -sO ${GITLAB_URL}/${GROUP_NAME}/${TEMPLATE_PROJECT}/-/raw/${CI_TEMPLATES_REF:-main}/ci-review.mjs
  script:
    - node ci-review.mjs
  artifacts:
    when: always
    paths:
      - review-result.json
    expire_in: 30 days
  variables:
    NODE_ENV: production
    GITLAB_URL: ${GITLAB_URL}
    CI_TEMPLATES_PROJECT: ${GROUP_NAME}/${TEMPLATE_PROJECT}
    CI_TEMPLATES_REF: ${CI_TEMPLATES_REF:-main}
  rules:
    - if: \$CI_MERGE_REQUEST_IID
YAML

git init "$TMPDIR"
git -C "$TMPDIR" add -A
git -C "$TMPDIR" commit -m "Initial CI templates" --no-verify --allow-empty
git -C "$TMPDIR" remote add gl "http://root:$ROOT_PASSWORD@${GITLAB_URL#http://}/$GROUP_NAME/$TEMPLATE_PROJECT.git"
git -C "$TMPDIR" push -f gl HEAD:main
rm -rf "$TMPDIR"
echo "  CI templates pushed."

# Set CI variables on templates project
curl -sf --request PUT --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"key\": \"GITLAB_TOKEN\", \"value\": \"$BOT_PAT\", \"protected\": false, \"masked\": true, \"environment_scope\": \"*\"}" \
  "$GITLAB_URL/api/v4/projects/$TEMPLATE_ID/variables/GITLAB_TOKEN" >/dev/null 2>&1 || true

# ── Test Repo Project ────────────────────────────────
echo ""
echo "--- Step 5: Test Repo ---"

if [ -d "$REPO_DIR" ]; then
  echo "Repo exists at $REPO_DIR — pulling latest..."
  git -C "$REPO_DIR" pull --rebase 2>/dev/null || true
else
  echo "Cloning $SOURCE_REPO ..."
  git clone "$SOURCE_REPO" "$REPO_DIR" || {
    echo "Clone failed, seeding local test repo instead ..."
    bash "$PROJECT_DIR/setup/seed-test-repo.sh" "$REPO_DIR"
  }
fi

PROJECT_ID=$(curl -sf --header "$AUTH" "$GITLAB_URL/api/v4/projects?search=$REPO_NAME" \
  | python3 -c "
import sys,json
projects=json.load(sys.stdin)
match=[p for p in projects if p.get('namespace',{}).get('id')==$GROUP_ID]
print(match[0]['id'] if match else '')" 2>/dev/null || true)

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(curl -sf --request POST --header "$AUTH" \
    --header "Content-Type: application/json" \
    --data "{\"name\": \"$REPO_NAME\", \"namespace_id\": $GROUP_ID, \"visibility\": \"public\"}" \
    "$GITLAB_URL/api/v4/projects" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
fi

if [ ! -f "$REPO_DIR/.gitlab-ci.yml" ]; then
  cat > "$REPO_DIR/.gitlab-ci.yml" << EOF
include:
  - project: ${GROUP_NAME}/${TEMPLATE_PROJECT}
    file: ci-template.yml
    ref: ${CI_TEMPLATES_REF:-main}
EOF
  git -C "$REPO_DIR" add .gitlab-ci.yml
  git -C "$REPO_DIR" commit -m "Add AI review CI template" --no-verify 2>/dev/null || true
fi

git -C "$REPO_DIR" remote add gl "http://root:$ROOT_PASSWORD@${GITLAB_URL#http://}/$GROUP_NAME/$REPO_NAME.git" 2>/dev/null || true
git -C "$REPO_DIR" push -f gl HEAD:main

# Create CI labels
curl -sf --request POST --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"name\": \"review/pass\", \"color\": \"#108548\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/labels" >/dev/null 2>&1 || true
curl -sf --request POST --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"name\": \"review/fail\", \"color\": \"#6699cc\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/labels" >/dev/null 2>&1 || true

# Set CI variables on test project
curl -sf --request PUT --header "$AUTH" \
  --header "Content-Type: application/json" \
  --data "{\"key\": \"GITLAB_TOKEN\", \"value\": \"$BOT_PAT\", \"protected\": false, \"masked\": true, \"environment_scope\": \"*\"}" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/variables/GITLAB_TOKEN" >/dev/null 2>&1 || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Users:        $BOT_USER (Reporter), $DEV_USER (Maintainer)"
echo "  Group:        $GROUP_NAME"
echo "  Templates:    http://localhost:8929/$GROUP_NAME/$TEMPLATE_PROJECT"
echo "  Test repo:    http://localhost:8929/$GROUP_NAME/$REPO_NAME"
echo "  Local clone:  $REPO_DIR"
echo ""
echo "To test the AI review:"
echo "  1. cd $REPO_DIR"
echo "  2. git checkout -b feat/my-change"
echo "  3. git add -A && git commit -m 'Make a change'"
echo "  4. git remote add gl http://root:$ROOT_PASSWORD@localhost:8929/$GROUP_NAME/$REPO_NAME.git"
echo "     git push -u gl feat/my-change"
echo "  5. Open MR at http://localhost:8929/$GROUP_NAME/$REPO_NAME"
echo "  6. Watch the AI review pipeline run"
