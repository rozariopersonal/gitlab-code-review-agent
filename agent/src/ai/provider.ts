import { ReviewResult, AIProviderConfig } from '../types';

export interface AIProvider {
  name: string;
  reviewCode(diffContent: string, config: AIProviderConfig): Promise<ReviewResult>;
}
