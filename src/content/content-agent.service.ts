import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EmbeddingService } from '../vector/embedding.service.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';
import {
  buildThreadsPrompt,
  buildRegenPrompt,
  buildTopicSuggestPrompt,
  type ThreadsFormat,
} from './prompts/threads.prompt.js';

const VOICE_SAMPLES_PREFIX = 'voice-samples/';
const CONTEXT_NOTES_COUNT = 8;
const CONTEXT_NOTE_MAX_CHARS = 800;

@Injectable()
export class ContentAgentService {
  private readonly logger = new Logger(ContentAgentService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly contentModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
    this.model = this.config.get<string>('ai.openai.model', 'gpt-4o-mini');
    this.contentModel = this.config.get<string>('ai.openai.contentModel', 'gpt-4.1-mini');
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
    const allIds: string[] = [];
    for (const prefix of ['inbox/', 'projects/']) {
      const ids = await this.couchSync.listByPrefix(prefix);
      allIds.push(...ids);
    }

    this.logger.log(`Found ${allIds.length} notes for topic suggestions`);

    const context = await this.buildContext(allIds.slice(-30));

    this.logger.log(`Built context: ${context.length} chars`);

    if (!context) return [];

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: buildTopicSuggestPrompt(),
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
      this.logger.log(`AI topics response: ${raw.slice(0, 200)}`);
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]) as string[];
      }
      return [];
    } catch (err) {
      this.logger.warn(`Failed to parse topics: ${(err as Error).message}`);
      return [];
    }
  }

  async generateThreads(
    topic: string,
    format: ThreadsFormat = 'auto',
  ): Promise<{ post: string; sources: string[] }> {
    if (!topic) {
      return { post: 'Pick a topic first. Use /generate threads', sources: [] };
    }

    const [results, voiceSamples] = await Promise.all([
      this.embedding.searchSimilar(topic, CONTEXT_NOTES_COUNT),
      this.loadVoiceSamples(),
    ]);

    const sourceIds = results.map((r) => r.docId);
    const context = sourceIds.length > 0
      ? await this.buildContext(sourceIds)
      : '';

    if (!context) {
      return { post: 'No relevant notes found for this topic. Try /reindex first.', sources: [] };
    }

    const sources = sourceIds
      .filter((id) => id.endsWith('.md'))
      .map((id) => id.replace('.md', '').replace(/^[^/]+\//, ''));

    const response = await this.openai.chat.completions.create({
      model: this.contentModel,
      messages: [
        {
          role: 'system',
          content: buildThreadsPrompt(voiceSamples, format),
        },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nMy notes for context:\n\n${context}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.75,
    });

    return {
      post: response.choices[0]?.message?.content?.trim() || 'Failed to generate.',
      sources,
    };
  }

  async regenerateWithFeedback(
    previousPost: string,
    feedback: string,
    format?: ThreadsFormat,
  ): Promise<string> {
    const voiceSamples = await this.loadVoiceSamples();
    const voiceHint = voiceSamples.length > 0
      ? `\n\nVoice reference:\n${voiceSamples.map((s) => `"""${s}"""`).join('\n')}`
      : '';

    const response = await this.openai.chat.completions.create({
      model: this.contentModel,
      messages: [
        {
          role: 'system',
          content: buildRegenPrompt(format) + voiceHint,
        },
        {
          role: 'user',
          content: `Post:\n${previousPost}\n\nChange: ${feedback}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.75,
    });

    return response.choices[0]?.message?.content?.trim() || previousPost;
  }

  async saveVoiceSample(content: string): Promise<string> {
    const id = `${VOICE_SAMPLES_PREFIX}sample-${Date.now()}.md`;
    const today = new Date().toISOString().split('T')[0];
    const markdown = `---\ntype: voice-sample\ncreated: ${today}\n---\n\n${content}\n`;
    await this.couchSync.writeFile(id, markdown);
    this.logger.log(`Saved voice sample: ${id}`);
    return id;
  }

  async deleteVoiceSample(id: string): Promise<void> {
    await this.couchSync.deleteFile(id);
    this.logger.log(`Deleted voice sample: ${id}`);
  }

  async listVoiceSamples(): Promise<string[]> {
    return this.couchSync.listByPrefix(VOICE_SAMPLES_PREFIX);
  }

  private async loadVoiceSamples(): Promise<string[]> {
    const ids = await this.couchSync.listByPrefix(VOICE_SAMPLES_PREFIX);
    const samples: string[] = [];

    for (const id of ids.slice(-5)) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;

      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || content;
      if (body) samples.push(body);
    }

    return samples;
  }

  private async buildContext(docIds: string[]): Promise<string> {
    const parts: string[] = [];

    for (const id of docIds) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;

      const title = id.replace('.md', '').replace(/^[^/]+\//, '');
      let body: string;

      if (id.startsWith('contacts/')) {
        // Include frontmatter for contacts
        const name = content.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const context = content.match(/^context:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const cityMet = content.match(/^city_met:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const phone = content.match(/^phone:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        const noteBody = bodyMatch?.[1]?.trim() || '';
        const meta = [name, context, cityMet, phone].filter(Boolean).join('. ');
        body = meta + (noteBody ? '\n' + noteBody : '');
      } else {
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        body = bodyMatch?.[1]?.trim() || content;
      }

      parts.push(`### ${title}\n${body.slice(0, CONTEXT_NOTE_MAX_CHARS)}`);
    }

    return parts.join('\n\n');
  }
}
