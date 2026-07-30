#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const GITLAB_URL = process.env.GITLAB_URL || process.env.CI_SERVER_URL || 'http://gitlab:8929';
const PROJECT_ID = process.env.CI_PROJECT_ID;
const MR_IID = process.env.CI_MERGE_REQUEST_IID;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!PROJECT_ID || !MR_IID || !GITLAB_TOKEN || !GEMINI_API_KEY) {
  console.error('Missing CI env vars: CI_PROJECT_ID, CI_MERGE_REQUEST_IID, GITLAB_TOKEN, GEMINI_API_KEY');
  process.exit(1);
}

const API = `${GITLAB_URL}/api/v4`;
const headers = { 'PRIVATE-TOKEN': GITLAB_TOKEN, 'Content-Type': 'application/json' };

async function fetchCore() {
  const rawUrl = `${GITLAB_URL}/dev-team/ci-templates/-/raw/main/review-core.js`;
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`Failed to fetch review-core.js (${res.status})`);
  const content = await res.text();
  const tmpFile = path.join(tmpdir(), `review-core-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, content);
  return await import(tmpFile);
}

async function fetchPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const rawUrl = `${GITLAB_URL}/dev-team/ci-templates/-/raw/main/prompt.md`;
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`Failed to fetch prompt (${res.status}) from ${rawUrl}`);
  let prompt = await res.text();
  prompt = prompt.replace('{{DATE}}', today);
  return prompt;
}

async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  );
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response: ' + JSON.stringify(data).slice(0, 200));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in Gemini response: ' + text.slice(0, 300));
  return m[0];
}

async function main() {
  console.log(`[CI Review] MR !${MR_IID} in project ${PROJECT_ID}`);

  const core = await fetchCore();

  // 1. Fetch MR info
  const mrRes = await fetch(`${API}/projects/${PROJECT_ID}/merge_requests/${MR_IID}`, { headers });
  const mr = await mrRes.json();
  const diffRefs = mr.diff_refs;
  const sourceBranch = mr.source_branch;
  console.log(`[CI Review] Diff refs: ${diffRefs.base_sha.slice(0, 8)}..${diffRefs.head_sha.slice(0, 8)}`);

  // Parse spec requirements from MR description
  let specs = core.parseSpec(mr.description || '');
  if (specs.length > 0) {
    console.log(`[CI Review] Found ${specs.length} spec requirements (MR description)`);
  }

  // Fetch project default rules from .review-rules.md
  const rulesPath = encodeURIComponent('.review-rules.md');
  const rulesRes = await fetch(
    `${API}/projects/${PROJECT_ID}/repository/files/${rulesPath}/raw?ref=${encodeURIComponent(sourceBranch)}`,
    { headers }
  );
  if (rulesRes.ok) {
    const rulesContent = await rulesRes.text();
    const rules = core.parseSpec(rulesContent);
    if (rules.length > 0) {
      console.log(`[CI Review] Found ${rules.length} project rules from .review-rules.md`);
      specs = specs.concat(rules.map(r => `[Project Rule] ${r}`));
    }
  }

  // 2. Fetch diff
  const diffRes = await fetch(`${API}/projects/${PROJECT_ID}/merge_requests/${MR_IID}/diffs`, { headers });
  const diffData = await diffRes.json();
  const files = diffData.map(d => ({
    path: d.new_path || d.old_path,
    status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
    patch: d.diff,
  })).filter(f => f.patch);

  if (files.length === 0) {
    console.log('[CI Review] No diff changes to review');
    process.exit(0);
  }

  // 3. Fetch full file content from source branch for context
  const fileContexts = [];
  for (const f of files) {
    if (f.status === 'removed') continue;
    const encodedPath = encodeURIComponent(f.path);
    const fileRes = await fetch(`${API}/projects/${PROJECT_ID}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(sourceBranch)}`, { headers });
    if (fileRes.ok) {
      const content = await fileRes.text();
      fileContexts.push(`### ${f.path} (full file)\n\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  const diffContent = files.map(f =>
    `### ${f.path} (diff)\n\n\`\`\`diff\n${core.formatDiffWithLineNumbers(f.patch)}\n\`\`\``
  ).join('\n\n');

  let fullContext = fileContexts.length > 0
    ? `## Full files (for context)\n\n${fileContexts.join('\n\n')}\n\n## Changes in this MR\n\n${diffContent}`
    : diffContent;

  if (specs.length > 0) {
    fullContext = core.buildSpecContext(specs) + fullContext;
  }

  console.log(`[CI Review] Sending ${fullContext.length} chars to Gemini`);

  // 4. Fetch prompt and call Gemini
  const prompt = await fetchPrompt();
  const rawJson = await callGemini(prompt + '\n\n' + fullContext);
  const sanitized = core.fixJSONNewlines(rawJson);
  let result;
  try {
    result = JSON.parse(sanitized);
  } catch (e) {
    throw new Error('JSON parse error: ' + e.message + '\nRaw: ' + sanitized.slice(0, 500));
  }

  console.log(`[CI Review] Approved: ${result.approved}, Issues: ${result.comments.length}`);
  if (result.comments.length > 0) {
    console.log('[CI Review] Comments:', JSON.stringify(result.comments));
  }

  if (result.specResults) {
    const passed = result.specResults.filter(s => s.satisfied).length;
    const failed = result.specResults.filter(s => !s.satisfied).length;
    console.log(`[CI Review] Spec results: ${passed} passed, ${failed} failed`);
  }

  // 5. Post summary note with spec compliance
  const header = result.approved ? '### AI Review: Looks good' : '### AI Review: Issues found';
  const extra = core.buildSpecExtra(result.specResults);
  await fetch(`${API}/projects/${PROJECT_ID}/merge_requests/${MR_IID}/notes`, {
    method: 'POST', headers, body: JSON.stringify({ body: `${header}\n\n${result.summary}${extra}` }),
  });

  // 6. Build valid line ranges from current diff
  const validPositions = new Set();
  for (const f of files) {
    for (const ln of core.getDiffLineNumbers(f.patch)) {
      validPositions.add(`${f.path}:${ln}`);
    }
  }
  console.log(`[CI Review] Valid positions in diff: ${validPositions.size}`);

  // 7. Fetch existing discussions, filter to only those still in current diff
  const existingDiscs = await fetch(
    `${API}/projects/${PROJECT_ID}/merge_requests/${MR_IID}/discussions`, { headers }
  );
  const existingPositions = new Set();
  if (existingDiscs.ok) {
    const discs = await existingDiscs.json();
    for (const d of discs) {
      const note = d.notes?.[0];
      const pos = note?.position;
      if (pos?.new_path && pos?.new_line) {
        const key = `${pos.new_path}:${pos.new_line}`;
        if (validPositions.has(key)) {
          existingPositions.add(key);
        }
      }
    }
  }
  console.log(`[CI Review] Existing positions (still in diff): ${existingPositions.size}`);

  // 8. Post inline comments (skip if already present)
  const seen = new Set();
  for (const comment of result.comments) {
    const key = `${comment.path}:${comment.line}`;
    if (seen.has(key) || existingPositions.has(key)) continue;
    seen.add(key);

    const file = files.find(f => f.path === comment.path);
    const isAdded = file?.status === 'added';
    const linePos = isAdded ? {} : core.getLinePosition(file?.patch, comment.line);

    const position = {
      position_type: 'text',
      base_sha: diffRefs.base_sha, start_sha: diffRefs.start_sha, head_sha: diffRefs.head_sha,
      new_path: comment.path, new_line: comment.line,
    };
    if (linePos.old_line !== undefined) {
      position.old_path = comment.path;
      position.old_line = linePos.old_line;
    }

    const body = comment.note;
    const discRes = await fetch(
      `${API}/projects/${PROJECT_ID}/merge_requests/${MR_IID}/discussions`,
      { method: 'POST', headers, body: JSON.stringify({ body, position }) }
    );
    if (!discRes.ok) {
      const errText = (await discRes.text()).slice(0, 100);
      console.error(`[CI Review] Failed to post on ${comment.path}:${comment.line}: ${errText}`);
    } else {
      console.log(`[CI Review] Posted on ${comment.path}:${comment.line}`);
    }
  }

  // 9. Save review artifact
  const artifactPath = 'review-result.json';
  const artifact = {
    approved: result.approved,
    summary: result.summary,
    issues: result.comments.length,
    specResults: result.specResults || [],
    timestamp: new Date().toISOString(),
    mr: `!${MR_IID}`,
    project: PROJECT_ID,
  };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`[CI Review] Artifact saved to ${artifactPath}`);

  // 10. Quality gate
  if (!result.approved) {
    console.log('[CI Review] Quality gate FAILED — issues found');
    process.exit(1);
  }
  console.log('[CI Review] Quality gate passed');
}

main().catch(e => {
  console.error('[CI Review] Fatal:', e.message);
  process.exit(1);
});
