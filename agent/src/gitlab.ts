import fetch from 'node-fetch';
import { MergeRequestDiff, MergeRequestInfo, DiffRefs, ReviewComment } from './types';

export interface GitLabConfig {
  url: string;
  token: string;
}

function getLinePosition(patch: string | undefined, targetNewLine: number): { old_line?: number } {
  if (!patch) return {};

  const lines = patch.split('\n');
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10) - 1;
      newLine = parseInt(hunkMatch[2], 10) - 1;
      continue;
    }

    if (!line.startsWith('---') && !line.startsWith('+++')) {
      if (line.startsWith('+')) {
        newLine++;
        if (newLine === targetNewLine) return {};
      } else if (line.startsWith('-')) {
        oldLine++;
      } else {
        oldLine++;
        newLine++;
        if (newLine === targetNewLine) return { old_line: oldLine };
      }
    }
  }

  if (targetNewLine > newLine) return { old_line: oldLine + (targetNewLine - newLine) };
  return {};
}

export class GitLabClient {
  private apiUrl: string;
  private headers: Record<string, string>;

  constructor(private config: GitLabConfig) {
    this.apiUrl = `${config.url}/api/v4`;
    this.headers = {
      'PRIVATE-TOKEN': config.token,
      'Content-Type': 'application/json',
    };
  }

  async getMergeRequestDiff(projectId: number, mrIid: number): Promise<MergeRequestDiff> {
    const url = `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/diffs`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch MR diff: ${response.statusText}`);
    }

    const diffs: any[] = await response.json();

    return {
      sha: diffs[0]?.sha || '',
      files: diffs.map((d: any) => ({
        path: d.new_path || d.old_path,
        status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
        patch: d.diff,
        additions: d.new_file ? d.diff?.split('\n').filter((l: string) => l.startsWith('+')).length || 0 : 0,
        deletions: d.deleted_file ? d.diff?.split('\n').filter((l: string) => l.startsWith('-')).length || 0 : 0,
      })),
    };
  }

  async getMergeRequestInfo(projectId: number, mrIid: number): Promise<MergeRequestInfo> {
    const url = `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch MR info: ${response.statusText}`);
    }

    const mr: any = await response.json();
    return {
      diff_refs: mr.diff_refs as DiffRefs,
      sha: mr.sha,
    };
  }

  async postComment(projectId: number, mrIid: number, body: string): Promise<void> {
    const url = `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/notes`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      throw new Error(`Failed to post comment: ${response.statusText}`);
    }
  }

  async postLineComment(
    projectId: number,
    mrIid: number,
    comment: ReviewComment,
    diffRefs?: DiffRefs,
    fileStatus?: string,
    patch?: string
  ): Promise<void> {
    if (!comment.path || !comment.line || !diffRefs) return;

    const isAdded = fileStatus === 'added';
    const linePos = isAdded ? {} : getLinePosition(patch, comment.line);

    const position: Record<string, any> = {
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

    const body = comment.note;
    const url = `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ body, position }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to post inline comment: ${response.status} ${text.slice(0, 200)}`);
    }
  }

  async getDiscussions(projectId: number, mrIid: number): Promise<any[]> {
    const url = `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions`;
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) return [];
    return response.json();
  }

  async getProjectId(pathWithNamespace: string): Promise<number> {
    const encoded = encodeURIComponent(pathWithNamespace);
    const url = `${this.apiUrl}/projects/${encoded}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to get project: ${response.statusText}`);
    }

    const project: any = await response.json();
    return project.id;
  }

  async getFileContent(projectId: number, filePath: string, ref: string): Promise<string | null> {
    const encodedPath = encodeURIComponent(filePath);
    const url = `${this.apiUrl}/projects/${projectId}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      return null;
    }

    return response.text();
  }
}
