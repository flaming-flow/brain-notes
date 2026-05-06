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
    // Use main model for content generation (can be overridden later)
    this.model = this.config.get<string>('ai.openai.model', 'gpt-4o-mini');
  }

  async ask(question: string): Promise<string> {
    const results = await this.embedding.searchSimilar(question, 5);

    if (results.length === 0) {
      return 'No relevant notes found.';
    }

    // Fetch full content of relevant notes
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

  async generateThreads(topic: string): Promise<string> {
    let context: string;

    if (topic) {
      const results = await this.embedding.searchSimilar(topic, 8);
      context = results.length > 0
        ? await this.buildContext(results.map((r) => r.docId))
        : '';
    } else {
      // No topic — use recent notes as inspiration
      const recentIds = await this.couchSync.listByPrefix('inbox/');
      const last10 = recentIds.slice(-10);
      context = await this.buildContext(last10);
      if (!context) {
        return 'No notes yet to generate from. Send me some ideas first!';
      }
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a content creator assistant for Threads (text-based social platform by Meta). ' +
            'Create an engaging post based on the user\'s personal notes and the given topic.\n\n' +
            'Rules:\n' +
            '- Write in the same language as the topic (Russian or English)\n' +
            '- Keep it under 500 characters (Threads limit)\n' +
            '- Start with a strong hook (first line must grab attention)\n' +
            '- Be authentic, personal, reflective — not corporate or generic\n' +
            '- Use the user\'s own insights and experiences from their notes\n' +
            '- End with a question or thought-provoking statement to drive engagement\n' +
            '- No hashtags in the post body (can suggest 3-5 at the end separately)\n' +
            '- Tone: thoughtful, real, slightly philosophical\n\n' +
            'Format:\n' +
            '[POST]\n' +
            'The actual post text\n\n' +
            '[HASHTAGS]\n' +
            '#tag1 #tag2 #tag3',
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

    return response.choices[0]?.message?.content?.trim() || 'Failed to generate.';
  }

  private async buildContext(docIds: string[]): Promise<string> {
    const parts: string[] = [];

    for (const id of docIds) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;

      // Strip frontmatter
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || content;
      const title = id.replace('.md', '').replace(/^[^/]+\//, '');

      parts.push(`### ${title}\n${body.slice(0, 500)}`);
    }

    return parts.join('\n\n');
  }
}
