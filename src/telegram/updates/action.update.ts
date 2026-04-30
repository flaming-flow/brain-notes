import { Logger, UseGuards } from '@nestjs/common';
import { Update, Action, Ctx } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { TextUpdate } from './text.update.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

@Update()
@UseGuards(AuthGuard)
export class ActionUpdate {
  private readonly logger = new Logger(ActionUpdate.name);

  constructor(
    private readonly processor: MessageProcessorService,
    private readonly vault: VaultService,
    private readonly writer: VaultWriterService,
    private readonly textUpdate: TextUpdate,
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
      [Markup.button.callback('Skip', 'contact_skip')],
    ]);
    await ctx.reply('Where/how met? (e.g. "Bali, ecstatic dance")', keyboard);
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
