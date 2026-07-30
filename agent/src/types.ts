export interface MergeRequestEvent {
  object_kind: 'merge_request';
  project: {
    id: number;
    path_with_namespace: string;
    git_ssh_url: string;
    git_http_url: string;
  };
  object_attributes: {
    id: number;
    iid: number;
    title: string;
    description: string;
    source_branch: string;
    target_branch: string;
    source_project_id: number;
    target_project_id: number;
    state: string;
    action: 'open' | 'update' | 'merge' | 'close';
    url: string;
  };
  user: {
    name: string;
    username: string;
  };
}

export interface MergeRequestDiff {
  sha: string;
  files: ChangedFile[];
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch?: string;
  additions: number;
  deletions: number;
}

export interface SpecItem {
  text: string;
  satisfied: boolean;
  reason?: string;
}

export interface ReviewComment {
  note: string;
  path?: string;
  line?: number;
  line_type?: 'old' | 'new';
  suggestion?: string;
}

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface MergeRequestInfo {
  diff_refs: DiffRefs;
  sha: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  approved: boolean;
  specResults?: SpecItem[];
}

export interface AIProviderConfig {
  apiKey: string;
  model?: string;
}
