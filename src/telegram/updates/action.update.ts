import { Logger, UseGuards } from '@nestjs/common';
import { Update, Action, Ctx } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { AiService } from '../../ai/ai.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { VaultReaderService } from '../../vault/vault-reader.service.js';
import { CouchDBSyncService } from '../../couchdb/couchdb-sync.service.js';
import { TextUpdate } from './text.update.js';
import { CommandUpdate } from './command.update.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

@Update()
@UseGuards(AuthGuard)
export class ActionUpdate {
  private readonly logger = new Logger(ActionUpdate.name);

  constructor(
    private readonly processor: MessageProcessorService,
    private readonly ai: AiService,
    private readonly vault: VaultService,
    private readonly writer: VaultWriterService,
    private readonly reader: VaultReaderService,
    private readonly couchSync: CouchDBSyncService,
    private readonly textUpdate: TextUpdate,
    private readonly commandUpdate: CommandUpdate,
  ) {}

  @Action(/^tag:(.+)$/)
  async onTagToggle(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;

    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const tag = callbackData?.replace('tag:', '');
    if (!tag) return;

    const idx = pending.selectedTags.indexOf(tag);
    if (idx >= 0) {
      pending.selectedTags.splice(idx, 1);
    } else {
      pending.selectedTags.push(tag);
    }

    await ctx.answerCbQuery();
    await this.processor.showTagKeyboard(ctx, true);
  }

  @Action(/^area:(.+)$/)
  async onAreaSelect(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;

    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const area = callbackData?.replace('area:', '');
    if (!area) return;

    pending.classification.lifeArea = area;

    await ctx.answerCbQuery(area);
    await this.processor.showTagKeyboard(ctx, true);
  }

  @Action('add_tag')
  async onAddTag(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session?.pendingNote) return;
    ctx.session.pendingNote.waitingForCustomTag = true;
    await ctx.answerCbQuery();
    await ctx.reply('Type your custom tag:');
  }

  @Action('quick_save')
  async onQuickSave(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    // Use AI-suggested tags as-is
    pending.selectedTags = [...pending.classification.suggestedTags];
    await this.onSave(ctx);
  }

  @Action('save_note')
  async onSave(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;

    try {
      pending.classification.suggestedTags = pending.selectedTags;

      const filePath = await this.vault.createFromClassification(
        pending.content,
        pending.classification,
        pending.url,
        pending.forwardMeta,
        pending.imageFileName,
        ctx.session?.lastLocation,
      );

      const fileName = filePath.split('/').pop()?.replace('.md', '') || filePath;
      const folder = pending.classification.entityType === 'contact' ? 'contacts'
        : pending.classification.entityType === 'project' ? 'projects'
        : 'inbox';

      const confirmText = this.processor.buildConfirmation(
        fileName,
        pending.classification.entityType,
        pending.classification.lifeArea,
        pending.selectedTags,
      );

      this.processor.storeLastSave(
        ctx, filePath, folder, fileName, pending.classification.lifeArea,
      );
      ctx.session.pendingNote = undefined;

      const undoKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Undo (60s)', 'undo_save')],
      ]);

      await ctx.answerCbQuery('Saved!');
      await ctx.editMessageText(confirmText, undoKeyboard);
    } catch (error) {
      this.logger.error(`Error saving: ${error}`);
      await ctx.answerCbQuery('Error saving');
    }
  }

  // --- Contact wizard actions ---

  @Action('contact_skip')
  async onContactSkip(@Ctx() ctx: BotContext): Promise<void> {
    const contact = ctx.session?.pendingContact;
    if (!contact) return;
    await ctx.answerCbQuery();

    switch (contact.step) {
      case 'phone':
        contact.step = 'platforms';
        await (this.textUpdate as any).showPlatformButtons(ctx);
        break;
      case 'platforms':
      case 'context_city':
        await (this.textUpdate as any).saveContact(ctx);
        break;
    }
  }

  @Action('contact_tg_phone')
  async onContactTgPhone(@Ctx() ctx: BotContext): Promise<void> {
    const contact = ctx.session?.pendingContact;
    if (!contact?.phone) return;
    contact.platforms.telegram = contact.phone;
    await ctx.answerCbQuery('Telegram = phone');
    await (this.textUpdate as any).showPlatformButtons(ctx);
  }

  @Action('contact_wa_phone')
  async onContactWaPhone(@Ctx() ctx: BotContext): Promise<void> {
    const contact = ctx.session?.pendingContact;
    if (!contact?.phone) return;
    contact.platforms.whatsapp = contact.phone;
    await ctx.answerCbQuery('WhatsApp = phone');
    await (this.textUpdate as any).showPlatformButtons(ctx);
  }

  @Action(/^contact_platform:(.+)$/)
  async onContactPlatform(@Ctx() ctx: BotContext): Promise<void> {
    const contact = ctx.session?.pendingContact;
    if (!contact) return;

    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const platform = callbackData?.replace('contact_platform:', '');
    if (!platform) return;

    contact.currentPlatform = platform;
    contact.step = 'platform_handle';
    await ctx.answerCbQuery();

    const label = platform.charAt(0).toUpperCase() + platform.slice(1);
    await ctx.reply(`${label} @username:`);
  }

  @Action('contact_done')
  async onContactDone(@Ctx() ctx: BotContext): Promise<void> {
    const contact = ctx.session?.pendingContact;
    if (!contact) return;
    await ctx.answerCbQuery();

    contact.step = 'context_city';
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Skip', 'contact_skip'),
        Markup.button.callback('Cancel', 'cancel'),
      ],
    ]);
    await ctx.reply('Where/how met? (e.g. "Bali, ecstatic dance")', keyboard);
  }

  // --- Edit actions (append/replace on reply) ---

  @Action('edit_append')
  async onEditAppend(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingEdit;
    if (!pending) return;

    await ctx.answerCbQuery();
    try {
      await this.writer.appendToFile(pending.filePath, pending.text);
      ctx.session.pendingEdit = undefined;
      await ctx.editMessageText(`Appended to: ${pending.fileName}`);
    } catch (err) {
      this.logger.error(`Append failed: ${err}`);
      await ctx.editMessageText('Append failed.');
    }
  }

  @Action('edit_replace')
  async onEditReplace(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingEdit;
    if (!pending) return;

    await ctx.answerCbQuery();
    try {
      // Read existing file, keep frontmatter, replace body
      const existing = await this.couchSync.readFile(pending.filePath);
      if (!existing) {
        await ctx.editMessageText('Note not found.');
        return;
      }

      const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n)/);
      const frontmatter = fmMatch?.[1] || '';
      const newContent = frontmatter + '\n' + pending.text + '\n';

      await this.couchSync.writeFile(pending.filePath, newContent);
      ctx.session.pendingEdit = undefined;
      await ctx.editMessageText(`Replaced body of: ${pending.fileName}`);
    } catch (err) {
      this.logger.error(`Replace failed: ${err}`);
      await ctx.editMessageText('Replace failed.');
    }
  }

  // --- Search result view ---

  @Action(/^view_note:(.+)$/)
  async onViewNote(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const docId = callbackData?.replace('view_note:', '');
    if (!docId) return;

    await ctx.answerCbQuery();

    const content = await this.couchSync.readFile(docId);
    if (!content) {
      await ctx.editMessageText('Note not found.');
      return;
    }

    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch?.[1]?.trim() || content;
    const title = docId.replace('.md', '').replace(/^[^/]+\//, '');

    const display = body.length > 3500
      ? body.slice(0, 3500) + '\n\n... (truncated)'
      : body;

    // Store for edit
    ctx.session ??= {} as BotContext['session'];
    ctx.session.lastSave = {
      filePath: docId,
      folder: docId.split('/')[0] || 'inbox',
      fileName: title,
      timestamp: Date.now(),
    };

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Edit', `edit_note:${docId}`)],
    ]);

    await ctx.editMessageText(`*${title}*\n\n${display}`, { ...keyboard, parse_mode: 'Markdown' });
  }

  @Action(/^edit_note:(.+)$/)
  async onEditNote(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const docId = callbackData?.replace('edit_note:', '');
    if (!docId) return;

    await ctx.answerCbQuery();

    const fileName = docId.replace('.md', '').replace(/^[^/]+\//, '');
    ctx.session ??= {} as BotContext['session'];
    ctx.session.lastSave = {
      filePath: docId,
      folder: docId.split('/')[0] || 'inbox',
      fileName,
      timestamp: Date.now(),
    };

    await ctx.editMessageText(`Editing: ${fileName}\n\nSend new text:`);
  }

  // --- Cancel action (works for notes, contacts, voice, music) ---

  @Action('cancel')
  async onCancel(@Ctx() ctx: BotContext): Promise<void> {
    if (ctx.session) {
      ctx.session.pendingNote = undefined;
      ctx.session.pendingContact = undefined;
      ctx.session.pendingVoice = undefined;
      ctx.session.pendingMusic = undefined;
      ctx.session.pendingEdit = undefined;
    }
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('Cancelled.');
  }

  // --- Music actions ---

  @Action('music_skip_desc')
  async onMusicSkipDesc(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingMusic;
    if (!pending?.audioFileName) return;

    const audioFileName = pending.audioFileName;
    ctx.session.pendingMusic = undefined;

    await ctx.answerCbQuery();

    ctx.session.pendingNote = {
      content: '',
      classification: {
        entityType: 'music',
        title: 'music-idea',
        suggestedTags: ['sketch'],
        lifeArea: 'music',
        confidence: 0.8,
        musicData: {
          hasAudio: true,
          audioFileName,
        },
      },
      selectedTags: ['sketch'],
      sourceType: 'audio',
    };

    await this.processor.showTagKeyboard(ctx);
  }

  // --- Contacts list actions ---

  @Action(/^contacts_page:(\d+)$/)
  async onContactsPage(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const page = parseInt(callbackData?.replace('contacts_page:', '') || '0', 10);
    await ctx.answerCbQuery();
    await this.commandUpdate.showContactsPage(ctx, page, true);
  }

  @Action(/^view_contact:(.+)$/)
  async onViewContact(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const fileName = callbackData?.replace('view_contact:', '');
    if (!fileName) return;

    await ctx.answerCbQuery();

    const content = await this.reader.readContact(fileName);
    if (!content) {
      await ctx.editMessageText('Contact not found.');
      return;
    }

    const display = this.formatContactDisplay(content, fileName);

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('« Back to contacts', 'contacts_page:0')],
    ]);

    const truncated = display.length > 3500
      ? display.slice(0, 3500) + '\n\n... (truncated)'
      : display;

    await ctx.editMessageText(truncated, { ...keyboard, parse_mode: 'Markdown' });
  }

  private formatContactDisplay(content: string, fileName: string): string {
    const lines: string[] = [];

    // Extract frontmatter fields
    const name = content.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1] || fileName;
    const phone = content.match(/^phone:\s*"?(.+?)"?\s*$/m)?.[1];
    const cityMet = content.match(/^city_met:\s*"?(.+?)"?\s*$/m)?.[1];
    const dateMet = content.match(/^date_met:\s*(.+)$/m)?.[1];
    const context = content.match(/^context:\s*"?(.+?)"?\s*$/m)?.[1];
    const tags = content.match(/^tags:\s*\[(.+)\]$/m)?.[1];

    lines.push(`*${name}*`);
    if (phone) lines.push(`Phone: ${phone}`);
    if (cityMet) lines.push(`Met in: ${cityMet}`);
    if (dateMet) lines.push(`Date: ${dateMet}`);
    if (context) lines.push(`Context: ${context}`);
    if (tags) lines.push(`Tags: ${tags}`);

    // Extract body (after second ---)
    const secondDash = content.indexOf('---', 4);
    if (secondDash > 0) {
      const body = content.slice(secondDash + 3).trim();
      if (body) {
        lines.push('');
        lines.push(body);
      }
    }

    return lines.join('\n');
  }

  @Action('noop')
  async onNoop(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
  }

  // --- Voice transcription actions ---

  @Action('voice_ok')
  async onVoiceOk(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingVoice;
    if (!pending) return;

    const { text, hintEntityType } = pending;
    ctx.session.pendingVoice = undefined;

    await ctx.answerCbQuery();
    await ctx.editMessageText(`"${text}"`);

    await this.processor.processMessage(ctx, text, {
      sourceType: 'voice',
      hintEntityType,
    });
  }

  @Action('voice_polish')
  async onVoicePolish(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingVoice;
    if (!pending) return;

    await ctx.answerCbQuery('Polishing...');
    await ctx.editMessageText(`Polishing...\n"${pending.text}"`);

    try {
      const polished = await this.ai.polish(pending.text);
      pending.text = polished;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('OK', 'voice_ok'),
          Markup.button.callback('Edit', 'voice_edit'),
        ],
      ]);

      await ctx.editMessageText(`Polished:\n"${polished}"`, keyboard);
    } catch (err) {
      this.logger.error(`Polish failed: ${err}`);
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('OK', 'voice_ok'),
          Markup.button.callback('Polish', 'voice_polish'),
          Markup.button.callback('Edit', 'voice_edit'),
        ],
      ]);
      await ctx.editMessageText(`Polish failed\n"${pending.text}"`, keyboard);
    }
  }

  @Action('voice_edit')
  async onVoiceEdit(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingVoice;
    if (!pending) return;

    pending.waitingForEdit = true;
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Edit text:\n"${pending.text}"\n\nSend corrected text:`);
  }

  @Action('undo_save')
  async onUndo(@Ctx() ctx: BotContext): Promise<void> {
    const lastSave = ctx.session?.lastSave;
    if (!lastSave) {
      await ctx.answerCbQuery('Nothing to undo');
      return;
    }

    // 60 second TTL
    if (Date.now() - lastSave.timestamp > 60_000) {
      await ctx.answerCbQuery('Undo expired (>60s)');
      return;
    }

    try {
      await this.writer.deleteFile(lastSave.filePath);

      if (lastSave.lifeArea) {
        await this.writer.removeFromMoc(lastSave.lifeArea, `[[${lastSave.fileName}]]`);
      }

      ctx.session.lastSave = undefined;
      await ctx.answerCbQuery('Undone!');
      await ctx.editMessageText('Undone. Note deleted.');
    } catch (error) {
      this.logger.error(`Undo failed: ${error}`);
      await ctx.answerCbQuery('Undo failed');
    }
  }
}
