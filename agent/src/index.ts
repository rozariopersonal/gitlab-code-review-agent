import express from 'express';
import { MergeRequestEvent } from './types';
import { reviewMergeRequest, ReviewerConfig } from './reviewer';

const app = express();
app.use(express.json());

const config: ReviewerConfig = {
  gitlab: {
    url: process.env.GITLAB_URL || 'http://gitlab:8929',
    token: process.env.GITLAB_TOKEN || '',
  },
  ai: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
};

const PORT = parseInt(process.env.PORT || '3000', 10);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    gitlab_url: config.gitlab.url,
    gemini_configured: !!config.ai.apiKey,
  });
});

app.post('/webhook/gitlab', async (req, res) => {
  const event: MergeRequestEvent = req.body;

  if (event.object_kind !== 'merge_request') {
    return res.status(400).json({ error: 'Not a merge request event' });
  }

  const relevantActions = ['open', 'update'];
  if (!relevantActions.includes(event.object_attributes.action)) {
    return res.json({ message: `Skipping action: ${event.object_attributes.action}` });
  }

  if (!config.ai.apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  res.status(202).json({ message: 'Review started' });

  try {
    const result = await reviewMergeRequest(event, config);
    console.log(`[Server] Review result for MR !${event.object_attributes.iid}: approved=${result.approved}`);
  } catch (err) {
    console.error(`[Server] Review failed:`, err);
  }
});

app.listen(PORT, () => {
  console.log(`GitLab AI Reviewer running on port ${PORT}`);
  console.log(`GitLab URL: ${config.gitlab.url}`);
  console.log(`Gemini configured: ${!!config.ai.apiKey}`);
});
