import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

interface ParsedTemplate {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Reads .md templates from vault/templates/ and renders notes
 * by filling frontmatter values and body content.
 *
 * Single source of truth: the same .md files are used by
 * Obsidian (Ctrl+T) and by the bot (programmatic creation).
 */
@Injectable()
export class TemplateService implements OnModuleInit {
  private readonly logger = new Logger(TemplateService.name);
  private readonly templatesPath: string;
  private readonly templates = new Map<string, ParsedTemplate>();

  constructor(private readonly config: ConfigService) {
    const basePath = this.config.getOrThrow<string>('vault.basePath');
    this.templatesPath = path.join(basePath, 'templates');
  }

  async onModuleInit(): Promise<void> {
    await this.loadTemplates();
  }

  async loadTemplates(): Promise<void> {
    try {
      const files = await fs.readdir(this.templatesPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const content = await fs.readFile(
          path.join(this.templatesPath, file),
          'utf-8',
        );
        const parsed = this.parseTemplate(content);
        if (parsed) {
          const type = String(parsed.frontmatter.type || '');
          if (type) {
            this.templates.set(type, parsed);
            this.logger.log(`Loaded template: ${file} (type: ${type})`);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to load templates: ${error}`);
    }
  }

  /**
   * Render a note from a .md template.
   *
   * @param type - entity type (note, task, project, etc.)
   * @param data - frontmatter values to fill in
   * @param content - body content to insert
   * @param bodyTransform - optional function to transform the template body
   */
  render(
    type: string,
    data: Record<string, unknown>,
    content?: string,
    bodyTransform?: (templateBody: string, content: string) => string,
  ): string {
    const template = this.templates.get(type);

    // Merge template frontmatter with provided data
    const frontmatter = template
      ? { ...template.frontmatter, ...data }
      : { type, ...data };

    // Remove Obsidian template variables from values
    for (const [key, value] of Object.entries(frontmatter)) {
      if (typeof value === 'string' && value.includes('{{')) {
        (frontmatter as Record<string, unknown>)[key] = null;
      }
    }

    const yamlStr = yaml.dump(frontmatter, { flowLevel: 1 });

    let body: string;
    if (bodyTransform && template) {
      body = bodyTransform(template.body, content || '');
    } else if (content) {
      body = content;
    } else if (template) {
      body = template.body;
    } else {
      body = '';
    }

    return `---\n${yamlStr}---\n\n${body}\n`;
  }

  private parseTemplate(raw: string): ParsedTemplate | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;

    try {
      const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
      const body = match[2].trim();
      return { frontmatter, body };
    } catch {
      return null;
    }
  }
}
