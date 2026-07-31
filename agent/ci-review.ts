#!/usr/bin/env node

/**
 * @file GitLab AI Code Review — CI Pipeline Entry Point
 *
 * Runs inside a GitLab CI job to review merge requests using Google Gemini.
 * Fetches the MR diff, full file context, spec requirements, and project rules,
 * sends them to Gemini with a structured prompt, posts inline comments, and
 * exits with code 1 if issues are found (blocking the merge).
 *
 * Environment Variables:
 *   CI_PROJECT_ID        — GitLab project ID (set by GitLab CI)
 *   CI_MERGE_REQUEST_IID — MR internal ID (set by GitLab CI)
 *   GITLAB_TOKEN         — GitLab PAT with Reporter scope for API calls
 *   GEMINI_API_KEY       — Google Gemini API key
 *   GITLAB_URL           — GitLab instance URL (default: http://gitlab:8929)
 */

import { readFileSync, writeFileSync } from 'fs';
import { createApi, type AgentConfig, type DiscussionPosition } from './gitlab.js';
import { callGemini } from './gemini.js';
import {
  buildSpecContext,
  buildSpecExtra,
  fixJSONNewlines,
  formatDiffWithLineNumbers,
  getDiffLineNumbers,
  getLinePosition,
  parseSpec,
  type SpecResult,
} from './review-core.js';

interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

interface MergeRequest {
  description: string;
  source_branch: string;
  diff_refs: DiffRefs;
}

interface DiffFile {
  path: string;
  status: 'added' | 'removed' | 'renamed' | 'modified';
  patch: string;
}

interface Comment {
  path: string;
  line: number;
  note: string;
}

interface AnalysisResult {
  approved: boolean;
  summary: string;
  comments: Comment[];
  specResults?: SpecResult[];
}

// ── Config ────────────────────────────────────────────────────────────────

function loadConfig(): AgentConfig {
  const config = {
    gitlabUrl: process.env.GITLAB_URL || process.env.CI_SERVER_URL || 'http://gitlab:8929',
    projectId: process.env.CI_PROJECT_ID || '',
    mrIid: process.env.CI_MERGE_REQUEST_IID || '',
    gitlabToken: process.env.GITLAB_TOKEN || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    templatesProject: process.env.CI_TEMPLATES_PROJECT || 'dev-team/ci-templates',
    templatesRef: process.env.CI_TEMPLATES_REF || 'main',
  };

  const required = { projectId: 'CI_PROJECT_ID', mrIid: 'CI_MERGE_REQUEST_IID', gitlabToken: 'GITLAB_TOKEN', geminiApiKey: 'GEMINI_API_KEY' };
  const missing = Object.keys(required).filter(k => !config[k as keyof typeof required]);
  if (missing.length > 0) {
    console.error(`Missing CI env vars: ${missing.map(k => required[k as keyof typeof required]).join(', ')}`);
    process.exit(1);
  }
  return config;
}

function loadPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const promptPath = new URL('./prompt.md', import.meta.url);
  return readFileSync(promptPath, 'utf-8').replace('{{DATE}}', today);
}

// ── Data collection ───────────────────────────────────────────────────────

function mapDiffFile(d: Record<string, unknown>): DiffFile {
  const path = (d.new_path as string) || (d.old_path as string);
  return {
    path,
    status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
    patch: d.diff as string,
  };
}

async function fetchChangedFiles(api: ReturnType<typeof createApi>): Promise<DiffFile[]> {
  const res = await api.getDiff();
  const diffData = (await res.json()) as Record<string, unknown>[];
  return diffData.map(mapDiffFile).filter(f => f.patch);
}

async function collectSpecs(api: ReturnType<typeof createApi>, mr: MergeRequest): Promise<string[]> {
  let specs = parseSpec(mr.description || '');
  if (specs.length > 0) {
    console.log(`[CI Review] Found ${specs.length} spec requirements (MR description)`);
  }

  const rulesRes = await api.getFile('.review-rules.md', mr.source_branch);
  if (rulesRes.ok) {
    const rules = parseSpec(await rulesRes.text());
    if (rules.length > 0) {
      console.log(`[CI Review] Found ${rules.length} project rules from .review-rules.md`);
      specs = specs.concat(rules.map(r => `[Project Rule] ${r}`));
    }
  }
  return specs;
}

async function buildContext(api: ReturnType<typeof createApi>, files: DiffFile[], mr: MergeRequest, specs: string[]): Promise<string> {
  const fileContexts = await Promise.all(
    files
      .filter(f => f.status !== 'removed')
      .map(async (f): Promise<string | null> => {
        const res = await api.getFile(f.path, mr.source_branch);
        if (!res.ok) return null;
        return `### ${f.path} (full file)\n\n\`\`\`\n${await res.text()}\n\`\`\``;
      }),
  );

  const contexts = fileContexts.filter((c): c is string => Boolean(c));
  const diffContent = files.map(f =>
    `### ${f.path} (diff)\n\n\`\`\`diff\n${formatDiffWithLineNumbers(f.patch)}\n\`\`\``,
  ).join('\n\n');

  let context = contexts.length > 0
    ? `## Full files (for context)\n\n${contexts.join('\n\n')}\n\n## Changes in this MR\n\n${diffContent}`
    : diffContent;

  if (specs.length > 0) {
    context = buildSpecContext(specs) + context;
  }
  return context;
}

// ── AI analysis ───────────────────────────────────────────────────────────

async function analyze(prompt: string, context: string, config: AgentConfig): Promise<AnalysisResult> {
  const rawJson = await callGemini(config.geminiApiKey, prompt + '\n\n' + context);
  const sanitized = fixJSONNewlines(rawJson);

  let result: AnalysisResult;
  try {
    result = JSON.parse(sanitized) as AnalysisResult;
  } catch (e) {
    throw new Error('JSON parse error: ' + (e as Error).message + '\nRaw: ' + sanitized.slice(0, 500));
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
  return result;
}

// ── Posting results ───────────────────────────────────────────────────────

async function postSummaryNote(api: ReturnType<typeof createApi>, result: AnalysisResult): Promise<void> {
  const header = result.approved ? '### AI Review: Looks good' : '### AI Review: Issues found';
  const extra = buildSpecExtra(result.specResults);
  await api.postNote(`${header}\n\n${result.summary}${extra}`);
}

function getValidPositions(files: DiffFile[]): Set<string> {
  const positions = new Set<string>();
  for (const f of files) {
    for (const ln of getDiffLineNumbers(f.patch)) {
      positions.add(`${f.path}:${ln}`);
    }
  }
  return positions;
}

async function loadExistingPositions(api: ReturnType<typeof createApi>, validPositions: Set<string>): Promise<Set<string>> {
  const res = await api.getDiscussions();
  const existing = new Set<string>();
  if (!res.ok) return existing;

  const discs = (await res.json()) as { notes?: { position?: { new_path?: string; new_line?: number } }[] }[];
  for (const d of discs) {
    const pos = d.notes?.[0]?.position;
    if (pos?.new_path && pos?.new_line) {
      const key = `${pos.new_path}:${pos.new_line}`;
      if (validPositions.has(key)) existing.add(key);
    }
  }
  return existing;
}

function buildPosition(comment: Comment, file: DiffFile | undefined, diffRefs: DiffRefs): DiscussionPosition {
  const isAdded = file?.status === 'added';
  const linePos = isAdded ? {} : getLinePosition(file?.patch, comment.line);

  const position: DiscussionPosition = {
    position_type: 'text',
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    new_path: comment.path,
    new_line: comment.line,
  };
  if (linePos.old_line !== undefined) {
    position.old_path = comment.path;
    position.old_line = linePos.old_line;
  }
  return position;
}

async function postInlineComments(api: ReturnType<typeof createApi>, files: DiffFile[], diffRefs: DiffRefs, comments: Comment[], existingPositions: Set<string>): Promise<void> {
  const seen = new Set<string>();
  for (const comment of comments) {
    const key = `${comment.path}:${comment.line}`;
    if (seen.has(key) || existingPositions.has(key)) continue;
    seen.add(key);

    const file = files.find(f => f.path === comment.path);
    const position = buildPosition(comment, file, diffRefs);

    const res = await api.postDiscussion(comment.note, position);
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 100);
      console.error(`[CI Review] Failed to post on ${comment.path}:${comment.line}: ${errText}`);
    } else {
      console.log(`[CI Review] Posted on ${comment.path}:${comment.line}`);
    }
  }
}

// ── Output ────────────────────────────────────────────────────────────────

function saveArtifact(config: AgentConfig, result: AnalysisResult): void {
  const artifact = {
    approved: result.approved,
    summary: result.summary,
    issues: result.comments.length,
    specResults: result.specResults || [],
    timestamp: new Date().toISOString(),
    mr: `!${config.mrIid}`,
    project: config.projectId,
  };
  writeFileSync('review-result.json', JSON.stringify(artifact, null, 2));
  console.log('[CI Review] Artifact saved to review-result.json');
}

function applyQualityGate(result: AnalysisResult): void {
  if (!result.approved) {
    console.log('[CI Review] Quality gate FAILED — issues found');
    process.exit(1);
  }
  console.log('[CI Review] Quality gate passed');
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const api = createApi(config);
  const prompt = loadPrompt();

  console.log(`[CI Review] MR !${config.mrIid} in project ${config.projectId}`);

  const mrRes = await api.getMr();
  const mr = (await mrRes.json()) as MergeRequest;
  console.log(`[CI Review] Diff refs: ${mr.diff_refs.base_sha.slice(0, 8)}..${mr.diff_refs.head_sha.slice(0, 8)}`);

  const specs = await collectSpecs(api, mr);
  const files = await fetchChangedFiles(api);

  if (files.length === 0) {
    console.log('[CI Review] No diff changes to review');
    process.exit(0);
  }

  const context = await buildContext(api, files, mr, specs);
  console.log(`[CI Review] Sending ${context.length} chars to Gemini`);

  const result = await analyze(prompt, context, config);
  await postSummaryNote(api, result);

  const validPositions = getValidPositions(files);
  console.log(`[CI Review] Valid positions in diff: ${validPositions.size}`);

  const existingPositions = await loadExistingPositions(api, validPositions);
  console.log(`[CI Review] Existing positions (still in diff): ${existingPositions.size}`);

  await postInlineComments(api, files, mr.diff_refs, result.comments, existingPositions);

  saveArtifact(config, result);
  applyQualityGate(result);
}

main().catch(e => {
  console.error('[CI Review] Fatal:', (e as Error).message);
  process.exit(1);
});
