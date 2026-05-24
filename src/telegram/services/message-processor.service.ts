import { Injectable, Logger } from '@nestjs/common';
import { Markup } from 'telegraf';
import { AiService } from '../../ai/ai.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { LIFE_AREAS } from '../../shared/constants/life-areas.constant.js';
import { extractUrls } from '../../vault/utils/url-detector.util.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';
import type { ForwardMetadata } from '../../shared/interfaces/forward-metadata.interface.js';

interface ProcessOptions {
  sourceType?: 'text' | 'voice' | 'forward' | 'photo' | 'audio';
  forwardMeta?: ForwardMetadata;
  imageFileName?: string;
  audioFileName?: string;
  hintEntityType?:
    | 'note'
    | 'link'
    | 'task'
    | 'contact'
    | 'event'
    | 'music'
    | 'project';
}

@Injectable()
export class MessageProcessorService {
  private readonly logger = new Logger(MessageProcessorService.name);

  constructor(
    private readonly ai: AiService,
    private readonly vault: VaultService,
  ) {}

  async processMessage(
    ctx: BotContext,
    text: string,
    options: ProcessOptions = {},
  ): Promise<void> {
    const urls = extractUrls(text);

    // Batch links: multiple URLs in one message
    if (urls.length > 1) {
      await this.processBatchLinks(ctx, text, urls, options);
      return;
    }

    const url = urls.length > 0 ? urls[0] : undefined;

    const classification = await this.ai.classify(text);

    // Apply voice command hint
    if (options.hintEntityType) {
      classification.entityType = options.hintEntityType;
    }

    // Auto-save types: task, task_list, contact (quick mode)
    if (
      classification.entityType === 'task' ||
      classification.entityType === 'task_list'
    ) {
      const filePath = await this.vault.createFromClassification(
        text,
        classification,
        url,
        options.forwardMeta,
        undefined,
        ctx.session?.lastLocation,
      );
      const fileName =
        filePath.split('/').pop()?.replace('.md', '') || filePath;
      const itemCount = classification.items?.length;
      const typeLabel =
        classification.entityType === 'task_list'
          ? `task_list (${itemCount || '?'} items)`
          : 'task';
      this.storeLastSave(
        ctx,
        filePath,
        'inbox',
        fileName,
        classification.lifeArea,
      );
      const undoKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Undo (60s)', 'undo_save')],
      ]);
      await ctx.reply(`Saved: ${fileName}\nType: ${typeLabel}`, undoKeyboard);
      return;
    }

    if (classification.entityType === 'contact' && classification.contactData) {
      const filePath = await this.vault.createContact(
        classification.contactData,
        classification.suggestedTags,
        ctx.session?.lastLocation,
      );
      const fileName =
        filePath.split('/').pop()?.replace('.md', '') || filePath;
      this.storeLastSave(ctx, filePath, 'contacts', fileName, 'people');

      const cd = classification.contactData;
      const lines: string[] = [`*${cd.name}*`];
      if (cd.platforms) {
        for (const [platform, handle] of Object.entries(cd.platforms)) {
          lines.push(`${platform}: ${handle}`);
        }
      }
      if (cd.cityMet) lines.push(`Met: ${cd.cityMet}`);
      if (cd.context) lines.push(`Context: ${cd.context}`);

      const undoKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Undo (60s)', 'undo_save')],
      ]);
      await ctx.reply(`Contact saved\n\n${lines.join('\n')}`, {
        ...undoKeyboard,
        parse_mode: 'Markdown',
      });
      return;
    }

    // Interactive types: note, link, event — show tag keyboard
    ctx.session ??= {};
    ctx.session.pendingNote = {
      content: text,
      url,
      classification,
      selectedTags: [...classification.suggestedTags],
      selectedAreas: classification.lifeArea ? [classification.lifeArea] : [],
      sourceType: options.sourceType,
      forwardMeta: options.forwardMeta,
      imageFileName: options.imageFileName,
      audioFileName: options.audioFileName,
    };

    await this.showTagKeyboard(ctx);
  }

  async showTagKeyboard(ctx: BotContext, edit = false): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;

    const { classification, selectedTags } = pending;

    // Life area buttons (multi-select, 2 rows of 4)
    const selectedAreas = pending.selectedAreas;
    const areaButtons = LIFE_AREAS.map((area) =>
      Markup.button.callback(
        `${selectedAreas.includes(area) ? '✓' : '○'} ${area}`,
        `area:${area}`,
      ),
    );
    const areaRows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < areaButtons.length; i += 4) {
      areaRows.push(areaButtons.slice(i, i + 4));
    }

    // Tag buttons (rows of 2)
    const tagButtons = classification.suggestedTags.map((tag) => {
      const isSelected = selectedTags.includes(tag);
      return Markup.button.callback(
        `${isSelected ? '✓' : '○'} ${tag}`,
        `tag:${tag}`,
      );
    });
    const tagRows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < tagButtons.length; i += 2) {
      tagRows.push(tagButtons.slice(i, i + 2));
    }

    const keyboard = Markup.inlineKeyboard([
      ...areaRows,
      ...tagRows,
      [
        Markup.button.callback('+ Add tag', 'add_tag'),
        Markup.button.callback('Quick Save', 'quick_save'),
        Markup.button.callback('Save', 'save_note'),
        Markup.button.callback('Cancel', 'cancel'),
      ],
    ]);

    const areasDisplay = selectedAreas.length > 0 ? selectedAreas.join(', ') : '?';
    const text =
      `${classification.entityType} | ${areasDisplay}\n` +
      `Title: ${classification.title}\n\n` +
      `Select areas & tags:`;

    if (edit) {
      await ctx.editMessageText(text, keyboard);
    } else {
      await ctx.reply(text, keyboard);
    }
  }

  private async processBatchLinks(
    ctx: BotContext,
    text: string,
    urls: string[],
    options: ProcessOptions,
  ): Promise<void> {
    // Classify once for shared tags/area
    const classification = await this.ai.classify(text);
    const savedFiles: string[] = [];

    for (const url of urls) {
      const singleClassification = {
        ...classification,
        entityType: 'link' as const,
      };
      const filePath = await this.vault.createFromClassification(
        url,
        singleClassification,
        url,
        options.forwardMeta,
        undefined,
        ctx.session?.lastLocation,
      );
      const fileName =
        filePath.split('/').pop()?.replace('.md', '') || filePath;
      savedFiles.push(fileName);
    }

    await ctx.reply(
      `Saved ${savedFiles.length} links:\n${savedFiles.map((f) => `- ${f}`).join('\n')}`,
    );
  }

  buildConfirmation(
    fileName: string,
    entityType: string,
    lifeArea: string | undefined,
    tags: string[],
  ): string {
    const tagsStr =
      tags.length > 0 ? `\nTags: ${tags.map((t) => `#${t}`).join(' ')}` : '';
    return (
      `Saved: ${fileName}` +
      `\nType: ${entityType}` +
      (lifeArea ? `\nArea: ${lifeArea}` : '') +
      tagsStr
    );
  }

  storeLastSave(
    ctx: BotContext,
    filePath: string,
    folder: string,
    fileName: string,
    lifeArea?: string,
  ): void {
    ctx.session ??= {};
    ctx.session.lastSave = {
      filePath,
      folder,
      fileName,
      lifeArea,
      timestamp: Date.now(),
    };
  }
}
