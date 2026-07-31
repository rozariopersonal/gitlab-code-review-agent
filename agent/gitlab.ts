/**
 * @file Minimal GitLab REST client for the AI review agent.
 * All methods return raw fetch Responses; callers read .json() / .text().
 */

export interface AgentConfig {
  gitlabUrl: string;
  projectId: string;
  mrIid: string;
  gitlabToken: string;
  geminiApiKey: string;
  templatesProject: string;
  templatesRef: string;
}

export interface DiscussionPosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  new_path: string;
  new_line: number;
  old_path?: string;
  old_line?: number;
}

export interface GitLabApi {
  getMr: () => Promise<Response>;
  getDiff: () => Promise<Response>;
  getDiscussions: () => Promise<Response>;
  getFile: (filePath: string, ref: string) => Promise<Response>;
  postNote: (body: string) => Promise<Response>;
  postDiscussion: (body: string, position: DiscussionPosition) => Promise<Response>;
}

export function createApi(config: AgentConfig): GitLabApi {
  const base = `${config.gitlabUrl}/api/v4`;
  const headers = { 'PRIVATE-TOKEN': config.gitlabToken, 'Content-Type': 'application/json' };
  const mrPath = `/projects/${config.projectId}/merge_requests/${config.mrIid}`;

  const get = (pathname: string) => fetch(`${base}${pathname}`, { headers });
  const post = (pathname: string, body: unknown) =>
    fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });

  return {
    getMr: () => get(mrPath),
    getDiff: () => get(`${mrPath}/diffs`),
    getDiscussions: () => get(`${mrPath}/discussions`),
    getFile: (filePath, ref) =>
      get(`/projects/${config.projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`),
    postNote: (body) => post(`${mrPath}/notes`, { body }),
    postDiscussion: (body, position) => post(`${mrPath}/discussions`, { body, position }),
  };
}
