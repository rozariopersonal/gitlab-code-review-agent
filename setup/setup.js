import { GitLabClient } from './gitlab.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const {
  GITLAB_URL = 'http://localhost:8929',
  ROOT_PASSWORD = 'Xk9mP4vN!2zQ',
  SOURCE_REPO: SOURCE_REPO_ENV = '',
  GROUP_NAME = 'dev-team',
  TEMPLATE_PROJECT = 'ci-templates',
  CI_TEMPLATES_REF: templateRef = 'main',
  BOT_USER = 'review-bot',
  DEV_USER = 'developer1',
} = process.env;

const SOURCE_REPO = SOURCE_REPO_ENV || 'https://github.com/sindresorhus/conf.git';
const REPO_NAME = SOURCE_REPO.replace(/\.git$/, '').split('/').pop();
const REPO_DIR = join(PROJECT_DIR, 'repos', REPO_NAME);
const USER_PASSWORD = 'Password123!';

function log(msg) { console.log(`  ${msg}`); }

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, ...opts }).trim();
}

async function waitForGitLab(baseUrl) {
  process.stdout.write('Waiting for GitLab to be healthy...');
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${baseUrl}/users/sign_in`);
      if (res.ok) { console.log(' ready.'); return; }
    } catch {}
    process.stdout.write('.');
    await sleep(5000);
  }
  throw new Error('GitLab not healthy. Run "docker compose up -d" first.');
}

async function ensureUser(api, username, name, email, password) {
  let user = await api.findUser(username);
  if (user) { log(`User '${username}' exists id=${user.id}`); return user; }
  user = await api.createUser({ username, name, email, password });
  log(`Created user '${username}' id=${user.id}`);
  return user;
}

async function ensureGroup(api, name) {
  let group = await api.findGroup(name);
  if (group) { log(`Group '${name}' exists id=${group.id}`); return group; }
  group = await api.createGroup(name);
  log(`Created group '${name}' id=${group.id}`);
  return group;
}

async function ensureProject(api, name, namespaceId) {
  let project = await api.findProject(name, namespaceId);
  if (project) { log(`Project '${name}' exists id=${project.id}`); return project; }
  project = await api.createProject(name, namespaceId);
  log(`Created project '${name}' id=${project.id}`);
  return project;
}

function gitConfig() {
  try {
    sh(`git config --global user.email "setup@gitlab.local"`);
    sh(`git config --global user.name "Setup"`);
  } catch {}
}

function gitPushFromDir(sourceDir, targetUrl) {
  gitConfig();
  sh(`git -C "${sourceDir}" init -b main`);
  sh(`git -C "${sourceDir}" remote remove gl || true`);
  sh(`git -C "${sourceDir}" remote add gl "${targetUrl}"`);
  sh(`git -C "${sourceDir}" add -A`);
  sh(`git -C "${sourceDir}" commit -m "Initial commit" --no-verify --allow-empty`);
  sh(`git -C "${sourceDir}" push -f gl HEAD:main`);
}

async function registerRunner(api) {
  const runners = await api.listRunners();
  if (runners && runners.length > 0) { log('Runner already registered.'); return; }

  log('Registering runner (project-runner, docker executor)...');
  let regToken;
  try {
    regToken = sh(`docker exec gitlab-local gitlab-rails runner "
      puts Gitlab::CurrentSettings.current_application_settings.runners_registration_token
    "`);
  } catch {}
  if (!regToken) {
    log('WARNING: Could not get runner registration token via Rails, trying ApplicationSettings API...');
    regToken = await api.getRunnerRegistrationToken();
  }
  if (!regToken) {
    log('WARNING: Could not get runner registration token. Runner registration skipped.');
    log('You can register manually: docker exec -it gitlab-runner gitlab-runner register');
    return;
  }

  sh(`docker exec gitlab-runner gitlab-runner register \
    --non-interactive \
    --url "http://gitlab:8929" \
    --registration-token "${regToken}" \
    --executor "docker" \
    --docker-image "ai-review-agent:latest" \
    --docker-pull-policy "if-not-present" \
    --docker-network-mode "gitlab-ai-reviewer_gitlab-review-net" \
    --docker-volumes "/var/run/docker.sock:/var/run/docker.sock" \
    --tag-list "project-runner" \
    --description "project-runner" \
    --run-untagged="true" \
    --locked="false"`);
  log('Runner registered.');
}

async function main() {
  console.log('=== GitLab AI Reviewer — Full Setup ===\n');

  await waitForGitLab(GITLAB_URL);
  console.log('\n--- Step 0: Authenticate ---');
  const ROOT_TOKEN = process.env.ROOT_TOKEN || 'glpat-root-token-12345';
  log('Creating root PAT via Rails runner...');
  try {
    sh(`docker exec gitlab-local gitlab-rails runner "
      u = User.find_by_username('root')
      existing = PersonalAccessToken.where(user_id: u.id, name: 'setup-token').first
      existing&.destroy!
      t = PersonalAccessToken.create!(user: u, name: 'setup-token', scopes: ['api','read_api','write_repository','read_repository'], expires_at: 365.days.from_now)
      t.set_token('${ROOT_TOKEN}')
      t.save!
      puts 'PAT created: ' + t.token
    "`);
    log('Root PAT created.');
  } catch (e) {
    log('Root PAT may already exist: ' + e.message.split('\n')[0].slice(0, 120));
  }
  const api = new GitLabClient(GITLAB_URL, ROOT_TOKEN);
  log('Connected as root.');

  console.log('\n--- Step 1: Create Users ---');
  const bot = await ensureUser(api, BOT_USER, 'Review Bot', 'bot@example.com', USER_PASSWORD);
  const dev = await ensureUser(api, DEV_USER, 'Alice Developer', 'alice@example.com', USER_PASSWORD);
  const botPat = await api.ensurePat(bot.id);
  log(`review-bot PAT: ${botPat.slice(0, 10)}...`);

  console.log('\n--- Step 2: Create Group ---');
  const group = await ensureGroup(api, GROUP_NAME);
  await api.addMember(group.id, bot.id, 20);
  log(`Added ${BOT_USER} as Reporter`);
  await api.addMember(group.id, dev.id, 40);
  log(`Added ${DEV_USER} as Maintainer`);

  console.log('\n--- Step 3: Register Runner ---');
  await registerRunner(api);

  console.log('\n--- Step 4: Build Agent Docker Image ---');
  sh(`docker build -t ai-review-agent "${join(PROJECT_DIR, 'agent')}"`);
  log('Agent image built.');

  console.log('\n--- Step 5: CI Templates ---');
  const tp = await ensureProject(api, TEMPLATE_PROJECT, group.id);
  await api.unprotectBranch(tp.id);
  log('Unprotected default branch for template project.');

  const tmp = join(tmpdir(), 'ci-templates-setup');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  cpSync(join(PROJECT_DIR, 'agent', 'ci-review.ts'), join(tmp, 'ci-review.ts'));
  cpSync(join(PROJECT_DIR, 'agent', 'review-core.ts'), join(tmp, 'review-core.ts'));
  cpSync(join(PROJECT_DIR, 'agent', 'gitlab.ts'), join(tmp, 'gitlab.ts'));
  cpSync(join(PROJECT_DIR, 'agent', 'gemini.ts'), join(tmp, 'gemini.ts'));
  cpSync(join(PROJECT_DIR, 'agent', 'prompt.md'), join(tmp, 'prompt.md'));
  writeFileSync(join(tmp, 'ci-template.yml'), `
stages:
  - review

ai-review:
  stage: review
  image: ai-review-agent:latest
  script: ["echo", "ENTRYPOINT handles the review"]
  artifacts:
    when: always
    paths:
      - review-result.json
    expire_in: 30 days
  variables:
    GITLAB_URL: ${GITLAB_URL}
    CI_TEMPLATES_PROJECT: ${GROUP_NAME}/${TEMPLATE_PROJECT}
    CI_TEMPLATES_REF: ${templateRef}
  rules:
    - if: \$CI_MERGE_REQUEST_IID
`.trimStart(), 'utf-8');

  const authUrl = `http://root:${ROOT_PASSWORD}@${GITLAB_URL.replace(/^https?:\/\//, '')}`;
  gitPushFromDir(tmp, `${authUrl}/${GROUP_NAME}/${TEMPLATE_PROJECT}.git`);
  log('CI templates pushed.');
  await api.setVariable(tp.id, 'GITLAB_TOKEN', botPat);

  console.log('\n--- Step 6: Test Repo ---');
  if (existsSync(REPO_DIR)) {
    log(`Repo exists at ${REPO_DIR} — pulling latest...`);
    try { sh(`git -C "${REPO_DIR}" pull --rebase`); } catch {}
  } else {
    log(`Cloning ${SOURCE_REPO} ...`);
    try {
      sh(`git clone "${SOURCE_REPO}" "${REPO_DIR}"`);
    } catch {
      log('Clone failed, seeding local test repo instead...');
      sh(`bash "${join(PROJECT_DIR, 'setup', 'seed-test-repo.sh')}" "${REPO_DIR}"`);
    }
  }

  const testProject = await ensureProject(api, REPO_NAME, group.id);
  await api.unprotectBranch(testProject.id);
  log('Unprotected default branch for test project.');

  const ciYmlPath = join(REPO_DIR, '.gitlab-ci.yml');
  if (!existsSync(ciYmlPath)) {
    writeFileSync(ciYmlPath, `include:
  - project: ${GROUP_NAME}/${TEMPLATE_PROJECT}
    file: ci-template.yml
    ref: ${templateRef}
`, 'utf-8');
    sh(`git -C "${REPO_DIR}" add .gitlab-ci.yml`);
    sh(`git -C "${REPO_DIR}" commit -m "Add AI review CI template" --no-verify`);
  }

  sh(`git -C "${REPO_DIR}" remote add gl "${authUrl}/${GROUP_NAME}/${REPO_NAME}.git" 2>/dev/null || true`);
  sh(`git -C "${REPO_DIR}" push -f gl HEAD:main`);

  await api.createLabel(testProject.id, 'review/pass', '#108548');
  await api.createLabel(testProject.id, 'review/fail', '#6699cc');
  await api.setVariable(testProject.id, 'GITLAB_TOKEN', botPat);

  console.log('\n=== Setup Complete ===\n');
  console.log(`  Users:        ${BOT_USER} (Reporter), ${DEV_USER} (Maintainer)`);
  console.log(`  Group:        ${GROUP_NAME}`);
  console.log(`  Templates:    http://localhost:8929/${GROUP_NAME}/${TEMPLATE_PROJECT}`);
  console.log(`  Test repo:    http://localhost:8929/${GROUP_NAME}/${REPO_NAME}`);
  console.log(`  Local clone:  ${REPO_DIR}\n`);
  console.log('To test the AI review:');
  console.log(`  1. cd ${REPO_DIR}`);
  console.log('  2. git checkout -b feat/my-change');
  console.log('  3. git add -A && git commit -m "Make a change"');
  console.log(`  4. git remote add gl http://root:${ROOT_PASSWORD}@localhost:8929/${GROUP_NAME}/${REPO_NAME}.git`);
  console.log('     git push -u gl feat/my-change');
  console.log(`  5. Open MR at http://localhost:8929/${GROUP_NAME}/${REPO_NAME}`);
  console.log('  6. Watch the AI review pipeline run');
}

main().catch(err => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
