import { GitLabClient } from './gitlab';
import { AIProvider } from './ai/provider';
import { GeminiProvider } from './ai/gemini';
import { MergeRequestEvent, ReviewResult, AIProviderConfig, ChangedFile, SpecItem } from './types';

const core = require('../../review-core.js');

export interface ReviewerConfig {
  gitlab: {
    url: string;
    token: string;
  };
  ai: AIProviderConfig;
  aiProvider?: AIProvider;
}

export async function reviewMergeRequest(
  event: MergeRequestEvent,
  config: ReviewerConfig
): Promise<ReviewResult> {
  const gitlab = new GitLabClient(config.gitlab);
  const provider = config.aiProvider || new GeminiProvider();

  const projectId = event.project.id;
  const mrIid = event.object_attributes.iid;

  console.log(`[Reviewer] Processing MR !${mrIid} in project ${event.project.path_with_namespace}`);

  const diff = await gitlab.getMergeRequestDiff(projectId, mrIid);

  if (diff.files.length === 0) {
    return { summary: 'No diff changes to review', comments: [], approved: true };
  }

  // Fetch full file content from source branch for context
  const sourceBranch = event.object_attributes.source_branch;
  const fileContexts: string[] = [];
  for (const f of diff.files) {
    if (!f.patch || f.status === 'removed') continue;
    const content = await gitlab.getFileContent(projectId, f.path, sourceBranch);
    if (content) {
      fileContexts.push(`### ${f.path} (full file)\n\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  const diffContent = diff.files
    .filter((f) => f.patch)
    .map((f) => `### ${f.path} (diff)\n\n\`\`\`diff\n${core.formatDiffWithLineNumbers(f.patch!)}\n\`\`\``)
    .join('\n\n');

  let specs = core.parseSpec(event.object_attributes.description || '');

  const defaultRules = await gitlab.getFileContent(projectId, '.review-rules.md', sourceBranch);
  if (defaultRules) {
    const rules: string[] = core.parseSpec(defaultRules);
    if (rules.length > 0) {
      console.log(`[Reviewer] Found ${rules.length} project rules from .review-rules.md`);
      specs = specs.concat(rules.map(r => `[Project Rule] ${r}`));
    }
  }

  let fullContext = fileContexts.length > 0
    ? `## Full files (for context)\n\n${fileContexts.join('\n\n')}\n\n## Changes in this MR\n\n${diffContent}`
    : diffContent;

  if (specs.length > 0) {
    fullContext = core.buildSpecContext(specs) + fullContext;
  }

  if (!diffContent.trim()) {
    return { summary: 'No text content to review', comments: [], approved: true };
  }

  console.log(`[Reviewer] Sending diff (${fullContext.length} chars) to ${provider.name}`);

  const result = await provider.reviewCode(fullContext, config.ai);

  if (result.specResults) {
    const passed = result.specResults.filter(s => s.satisfied).length;
    const failed = result.specResults.filter(s => !s.satisfied).length;
    console.log(`[Reviewer] Spec results: ${passed} passed, ${failed} failed`);
  }

  console.log(`[Reviewer] Review complete. Approved: ${result.approved}. Issues: ${result.comments.length}`);

  return result;
}

export async function postReview(
  event: MergeRequestEvent,
  result: ReviewResult,
  config: ReviewerConfig
): Promise<void> {
  const gitlab = new GitLabClient(config.gitlab);
  const projectId = event.project.id;
  const mrIid = event.object_attributes.iid;

  const extra = core.buildSpecExtra(result.specResults);
  const header = result.approved ? '### AI Review: Looks good' : '### AI Review: Issues found';
  const summary = `${header}\n\n${result.summary}${extra}`;
  await gitlab.postComment(projectId, mrIid, summary);

  const mrInfo = await gitlab.getMergeRequestInfo(projectId, mrIid);
  const diff = await gitlab.getMergeRequestDiff(projectId, mrIid);
  const fileStatusMap = new Map(diff.files.map(f => [f.path, f.status]));

  const validPositions = new Set<string>();
  for (const f of diff.files) {
    if (f.patch) {
      for (const ln of core.getDiffLineNumbers(f.patch)) {
        validPositions.add(`${f.path}:${ln}`);
      }
    }
  }

  const existingDiscs = await gitlab.getDiscussions(projectId, mrIid);
  const existingPositions = new Set<string>();
  for (const d of existingDiscs) {
    const pos = d.notes?.[0]?.position;
    if (pos?.new_path && pos?.new_line) {
      const key = `${pos.new_path}:${pos.new_line}`;
      if (validPositions.has(key)) {
        existingPositions.add(key);
      }
    }
  }

  const seen = new Set<string>();
  for (const comment of result.comments) {
    const key = `${comment.path}:${comment.line}`;
    if (seen.has(key) || existingPositions.has(key)) continue;
    seen.add(key);
    const file = comment.path ? diff.files.find(f => f.path === comment.path) : undefined;
    await gitlab.postLineComment(projectId, mrIid, comment, mrInfo.diff_refs, file?.status, file?.patch);
  }
}
