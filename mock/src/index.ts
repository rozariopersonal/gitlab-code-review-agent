import express from 'express';

const app = express();
app.use(express.json());

const PORT = 8929;

interface MRDiff {
  sha: string;
  new_path: string;
  old_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

const SAMPLE_DIFFS: Record<number, { sha: string; diffs: MRDiff[] }> = {
  1: {
    sha: 'abc123def456',
    diffs: [
      {
        sha: 'abc123',
        new_path: 'src/calculator.ts',
        old_path: 'src/calculator.ts',
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -1,10 +1,24 @@
 function add(a: number, b: number): number {
   return a + b;
 }

-function divide(a: number, b: number): number {
-  return a / b;
+function divide(a: number, b: number): number {
+  if (b === 0) {
+    throw new Error('Division by zero');
+  }
+  return a / b;
+}
+
+function processInput(input: string): number {
+  const cmd = "rm -rf /";
+  eval(input);
+  return 0;
+}
+
+function fetchData(url: string): Promise<string> {
+  const apiKey = "sk-1234567890abcdef";
+  return fetch(url, { headers: { Authorization: \`Bearer \${apiKey}\` }}).then(r => r.text());
 }`,
      },
      {
        sha: 'def789',
        new_path: 'src/config.ts',
        old_path: 'src/config.ts',
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: `--- a/src/config.ts
+++ b/src/config.ts
@@ -1,5 +1,8 @@
 export const config = {
   port: 3000,
+  debug: true,
+  db: {
+    password: "supersecret",
+  },
   env: process.env.NODE_ENV || 'development',
 };`,
      },
    ],
  },
};

const SAMPLE_NOTE: any = {
  id: 1,
  body: '',
  author: { id: 1, username: 'ai-reviewer', name: 'AI Reviewer' },
  created_at: new Date().toISOString(),
  system: false,
};

const projects: Record<string, any> = {
  'test-user/test-project': {
    id: 1,
    name: 'test-project',
    path_with_namespace: 'test-user/test-project',
  },
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/v4/projects/:encoded', (req, res) => {
  const path = decodeURIComponent(req.params.encoded);
  const project = projects[path];

  if (project) {
    return res.json(project);
  }

  const id = parseInt(req.params.encoded);
  if (id === 1) {
    return res.json(projects['test-user/test-project']);
  }

  res.status(404).json({ message: 'Not found' });
});

app.get('/api/v4/projects/:projectId/merge_requests/:mrIid/diffs', (req, res) => {
  const mrIid = parseInt(req.params.mrIid);
  const data = SAMPLE_DIFFS[mrIid];

  if (data) {
    return res.json(data.diffs);
  }

  res.status(404).json({ message: 'MR not found' });
});

app.post('/api/v4/projects/:projectId/merge_requests/:mrIid/notes', (req, res) => {
  console.log(`[Mock GitLab] Comment on MR !${req.params.mrIid}:`);
  console.log(req.body.body);
  console.log('---');

  res.status(201).json({
    ...SAMPLE_NOTE,
    id: Date.now(),
    body: req.body.body,
  });
});

app.post('/api/v4/projects/:projectId/merge_requests/:mrIid/discussions', (req, res) => {
  console.log(`[Mock GitLab] Line comment on MR !${req.params.mrIid}:`);
  if (req.body.position) {
    console.log(`  File: ${req.body.position.new_path}:${req.body.position.new_line}`);
  }
  console.log(`  ${req.body.body}`);
  console.log('---');

  res.status(201).json({
    id: `discussion-${Date.now()}`,
    notes: [{ ...SAMPLE_NOTE, id: Date.now(), body: req.body.body, position: req.body.position }],
  });
});

app.listen(PORT, () => {
  console.log(`Mock GitLab API running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /api/v4/projects/:id');
  console.log('  GET  /api/v4/projects/:id/merge_requests/:iid/diffs');
  console.log('  POST /api/v4/projects/:id/merge_requests/:iid/notes');
  console.log('  POST /api/v4/projects/:id/merge_requests/:iid/discussions');
});
