import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EmbeddingService } from '../vector/embedding.service.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

@Injectable()
export class ContentAgentService {
  private readonly logger = new Logger(ContentAgentService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
    this.model = this.config.get<string>('ai.openai.model', 'gpt-4o-mini');
  }

  async ask(question: string): Promise<string> {
    const results = await this.embedding.searchSimilar(question, 5);

    if (results.length === 0) {
      return 'No relevant notes found.';
    }

    const context = await this.buildContext(results.map((r) => r.docId));

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a personal knowledge assistant. Answer the question based on the user\'s notes provided below. ' +
            'Be concise and reference specific notes when relevant. ' +
            'Answer in the same language as the question.',
        },
        {
          role: 'user',
          content: `My notes:\n\n${context}\n\n---\n\nQuestion: ${question}`,
        },
      ],
      max_tokens: 1000,
      temperature: 0.5,
    });

    return response.choices[0]?.message?.content?.trim() || 'No answer generated.';
  }

  async suggestTopics(): Promise<string[]> {
    const recentIds = await this.couchSync.listByPrefix('inbox/');
    const last15 = recentIds.slice(-15);
    const context = await this.buildContext(last15);

    if (!context) return [];

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'Based on the user\'s recent notes, suggest 5 engaging topics for a Threads post. ' +
            'Each topic should be a short phrase (3-7 words) in the same language as the notes. ' +
            'Focus on personal insights, reflections, and experiences — not generic advice. ' +
            'Return ONLY a JSON array of strings, nothing else. Example: ["topic 1", "topic 2"]',
        },
        {
          role: 'user',
          content: context,
        },
      ],
      max_tokens: 300,
      temperature: 0.8,
    });

    try {
      const raw = response.choices[0]?.message?.content?.trim() || '[]';
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async generateThreads(topic: string): Promise<{ post: string; sources: string[] }> {
    let context: string;
    let sourceIds: string[];

    if (topic) {
      const results = await this.embedding.searchSimilar(topic, 8);
      sourceIds = results.map((r) => r.docId);
      context = results.length > 0
        ? await this.buildContext(sourceIds)
        : '';
    } else {
      const recentIds = await this.couchSync.listByPrefix('inbox/');
      sourceIds = recentIds.slice(-10);
      context = await this.buildContext(sourceIds);
      if (!context) {
        return { post: 'No notes yet. Send me some ideas first!', sources: [] };
      }
    }

    const sources = sourceIds
      .filter((id) => id.endsWith('.md'))
      .map((id) => id.replace('.md', '').replace(/^[^/]+\//, ''));

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a personal content assistant. Write a Threads post.\n\n' +
            'Style:\n' +
            '- Authentic, personal, like talking to a friend\n' +
            '- Use "I" perspective, share real feelings and insights\n' +
            '- Short sentences, conversational rhythm\n' +
            '- Start with a hook that makes people stop scrolling\n' +
            '- End with a question that invites discussion\n' +
            '- NO corporate/motivational speaker tone\n' +
            '- NO cliches like "in today\'s world" or "it\'s important to"\n' +
            '- Under 500 characters\n\n' +
            'Write ONLY the post text. After the post, on a new line write hashtags (3-5, with #).\n' +
            'Do NOT add labels like [POST] or [HASHTAGS].',
        },
        {
          role: 'user',
          content: topic
            ? `Topic: ${topic}\n\nMy notes for context:\n\n${context}`
            : `Pick the most interesting idea from my recent notes and write a post:\n\n${context}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    return {
      post: response.choices[0]?.message?.content?.trim() || 'Failed to generate.',
      sources,
    };
  }

  async regenerateWithFeedback(previousPost: string, feedback: string): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite this Threads post based on the feedback. ' +
            'Keep the same authentic, personal style. Under 500 characters. ' +
            'Write ONLY the post text + hashtags on new line. No labels.',
        },
        {
          role: 'user',
          content: `Post:\n${previousPost}\n\nChange: ${feedback}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    return response.choices[0]?.message?.content?.trim() || previousPost;
  }

  private async buildContext(docIds: string[]): Promise<string> {
    const parts: string[] = [];

    for (const id of docIds) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;

      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || content;
      const title = id.replace('.md', '').replace(/^[^/]+\//, '');

      parts.push(`### ${title}\n${body.slice(0, 500)}`);
    }

    return parts.join('\n\n');
  }
}
