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
  buildUnpackPrompt,
  buildVoiceProfilePrompt,
  type ThreadsFormat,
} from './prompts/threads.prompt.js';
import type { ContentGenMessage } from '../shared/interfaces/session.interface.js';

const VOICE_SAMPLES_PREFIX = 'voice-samples/';
const VOICE_PROFILE_ID = 'voice-profile/profile.md';
const VOICE_SAMPLE_COUNT = 5;
const CONTEXT_NOTES_COUNT = 8;
const CONTEXT_NOTE_MAX_CHARS = 800;

// /ask feeds the WHOLE diary, ordered by relevance. Full-text notes fill a char
// budget; once the vault outgrows it, the least-relevant tail degrades to
// one-line digests instead of being dropped — so the agent still knows every
// note exists. Budget/caps/model/effort/verify are all env-tunable (see config).
const ASK_NOTE_PREFIXES = ['inbox/', 'contacts/', 'projects/', 'books/'];

const GROUNDED_ANSWER_PROMPT =
  'You are the author\'s personal knowledge assistant with access to their whole diary below.\n' +
  'Rules:\n' +
  '- Use ONLY facts present in the notes. Never invent names, dates, numbers, or claims.\n' +
  '- After each statement, cite its source note title in square brackets, e.g. [note-title].\n' +
  '- Synthesize across notes: connect related ones, and explicitly point out shifts of focus, ' +
  'changes of mind, or contradictions over time when they bear on the question.\n' +
  "- If NO note directly addresses the question, say plainly that the notes don't cover it and STOP. " +
  'Do NOT substitute loosely related notes as a consolation answer.\n' +
  "- Preserve the author's tone: if a note is ironic or sarcastic, don't read it literally.\n" +
  '- Answer in the same language as the question. Be concise.';

const VERIFY_ANSWER_PROMPT =
  'You are a strict fact-checker. You are given the source notes, a question, and a draft answer.\n' +
  'Remove or correct any statement in the draft that is not directly supported by the notes.\n' +
  'Keep the [note-title] citations. Keep the same language as the draft.\n' +
  "If nothing in the notes supports an answer, say the notes don't cover it.\n" +
  'Output ONLY the corrected answer, nothing else.';

@Injectable()
export class ContentAgentService {
  private readonly logger = new Logger(ContentAgentService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly askModel: string;
  private readonly contentModel: string;
  private readonly askReasoningEffort: string;
  private readonly askVerify: boolean;
  private readonly askContextBudgetChars: number;
  private readonly askNoteMaxChars: number;
  private readonly askSourceLimit: number;

  constructor(
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
    this.model = this.config.get<string>('ai.openai.model', 'gpt-4o-mini');
    this.askModel = this.config.get<string>('ai.openai.askModel', 'gpt-5-mini');
    this.contentModel = this.config.get<string>('ai.openai.contentModel', 'gpt-4.1-mini');
    this.askReasoningEffort = this.config.get<string>('ai.ask.reasoningEffort', 'low');
    this.askVerify = this.config.get<boolean>('ai.ask.verify', false);
    this.askContextBudgetChars = this.config.get<number>('ai.ask.contextBudgetChars', 200000);
    this.askNoteMaxChars = this.config.get<number>('ai.ask.noteMaxChars', 4000);
    this.askSourceLimit = this.config.get<number>('ai.ask.sourceLimit', 10);
  }

  async ask(question: string): Promise<{ answer: string; sources: string[] }> {
    // Whole-diary context: rank every note by relevance (reusing stored
    // embeddings), then feed all of them ordered high→low. Full text fills the
    // budget; any overflow tail becomes a one-line digest so nothing is hidden.
    const ranked = await this.embedding.rankAllNotes(question);
    const scoreById = new Map(ranked.map((r) => [r.docId, r.score]));

    const allIds = new Set<string>();
    for (const prefix of ASK_NOTE_PREFIXES) {
      for (const id of await this.couchSync.listByPrefix(prefix)) {
        if (id.endsWith('.md')) allIds.add(id);
      }
    }
    if (allIds.size === 0) {
      return { answer: 'No notes yet.', sources: [] };
    }

    // Relevance order; notes missing from the index (not yet embedded) go last.
    const ordered = [...allIds].sort(
      (a, b) => (scoreById.get(b) ?? -1) - (scoreById.get(a) ?? -1),
    );

    const full: string[] = [];
    const digest: string[] = [];
    const blockByTitle = new Map<string, string>(); // for the cited-only verify pass
    let used = 0;
    for (const id of ordered) {
      const note = await this.loadNote(id);
      if (!note) continue;
      if (used < this.askContextBudgetChars) {
        const block = `### ${note.title}\n${note.body.slice(0, this.askNoteMaxChars)}`;
        full.push(block);
        blockByTitle.set(note.title, block);
        used += block.length;
      } else {
        const snippet = note.body.replace(/\s+/g, ' ').trim().slice(0, 120);
        digest.push(`- ${note.title}: ${snippet}`);
      }
    }

    const context =
      full.join('\n\n') +
      (digest.length
        ? `\n\n---\nOther notes in the diary (title + snippet; mention only if relevant):\n${digest.join('\n')}`
        : '');
    const sourceIds = ranked.slice(0, this.askSourceLimit).map((r) => r.docId);

    // Answer with the reasoning model over the whole diary.
    const t0 = Date.now();
    const draft = await this.chat(
      this.askModel,
      GROUNDED_ANSWER_PROMPT,
      `My notes:\n\n${context}\n\n---\n\nQuestion: ${question}`,
      0.1,
      1000,
      this.askReasoningEffort,
    );
    const tDraft = Date.now();
    this.logger.log(
      `ask timing: ctx=${context.length}ch draft(${this.askModel}, effort=${this.askReasoningEffort})=${tDraft - t0}ms`,
    );

    // Optional verification (ASK_VERIFY): fact-check only against the notes the
    // draft actually cited, on a fast cheap model. Off by default — grounding +
    // the reasoning draft already guard against hallucination, and re-generating
    // the full answer roughly doubles latency.
    if (!this.askVerify) {
      return { answer: draft || 'No answer generated.', sources: sourceIds };
    }

    const citedBlocks = [...new Set(draft.match(/\[([^\]]+)\]/g)?.map((m) => m.slice(1, -1)) ?? [])]
      .map((title) => blockByTitle.get(title))
      .filter((b): b is string => Boolean(b));

    if (citedBlocks.length === 0) {
      return { answer: draft || 'No answer generated.', sources: sourceIds };
    }

    const verified = await this.chat(
      this.model,
      VERIFY_ANSWER_PROMPT,
      `Notes:\n\n${citedBlocks.join('\n\n')}\n\n---\n\nQuestion: ${question}\n\nDraft answer:\n${draft}`,
      0,
      1000,
    );
    this.logger.log(
      `ask timing: verify(${this.model}, ${citedBlocks.length} notes)=${Date.now() - tDraft}ms`,
    );

    return {
      answer: verified || draft || 'No answer generated.',
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
  async startSession(topic: string): Promise<{
    systemPrompt: string;
    contextBlock: string;
    sources: string[];
    voiceSamples: string[];
  } | null> {
    if (!topic) return null;

    const [results, voiceSamples, voiceProfile] = await Promise.all([
      this.embedding.searchReranked(topic, CONTEXT_NOTES_COUNT),
      this.loadVoiceSamples(topic),
      this.loadVoiceProfile(),
    ]);

    const sourceIds = [...new Set(results.map((r) => r.docId))];
    const contextBlock = sourceIds.length > 0 ? await this.buildContext(sourceIds) : '';
    if (!contextBlock) return null;

    const sources = sourceIds
      .filter((id) => id.endsWith('.md'))
      .map((id) => id.replace('.md', '').replace(/^[^/]+\//, ''));

    return {
      systemPrompt: buildSystemPrompt(contextBlock, voiceSamples, voiceProfile),
      contextBlock,
      sources,
      voiceSamples,
    };
  }

  /**
   * Generate 2-4 clarifying questions to pull specific/personal material out of
   * the author before writing — the notes are usually incomplete. Empty on failure.
   */
  async buildUnpackQuestions(topic: string, contextBlock: string): Promise<string[]> {
    try {
      const raw = await this.chat(
        this.model,
        buildUnpackPrompt(),
        `Topic: ${topic}\n\nNotes:\n${contextBlock}`,
        0.7,
        600,
      );
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const questions = JSON.parse(match[0]) as string[];
      return questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 4);
    } catch (err) {
      this.logger.warn(`Unpack questions failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * First post for a session: plan the angle, draft, then critique-and-revise.
   * `enrichment` = the author's fresh answers to unpack questions (prioritized).
   * `voiceSamples` are passed to the critic so it edits toward the author's voice.
   */
  async generateFirst(
    systemPrompt: string,
    contextBlock: string,
    topic: string,
    format: ThreadsFormat = 'auto',
    enrichment = '',
    voiceSamples: string[] = [],
  ): Promise<string> {
    const enrichBlock = enrichment
      ? `\n\nAuthor's fresh answers (specific and personal — prioritize these over the notes):\n${enrichment}`
      : '';

    const plan = await this.chat(
      this.model,
      buildPlanPrompt(),
      `Topic: ${topic}\n\nNotes:\n${contextBlock}${enrichBlock}`,
      0.8,
      400,
    );

    const draft = await this.chat(
      this.contentModel,
      systemPrompt,
      `Topic: ${topic}\n\n${buildFormatInstruction(format)}\n\nStrategist brief:\n${plan}${enrichBlock}\n\nWrite the post now.`,
      0.9,
      500,
    );

    const final = await this.chat(
      this.contentModel,
      buildCritiqueRevisePrompt(format, voiceSamples),
      `Notes:\n${contextBlock}${enrichBlock}\n\nDraft:\n${draft}`,
      0.3,
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

  /** Reasoning models (o-series, gpt-5*) reject `temperature` and use
   *  `max_completion_tokens`; they also spend part of that budget on hidden
   *  reasoning, so give them extra headroom. */
  private static isReasoningModel(model: string): boolean {
    return /^(o\d|gpt-5)/i.test(model);
  }

  private async chat(
    model: string,
    system: string,
    user: string,
    temperature: number,
    maxTokens: number,
    reasoningEffort?: string,
  ): Promise<string> {
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];

    const params: Record<string, unknown> = { model, messages };
    if (ContentAgentService.isReasoningModel(model)) {
      params.max_completion_tokens = maxTokens + 2000;
      if (reasoningEffort) params.reasoning_effort = reasoningEffort;
    } else {
      params.max_tokens = maxTokens;
      params.temperature = temperature;
    }

    const response = await this.openai.chat.completions.create(
      params as unknown as Parameters<typeof this.openai.chat.completions.create>[0],
    );
    return (response as { choices?: Array<{ message?: { content?: string } }> })
      .choices?.[0]?.message?.content?.trim() || '';
  }

  async saveVoiceSample(content: string): Promise<string> {
    const id = `${VOICE_SAMPLES_PREFIX}sample-${Date.now()}.md`;
    const today = new Date().toISOString().split('T')[0];
    const markdown = `---\ntype: voice-sample\ncreated: ${today}\n---\n\n${content}\n`;
    await this.couchSync.writeFile(id, markdown);
    this.logger.log(`Saved voice sample: ${id}`);
    // Refresh the distilled voice profile in the background.
    void this.refreshVoiceProfile();
    return id;
  }

  async deleteVoiceSample(id: string): Promise<void> {
    await this.couchSync.deleteFile(id);
    this.logger.log(`Deleted voice sample: ${id}`);
  }

  async listVoiceSamples(): Promise<string[]> {
    return this.couchSync.listByPrefix(VOICE_SAMPLES_PREFIX);
  }

  /**
   * Load up to VOICE_SAMPLE_COUNT voice samples. When a topic is given, pick the
   * samples most SIMILAR to it (better voice transfer than plain recency —
   * LaMP benchmark); falls back to the latest N on failure or no topic.
   */
  private async loadVoiceSamples(topic?: string): Promise<string[]> {
    const ids = await this.couchSync.listByPrefix(VOICE_SAMPLES_PREFIX);
    const bodies: string[] = [];

    for (const id of ids) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || content;
      if (body) bodies.push(body);
    }

    if (bodies.length <= VOICE_SAMPLE_COUNT) return bodies;

    if (topic) {
      const order = await this.embedding.rankTexts(topic, bodies);
      if (order.length > 0) {
        return order.slice(0, VOICE_SAMPLE_COUNT).map((i) => bodies[i]);
      }
    }
    return bodies.slice(-VOICE_SAMPLE_COUNT);
  }

  private async loadVoiceProfile(): Promise<string> {
    const content = await this.couchSync.readFile(VOICE_PROFILE_ID);
    if (!content) return '';
    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return bodyMatch?.[1]?.trim() || content.trim();
  }

  /**
   * Distill saved voice samples into a compact style profile (POPI-style: a
   * short descriptor transfers voice better than dumping raw examples). Stored
   * in CouchDB, injected into the generation system prompt. Best-effort.
   */
  async refreshVoiceProfile(): Promise<void> {
    try {
      const ids = await this.couchSync.listByPrefix(VOICE_SAMPLES_PREFIX);
      if (ids.length < 3) return; // not enough signal yet

      const bodies: string[] = [];
      for (const id of ids.slice(-15)) {
        const content = await this.couchSync.readFile(id);
        if (!content) continue;
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        const body = bodyMatch?.[1]?.trim();
        if (body) bodies.push(body);
      }
      if (bodies.length < 3) return;

      const profile = await this.chat(
        this.model,
        buildVoiceProfilePrompt(),
        bodies.map((b, i) => `Post ${i + 1}:\n"""${b}"""`).join('\n\n'),
        0.3,
        400,
      );
      if (!profile) return;

      const today = new Date().toISOString().split('T')[0];
      await this.couchSync.writeFile(
        VOICE_PROFILE_ID,
        `---\ntype: voice-profile\nupdated: ${today}\n---\n\n${profile}\n`,
      );
      this.logger.log('Voice profile refreshed');
    } catch (err) {
      this.logger.warn(`Voice profile refresh failed: ${(err as Error).message}`);
    }
  }

  private async buildContext(docIds: string[]): Promise<string> {
    const parts: string[] = [];
    for (const id of docIds) {
      const note = await this.loadNote(id);
      if (note) parts.push(`### ${note.title}\n${note.body.slice(0, CONTEXT_NOTE_MAX_CHARS)}`);
    }
    return parts.join('\n\n');
  }

  /** Read a note from CouchDB, strip frontmatter (keeping contact fields), return title + body. */
  private async loadNote(id: string): Promise<{ title: string; body: string } | null> {
    const content = await this.couchSync.readFile(id);
    if (!content) return null;

    const title = id.replace('.md', '').replace(/^[^/]+\//, '');
    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);

    if (id.startsWith('contacts/')) {
      const name = content.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1] || '';
      const context = content.match(/^context:\s*"?(.+?)"?\s*$/m)?.[1] || '';
      const cityMet = content.match(/^city_met:\s*"?(.+?)"?\s*$/m)?.[1] || '';
      const phone = content.match(/^phone:\s*"?(.+?)"?\s*$/m)?.[1] || '';
      const noteBody = bodyMatch?.[1]?.trim() || '';
      const meta = [name, context, cityMet, phone].filter(Boolean).join('. ');
      return { title, body: meta + (noteBody ? '\n' + noteBody : '') };
    }

    return { title, body: bodyMatch?.[1]?.trim() || content };
  }
}
