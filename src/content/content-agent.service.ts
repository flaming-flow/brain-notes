import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EmbeddingService } from '../vector/embedding.service.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';
import {
  buildSystemPrompt,
  buildFormatInstruction,
  buildPlanPrompt,
  buildCritiqueRevisePrompt,
  buildRefinePrompt,
  buildTopicSuggestPrompt,
  type ThreadsFormat,
} from './prompts/threads.prompt.js';
import type { ContentGenMessage } from '../shared/interfaces/session.interface.js';

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

  async ask(question: string): Promise<{ answer: string; sources: string[] }> {
    const results = await this.embedding.searchSimilar(question, 5);

    if (results.length === 0) {
      return { answer: 'No relevant notes found.', sources: [] };
    }

    const sourceIds = results.map((r) => r.docId);
    const context = await this.buildContext(sourceIds);

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

    return {
      answer: response.choices[0]?.message?.content?.trim() || 'No answer generated.',
      sources: sourceIds,
    };
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

  /**
   * Build a fresh generation session for a topic: retrieves note context once
   * and composes the system prompt reused across all later refinements.
   */
  async startSession(
    topic: string,
  ): Promise<{ systemPrompt: string; contextBlock: string; sources: string[] } | null> {
    if (!topic) return null;

    const [results, voiceSamples] = await Promise.all([
      this.embedding.searchSimilar(topic, CONTEXT_NOTES_COUNT),
      this.loadVoiceSamples(),
    ]);

    const sourceIds = results.map((r) => r.docId);
    const contextBlock = sourceIds.length > 0 ? await this.buildContext(sourceIds) : '';
    if (!contextBlock) return null;

    const sources = sourceIds
      .filter((id) => id.endsWith('.md'))
      .map((id) => id.replace('.md', '').replace(/^[^/]+\//, ''));

    return {
      systemPrompt: buildSystemPrompt(contextBlock, voiceSamples),
      contextBlock,
      sources,
    };
  }

  /**
   * First post for a session: plan the angle, draft, then critique-and-revise.
   */
  async generateFirst(
    systemPrompt: string,
    contextBlock: string,
    topic: string,
    format: ThreadsFormat = 'auto',
  ): Promise<string> {
    const plan = await this.chat(
      this.model,
      buildPlanPrompt(),
      `Topic: ${topic}\n\nNotes:\n${contextBlock}`,
      0.8,
      400,
    );

    const draft = await this.chat(
      this.contentModel,
      systemPrompt,
      `Topic: ${topic}\n\n${buildFormatInstruction(format)}\n\nStrategist brief:\n${plan}\n\nWrite the post now.`,
      0.75,
      500,
    );

    const final = await this.chat(
      this.contentModel,
      buildCritiqueRevisePrompt(format),
      `Notes:\n${contextBlock}\n\nDraft:\n${draft}`,
      0.6,
      500,
    );

    return final || draft || 'Failed to generate.';
  }

  /**
   * Apply the latest instruction over the full conversation transcript.
   * Earlier changes persist because they live in the message history.
   */
  async refine(
    systemPrompt: string,
    messages: ContentGenMessage[],
    format?: ThreadsFormat,
  ): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: this.contentModel,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${buildRefinePrompt(format)}` },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 500,
      temperature: 0.75,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  private async chat(
    model: string,
    system: string,
    user: string,
    temperature: number,
    maxTokens: number,
  ): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    });
    return response.choices[0]?.message?.content?.trim() || '';
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
