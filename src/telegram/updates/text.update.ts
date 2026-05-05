import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx, Message } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { CommandUpdate } from './command.update.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';
import type { ForwardMetadata } from '../../shared/interfaces/forward-metadata.interface.js';

@Update()
@UseGuards(AuthGuard)
export class TextUpdate {
  private readonly logger = new Logger(TextUpdate.name);

  constructor(
    private readonly processor: MessageProcessorService,
    private readonly vault: VaultService,
    private readonly writer: VaultWriterService,
    private readonly commandUpdate: CommandUpdate,
  ) {}

  @On('text')
  async onText(
    @Ctx() ctx: BotContext,
    @Message('text') text: string,
  ): Promise<void> {
    if (text.startsWith('/')) return;

    // Handle persistent keyboard buttons
    if (text === '+ Contact') {
      ctx.session ??= {} as BotContext['session'];
      ctx.session.pendingContact = {
        step: 'name',
        name: '',
        platforms: {},
      };
      await ctx.reply('Введи имя контакта:');
      return;
    }
    if (text === 'Contacts') {
      await this.commandUpdate.showContactsPage(ctx, 0);
      return;
    }
    if (text === 'Music') {
      ctx.session ??= {} as BotContext['session'];
      ctx.session.pendingMusic = { awaitingAudio: true };
      await ctx.reply('Send audio for your music idea.');
      return;
    }

    this.logger.log(`Received: "${text.slice(0, 50)}..."`);

    try {
      // 1. Music description input
      if (ctx.session?.pendingMusic?.awaitingDescription) {
        await this.handleMusicDescription(ctx, text);
        return;
      }

      // 2. Voice transcription edit in progress
      if (ctx.session?.pendingVoice?.waitingForEdit) {
        await this.handleVoiceEdit(ctx, text);
        return;
      }

      // 3. Contact wizard in progress
      if (ctx.session?.pendingContact) {
        await this.handleContactWizardStep(ctx, text);
        return;
      }

      // 4. Waiting for custom tag input
      if (ctx.session?.pendingNote?.waitingForCustomTag) {
        await this.handleCustomTag(ctx, text);
        return;
      }

      // 5. Reply to bot message -> append to last save
      if (await this.handleReplyAppend(ctx, text)) {
        return;
      }

      // 6. Detect forwarded message
      const forwardMeta = this.extractForwardMeta(ctx);

      // 7. Process normally
      await this.processor.processMessage(ctx, text, {
        sourceType: forwardMeta ? 'forward' : 'text',
        forwardMeta,
      });
    } catch (error) {
      this.logger.error(`Error processing message: ${error}`);
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async handleMusicDescription(ctx: BotContext, text: string): Promise<void> {
    const pending = ctx.session.pendingMusic!;
    const audioFileName = pending.audioFileName;
    ctx.session.pendingMusic = undefined;

    ctx.session.pendingNote = {
      content: text,
      classification: {
        entityType: 'music',
        title: text.slice(0, 50),
        suggestedTags: ['sketch'],
        lifeArea: 'music',
        confidence: 0.8,
        musicData: {
          hasAudio: !!audioFileName,
          audioFileName,
          description: text,
        },
      },
      selectedTags: ['sketch'],
      sourceType: 'audio',
    };

    await this.processor.showTagKeyboard(ctx);
  }

  private async handleVoiceEdit(ctx: BotContext, text: string): Promise<void> {
    const pending = ctx.session.pendingVoice!;
    const { hintEntityType } = pending;
    ctx.session.pendingVoice = undefined;

    await this.processor.processMessage(ctx, text, {
      sourceType: 'voice',
      hintEntityType,
    });
  }

  private async handleCustomTag(ctx: BotContext, text: string): Promise<void> {
    const pending = ctx.session.pendingNote!;
    const newTag = text.toLowerCase().trim().replace(/\s+/g, '-');
    pending.waitingForCustomTag = false;

    if (!pending.selectedTags.includes(newTag)) {
      pending.selectedTags.push(newTag);
    }
    if (!pending.classification.suggestedTags.includes(newTag)) {
      pending.classification.suggestedTags.push(newTag);
    }

    await this.processor.showTagKeyboard(ctx);
  }

  private async handleContactWizardStep(ctx: BotContext, text: string): Promise<void> {
    const contact = ctx.session.pendingContact!;
    const input = text.trim();

    switch (contact.step) {
      case 'name':
        contact.name = input;
        contact.step = 'phone';
        await ctx.reply(
          `Contact: ${input}\n\nPhone number?`,
          Markup.inlineKeyboard([[Markup.button.callback('Skip', 'contact_skip')]]),
        );
        break;

      case 'phone':
        contact.phone = input;
        contact.step = 'platforms';
        await this.showPlatformButtons(ctx);
        break;

      case 'platform_handle': {
        const handle = this.normalizeHandle(input, contact.currentPlatform);
        if (contact.currentPlatform) {
          contact.platforms[contact.currentPlatform] = handle;
        }
        contact.currentPlatform = undefined;
        contact.step = 'platforms';
        await this.showPlatformButtons(ctx);
        break;
      }

      case 'context_city': {
        // Parse "city, context" or just context
        const parts = input.split(',').map(s => s.trim());
        if (parts.length >= 2) {
          contact.cityMet = parts[0];
          contact.context = parts.slice(1).join(', ');
        } else {
          contact.context = input;
        }
        await this.saveContact(ctx);
        break;
      }

      default:
        await this.saveContact(ctx);
    }
  }

  private async showPlatformButtons(ctx: BotContext): Promise<void> {
    const contact = ctx.session.pendingContact!;
    const added = Object.keys(contact.platforms);

    // Build summary of what's been added
    const lines: string[] = [`Contact: ${contact.name}`];
    if (contact.phone) lines.push(`Phone: ${contact.phone}`);
    for (const [platform, handle] of Object.entries(contact.platforms)) {
      lines.push(`${platform}: ${handle}`);
    }

    // Build platform buttons
    const buttons: ReturnType<typeof Markup.button.callback>[] = [];

    if (!added.includes('telegram')) {
      // If phone exists, offer quick "TG = this number" option
      if (contact.phone) {
        buttons.push(Markup.button.callback('TG = phone', 'contact_tg_phone'));
        buttons.push(Markup.button.callback('TG @', 'contact_platform:telegram'));
      } else {
        buttons.push(Markup.button.callback('Telegram', 'contact_platform:telegram'));
      }
    }
    if (!added.includes('instagram')) {
      buttons.push(Markup.button.callback('Instagram', 'contact_platform:instagram'));
    }
    if (!added.includes('whatsapp')) {
      // If phone exists, offer quick "WA = phone" option
      if (contact.phone) {
        buttons.push(Markup.button.callback('WA = phone', 'contact_wa_phone'));
      } else {
        buttons.push(Markup.button.callback('WhatsApp', 'contact_platform:whatsapp'));
      }
    }

    // Split buttons into rows of 2-3
    const buttonRows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < buttons.length; i += 3) {
      buttonRows.push(buttons.slice(i, i + 3));
    }

    const keyboard = Markup.inlineKeyboard([
      ...buttonRows,
      [Markup.button.callback('Done >', 'contact_done')],
    ]);

    await ctx.reply(`${lines.join('\n')}\n\nAdd socials:`, keyboard);
  }

  async saveContact(ctx: BotContext): Promise<void> {
    const contact = ctx.session.pendingContact!;

    const contactData = {
      name: contact.name,
      phone: contact.phone,
      context: contact.context,
      platforms: contact.platforms,
      cityMet: contact.cityMet,
    };

    const filePath = await this.vault.createContact(contactData, []);
    const fileName = filePath.split('/').pop()?.replace('.md', '') || filePath;

    ctx.session.pendingContact = undefined;
    this.processor.storeLastSave(ctx, filePath, 'contacts', fileName, 'people');

    await ctx.reply(`Contact saved: ${fileName}`);
  }

  private async handleReplyAppend(ctx: BotContext, text: string): Promise<boolean> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const replyTo = message?.reply_to_message as unknown as Record<string, unknown> | undefined;
    if (!replyTo) return false;

    const lastSave = ctx.session?.lastSave;
    if (!lastSave) return false;

    // Only allow append within 10 minutes
    if (Date.now() - lastSave.timestamp > 10 * 60 * 1000) return false;

    try {
      await this.writer.appendToFile(lastSave.filePath, text);
      await ctx.reply(`Appended to: ${lastSave.fileName}`);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to append: ${error}`);
      return false;
    }
  }

  private normalizeHandle(input: string, platform?: string): string {
    // Extract username from URL
    const igMatch = input.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)/i);
    if (igMatch) return `@${igMatch[1]}`;

    const tgMatch = input.match(/(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)/i);
    if (tgMatch) return `@${tgMatch[1]}`;

    // Clean up: ensure @ prefix for usernames
    const cleaned = input.trim().replace(/^https?:\/\//, '');
    if (cleaned.startsWith('@')) return cleaned;
    return `@${cleaned}`;
  }

  private extractForwardMeta(ctx: BotContext): ForwardMetadata | undefined {
    const message = ctx.message as unknown as Record<string, unknown>;

    const forwardFrom = message?.forward_from as unknown as Record<string, unknown> | undefined;
    const forwardFromChat = message?.forward_from_chat as unknown as Record<string, unknown> | undefined;
    const forwardSenderName = message?.forward_sender_name as string | undefined;
    const forwardDate = message?.forward_date as number | undefined;

    const dateStr = forwardDate
      ? new Date(forwardDate * 1000).toISOString().split('T')[0]
      : undefined;

    if (forwardFromChat) {
      const title = forwardFromChat.title as string | undefined;
      const username = forwardFromChat.username as string | undefined;
      const chatType = forwardFromChat.type as string | undefined;
      return {
        sourceName: title || 'Unknown channel',
        sourceType: chatType === 'channel' ? 'channel' : 'group',
        sourceUsername: username ? `@${username}` : undefined,
        forwardDate: dateStr,
      };
    }

    if (forwardFrom) {
      const firstName = forwardFrom.first_name as string | undefined;
      const lastName = forwardFrom.last_name as string | undefined;
      const username = forwardFrom.username as string | undefined;
      const name = [firstName, lastName].filter(Boolean).join(' ');
      return {
        sourceName: name || 'Unknown user',
        sourceType: 'user',
        sourceUsername: username ? `@${username}` : undefined,
        forwardDate: dateStr,
      };
    }

    if (forwardSenderName) {
      return {
        sourceName: forwardSenderName,
        sourceType: 'hidden',
        forwardDate: dateStr,
      };
    }

    return undefined;
  }
}
