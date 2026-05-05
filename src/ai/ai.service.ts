import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ClassificationResult } from './dto/classification-result.dto.js';
import { buildClassifyPrompt } from './prompts/classify.prompt.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly vaultPath: string;

  constructor(private readonly config: ConfigService) {
    const provider = this.config.get<string>('ai.provider', 'openai');

    if (provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
      });
      this.model = this.config.get<string>('ai.openai.model', 'gpt-4o-mini');
    } else {
      this.openai = new OpenAI({
        apiKey: this.config.getOrThrow<string>('ai.anthropic.apiKey'),
        baseURL: 'https://api.anthropic.com/v1/',
      });
      this.model = this.config.get<string>('ai.anthropic.model', 'claude-haiku-4-5-20241022');
    }

    this.vaultPath = this.config.getOrThrow<string>('vault.basePath');
  }

  async classify(text: string): Promise<ClassificationResult> {
    try {
      const [noteTitles, usedTags] = await Promise.all([
        this.getExistingNoteTitles(),
        this.getUsedTags(),
      ]);
      const systemPrompt = buildClassifyPrompt(noteTitles, usedTags);

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        max_tokens: 500,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty AI response');

      const raw = JSON.parse(content);
      const validTypes = ['note', 'link', 'task', 'task_list', 'contact', 'event', 'music', 'project'];
      const parsed: ClassificationResult = {
        entityType: validTypes.includes(raw.entityType) ? raw.entityType : 'note',
        title: String(raw.title || 'untitled'),
        suggestedTags: Array.isArray(raw.suggestedTags) ? raw.suggestedTags : [],
        lifeArea: String(raw.lifeArea || ''),
        confidence: Number(raw.confidence) || 0,
        dueDate: raw.dueDate || undefined,
        priority: ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : undefined,
        recurrence: raw.recurrence || undefined,
        items: Array.isArray(raw.items) ? raw.items.filter((i: unknown) => typeof i === 'string') : undefined,
        contactData: raw.contactData && typeof raw.contactData === 'object' ? {
          name: String(raw.contactData.name || ''),
          context: raw.contactData.context ? String(raw.contactData.context) : undefined,
          platforms: typeof raw.contactData.platforms === 'object' && raw.contactData.platforms !== null
            ? raw.contactData.platforms as Record<string, string>
            : undefined,
          cityMet: raw.contactData.cityMet ? String(raw.contactData.cityMet) : undefined,
        } : undefined,
        eventData: raw.eventData && typeof raw.eventData === 'object' ? {
          eventName: String(raw.eventData.eventName || ''),
          date: raw.eventData.date ? String(raw.eventData.date) : undefined,
          location: raw.eventData.location ? String(raw.eventData.location) : undefined,
          organizer: raw.eventData.organizer ? String(raw.eventData.organizer) : undefined,
        } : undefined,
        musicData: raw.musicData && typeof raw.musicData === 'object' ? {
          hasAudio: Boolean(raw.musicData.hasAudio),
          audioFileName: raw.musicData.audioFileName ? String(raw.musicData.audioFileName) : undefined,
          description: raw.musicData.description ? String(raw.musicData.description) : undefined,
        } : undefined,
        projectData: raw.projectData && typeof raw.projectData === 'object' ? {
          goal: String(raw.projectData.goal || ''),
          actionPlan: Array.isArray(raw.projectData.actionPlan)
            ? raw.projectData.actionPlan.filter((i: unknown) => typeof i === 'string')
            : undefined,
          lifeAreas: Array.isArray(raw.projectData.lifeAreas)
            ? raw.projectData.lifeAreas.filter((i: unknown) => typeof i === 'string')
            : undefined,
        } : undefined,
      };
      this.logger.log(`Classified as ${parsed.entityType} [${parsed.lifeArea}]: ${parsed.title}`);
      return parsed;
    } catch (error) {
      this.logger.warn(`Classification failed, defaulting to idea: ${error}`);
      return this.fallback(text);
    }
  }

  async polish(text: string): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a text editor. Clean up the transcribed speech:\n' +
            '- Remove filler words (типа, короче, ну, как бы, вот, это самое, блин, в общем, то есть)\n' +
            '- Fix grammar and punctuation\n' +
            '- Keep the original meaning and tone\n' +
            '- Keep the same language (Russian/English)\n' +
            '- Do NOT add new information or change the meaning\n' +
            '- Do NOT add any commentary, just return the cleaned text',
        },
        { role: 'user', content: text },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || text;
  }

  private fallback(text: string): ClassificationResult {
    const title = text.replace(/https?:\/\/\S+/g, '').trim().slice(0, 40) || 'untitled';
    return {
      entityType: 'note',
      title,
      suggestedTags: [],
      lifeArea: '',
      confidence: 0,
    };
  }

  private async getExistingNoteTitles(): Promise<string[]> {
    const titles: string[] = [];
    for (const dir of ['inbox', 'contacts', 'projects']) {
      const dirPath = path.join(this.vaultPath, dir);
      try {
        const files = await fs.readdir(dirPath);
        for (const file of files) {
          if (file.endsWith('.md')) {
            titles.push(file.replace('.md', ''));
          }
        }
      } catch {
        // Directory may not exist yet
      }
    }
    return titles;
  }

  private async getUsedTags(): Promise<string[]> {
    const tagSet = new Set<string>();
    const dirPath = path.join(this.vaultPath, 'inbox');
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files.slice(-30)) {
        // Scan last 30 notes for performance
        if (!file.endsWith('.md')) continue;
        const content = await fs.readFile(path.join(dirPath, file), 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (match?.[1]) {
          const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
          if (Array.isArray(frontmatter?.tags)) {
            for (const tag of frontmatter.tags) {
              if (typeof tag === 'string') tagSet.add(tag);
            }
          }
        }
      }
    } catch {
      // Directory may not exist
    }
    return [...tagSet];
  }
}
