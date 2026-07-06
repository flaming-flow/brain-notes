import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx, Message } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { VaultReaderService } from '../../vault/vault-reader.service.js';
import { CommandUpdate } from './command.update.js';
import { ContentAgentService } from '../../content/content-agent.service.js';
import type { ThreadsFormat } from '../../content/prompts/threads.prompt.js';
import { CouchDBSyncService } from '../../couchdb/couchdb-sync.service.js';
import { findSimilarTags } from '../utils/tag-similarity.util.js';
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
    private readonly reader: VaultReaderService,
    private readonly commandUpdate: CommandUpdate,
    private readonly contentAgent: ContentAgentService,
    private readonly couchSync: CouchDBSyncService,
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
    if (text === 'Met someone') {
      ctx.session ??= {} as BotContext['session'];
      ctx.session.pendingContact = { step: 'name', name: '', platforms: {} };
      await ctx.reply('Name of the person you met:');
      return;
    }
    if (text === 'Event') {
      await ctx.reply('Describe the event (name, date, place):');
      ctx.session ??= {} as BotContext['session'];
      ctx.session.templateHint = 'event';
      return;
    }
    if (text === 'Idea') {
      await ctx.reply('What\'s on your mind?');
      ctx.session ??= {} as BotContext['session'];
      ctx.session.templateHint = 'note';
      return;
    }

    this.logger.log(`Received: "${text.slice(0, 50)}..."`);

    try {
      // 0. Unpacker answers before first generation
      if (ctx.session?.contentGen?.awaitingUnpackAnswers) {
        await this.commandUpdate.runGeneration(ctx, text);
        return;
      }

      // 0b. Content regeneration with feedback
      if (ctx.session?.contentGen?.awaitingRegenPrompt) {
        await this.handleRegenFeedback(ctx, text);
        return;
      }

      // 1a. Music title input
      if (ctx.session?.pendingMusic?.awaitingTitle) {
        ctx.session.pendingMusic.awaitingTitle = false;
        ctx.session.pendingMusic.title = text.trim();
        ctx.session.pendingMusic.awaitingDescription = true;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('Skip', 'music_skip_desc')],
        ]);
        await ctx.reply(`Title: ${text.trim()}\n\nAdd a description?`, keyboard);
        return;
      }

      // 1b. Music description input
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

      // 3b. Waiting for tag-picker search filter
      if (ctx.session?.pendingNote?.waitingForTagSearch) {
        const pending = ctx.session.pendingNote;
        pending.waitingForTagSearch = false;
        pending.tagSearchQuery = text.trim();
        pending.tagPickerPage = 0;
        await this.processor.renderTagPicker(ctx, false);
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

      // 6. Template hint from quick buttons
      const hintEntityType = ctx.session?.templateHint;
      if (hintEntityType) {
        ctx.session.templateHint = undefined;
      }

      // 7. Detect forwarded message
      const forwardMeta = this.extractForwardMeta(ctx);

      // 8. Process normally
      await this.processor.processMessage(ctx, text, {
        sourceType: forwardMeta ? 'forward' : 'text',
        forwardMeta,
        hintEntityType,
      });
    } catch (error) {
      this.logger.error(`Error processing message: ${error}`);
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async handleMusicDescription(ctx: BotContext, text: string): Promise<void> {
    const pending = ctx.session.pendingMusic!;
    const audioFileName = pending.audioFileName;
    const title = pending.title || text.slice(0, 50);
    ctx.session.pendingMusic = undefined;

    ctx.session.pendingNote = {
      content: text,
      classification: {
        entityType: 'music',
        title,
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
      selectedAreas: ['music'],
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

    if (!newTag || pending.selectedTags.includes(newTag)) {
      await this.processor.showTagKeyboard(ctx);
      return;
    }

    // Warn if the typed tag looks like an existing one (avoid duplicates)
    const vocab = await this.reader.getTagVocabulary();
    const similar = findSimilarTags(
      newTag,
      vocab.map((v) => v.tag),
      pending.selectedTags,
    ).filter((t) => Buffer.byteLength(`usetag:${t}`) <= 64).slice(0, 3);

    if (similar.length > 0) {
      pending.pendingNewTag = newTag;
      const rows = similar.map((t) => [Markup.button.callback(`Use #${t}`, `usetag:${t}`)]);
      rows.push([Markup.button.callback(`Keep «${newTag}»`, 'keep_new_tag')]);
      await ctx.reply(
        `«${newTag}» looks similar to tags you already use. Reuse one to keep links clean?`,
        Markup.inlineKeyboard(rows),
      );
      return;
    }

    pending.selectedTags.push(newTag);
    pending.classification.suggestedTags.push(newTag);
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
      [
        Markup.button.callback('Done >', 'contact_done'),
        Markup.button.callback('Cancel', 'cancel'),
      ],
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

    const filePath = await this.vault.createContact(contactData, [], ctx.session?.lastLocation);
    const fileName = filePath.split('/').pop()?.replace('.md', '') || filePath;

    ctx.session.pendingContact = undefined;
    this.processor.storeLastSave(ctx, filePath, 'contacts', fileName, 'people');

    const lines: string[] = [`*${contact.name}*`];
    if (contact.phone) lines.push(`Phone: ${contact.phone}`);
    for (const [platform, handle] of Object.entries(contact.platforms)) {
      lines.push(`${platform}: ${handle}`);
    }
    if (contact.cityMet) lines.push(`Met: ${contact.cityMet}`);
    if (contact.context) lines.push(`Context: ${contact.context}`);

    const undoKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Undo (60s)', 'undo_save')],
    ]);

    await ctx.reply(`Contact saved\n\n${lines.join('\n')}`, { ...undoKeyboard, parse_mode: 'Markdown' });
  }

  private async handleReplyAppend(ctx: BotContext, text: string): Promise<boolean> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const replyTo = message?.reply_to_message as unknown as Record<string, unknown> | undefined;
    if (!replyTo) return false;

    // Extract note name from replied message text ("Saved: filename\n...")
    const replyText = (replyTo.text as string) || '';
    const savedMatch = replyText.match(/Saved:\s*(.+?)(?:\n|$)/);

    let filePath: string | undefined;
    let fileName: string | undefined;

    if (savedMatch) {
      // Found "Saved: filename" in replied message — find this note
      fileName = savedMatch[1].trim();
      // Search in common folders
      for (const folder of ['inbox', 'contacts', 'projects']) {
        const docId = `${folder}/${fileName}.md`;
        const content = await this.couchSync.readFile(docId);
        if (content) {
          filePath = docId;
          break;
        }
      }
    }

    if (!filePath || !fileName) {
      await ctx.reply('Note not found. Reply to a "Saved: ..." message to edit.');
      return true;
    }

    ctx.session ??= {} as BotContext['session'];
    ctx.session.pendingEdit = { text, filePath, fileName };

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Append', 'edit_append'),
        Markup.button.callback('Replace', 'edit_replace'),
        Markup.button.callback('Cancel', 'cancel'),
      ],
    ]);

    await ctx.reply(`"${fileName}"\n\nAppend or replace body?`, keyboard);
    return true;
  }

  private async handleRegenFeedback(ctx: BotContext, text: string): Promise<void> {
    const gen = ctx.session.contentGen!;
    gen.awaitingRegenPrompt = false;

    await ctx.reply('Regenerating...');

    const instruction = text.toLowerCase() === 'ok'
      ? 'Write a fresh variant of the current post — same meaning and topic, different wording and angle.'
      : text;

    gen.messages.push({ role: 'user', content: instruction });

    const post = await this.contentAgent.refine(
      gen.systemPrompt,
      gen.messages,
      gen.format as ThreadsFormat,
    );
    if (!post) {
      await ctx.reply('Failed to regenerate. Try again.');
      return;
    }

    gen.messages.push({ role: 'assistant', content: post });
    gen.currentPost = post;
    await this.commandUpdate.replyWithPost(ctx, post, gen.sources);
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
