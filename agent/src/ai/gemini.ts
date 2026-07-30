import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider } from './provider';
import { AIProviderConfig, ReviewResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';

const core = require('../../review-core.js');

function buildPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const promptPath = path.join(__dirname, '../../prompt.md');
  let prompt = fs.readFileSync(promptPath, 'utf-8');
  prompt = prompt.replace('{{DATE}}', today);
  return prompt;
}

export class GeminiProvider implements AIProvider {
  name = 'gemini';

  async reviewCode(diffContent: string, config: AIProviderConfig): Promise<ReviewResult> {
    const genAI = new GoogleGenerativeAI(config.apiKey);
    const model = genAI.getGenerativeModel({
      model: config.model || 'gemini-2.5-flash',
      apiVersion: 'v1',
    } as any);

    const result = await model.generateContent([
      { text: buildPrompt() },
      { text: `Here is the diff to review:\n\n\`\`\`diff\n${diffContent}\n\`\`\`` },
    ]);

    const response = result.response;
    const text = response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        summary: 'Failed to parse AI response',
        comments: [],
        approved: false,
      };
    }

    const parsed = JSON.parse(core.fixJSONNewlines(jsonMatch[0])) as ReviewResult;
    console.log(`[Gemini] Raw response: ${JSON.stringify(parsed)}`);
    return parsed;
  }
}
