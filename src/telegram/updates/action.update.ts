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
import { ContentAgentService } from '../../content/content-agent.service.js';
import type { ThreadsFormat } from '../../content/prompts/threads.prompt.js';
import { TextUpdate } from './text.update.js';
import { CommandUpdate } from './command.update.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';
import { format } from 'date-fns';

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
    private readonly contentAgent: ContentAgentService,
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

    // Toggle area (multi-select)
    const idx = pending.selectedAreas.indexOf(area);
    if (idx >= 0) {
      pending.selectedAreas.splice(idx, 1);
    } else {
      pending.selectedAreas.push(area);
    }
    // Keep primary lifeArea as first selected
    pending.classification.lifeArea = pending.selectedAreas[0] || '';

    await ctx.answerCbQuery(area);
    await this.processor.showTagKeyboard(ctx, true);
  }

  @Action('add_tag')
  async onAddTag(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    pending.tagPickerPage = 0;
    pending.tagSearchQuery = undefined;
    await ctx.answerCbQuery();
    await this.processor.renderTagPicker(ctx, true);
  }

  @Action(/^tpick:(.+)$/)
  async onTagPick(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    const tag = (ctx.callbackQuery as { data?: string })?.data?.replace('tpick:', '');
    if (!tag) return;
    this.toggleTag(pending, tag);
    await ctx.answerCbQuery();
    await this.processor.renderTagPicker(ctx, true);
  }

  @Action(/^tpage:(\d+)$/)
  async onTagPage(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    const page = parseInt(
      (ctx.callbackQuery as { data?: string })?.data?.replace('tpage:', '') || '0',
      10,
    );
    pending.tagPickerPage = page;
    await ctx.answerCbQuery();
    await this.processor.renderTagPicker(ctx, true);
  }

  @Action('tag_search')
  async onTagSearch(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    pending.waitingForTagSearch = true;
    await ctx.answerCbQuery();
    await ctx.editMessageText('Type to filter tags:');
  }

  @Action('type_tag')
  async onTypeTag(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session?.pendingNote) return;
    ctx.session.pendingNote.waitingForCustomTag = true;
    await ctx.answerCbQuery();
    await ctx.editMessageText('Type your custom tag:');
  }

  @Action('tag_back')
  async onTagBack(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    pending.tagSearchQuery = undefined;
    pending.tagPickerPage = undefined;
    pending.waitingForTagSearch = false;
    await ctx.answerCbQuery();
    await this.processor.showTagKeyboard(ctx, true);
  }

  @Action(/^usetag:(.+)$/)
  async onUseExistingTag(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    const tag = (ctx.callbackQuery as { data?: string })?.data?.replace('usetag:', '');
    pending.pendingNewTag = undefined;
    if (tag) this.addTag(pending, tag);
    await ctx.answerCbQuery(tag ? `+${tag}` : undefined);
    await this.processor.showTagKeyboard(ctx, true);
  }

  @Action('keep_new_tag')
  async onKeepNewTag(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingNote;
    if (!pending) return;
    const tag = pending.pendingNewTag;
    pending.pendingNewTag = undefined;
    if (tag) this.addTag(pending, tag);
    await ctx.answerCbQuery();
    await this.processor.showTagKeyboard(ctx, true);
  }

  private addTag(pending: NonNullable<BotContext['session']['pendingNote']>, tag: string): void {
    if (!pending.selectedTags.includes(tag)) pending.selectedTags.push(tag);
    if (!pending.classification.suggestedTags.includes(tag)) {
      pending.classification.suggestedTags.push(tag);
    }
  }

  private toggleTag(pending: NonNullable<BotContext['session']['pendingNote']>, tag: string): void {
    const idx = pending.selectedTags.indexOf(tag);
    if (idx >= 0) {
      pending.selectedTags.splice(idx, 1);
    } else {
      this.addTag(pending, tag);
    }
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
        pending.selectedAreas,
        pending.audioFileName,
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

      // Check for mentioned people → suggest creating contacts
      const people = pending.classification.mentionedPeople;
      if (people?.length && pending.classification.entityType !== 'contact') {
        await this.suggestPeopleContacts(ctx, people, filePath);
      }
    } catch (error) {
      this.logger.error(`Error saving: ${error}`);
      await ctx.answerCbQuery('Error saving');
    }
  }

  private async suggestPeopleContacts(
    ctx: BotContext,
    people: string[],
    noteDocId: string,
  ): Promise<void> {
    for (const name of people) {
      // Check if contact already exists
      const contacts = await this.couchSync.listByPrefix('contacts/');
      const nameLower = name.toLowerCase();
      const existing = contacts.filter((c) => {
        const contactName = c.replace('contacts/', '').replace('.md', '').toLowerCase();
        return contactName.includes(nameLower) || nameLower.includes(contactName);
      });

      if (existing.length > 0) {
        // Contact exists — offer to link
        const buttons = existing.map((c) => {
          const cName = c.replace('contacts/', '').replace('.md', '');
          return [Markup.button.callback(`Link ${cName}`, `link_contact:${cName}:${noteDocId}`)];
        });
        buttons.push([Markup.button.callback(`New "${name}"`, `new_contact:${name}`)]);
        buttons.push([Markup.button.callback('Skip', 'noop')]);
        const keyboard = Markup.inlineKeyboard(buttons);
        await ctx.reply(`"${name}" mentioned. Link to existing contact or create new?`, keyboard);
      } else {
        // No contact — offer to create
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(`Add "${name}" to contacts`, `new_contact:${name}`),
            Markup.button.callback('Skip', 'noop'),
          ],
        ]);
        await ctx.reply(`"${name}" mentioned but not in contacts. Add?`, keyboard);
      }
    }
  }

  // --- People mention actions ---

  @Action(/^new_contact:(.+)$/)
  async onNewContact(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const name = callbackData?.replace('new_contact:', '') || '';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Adding ${name} to contacts...`);

    ctx.session ??= {} as BotContext['session'];
    ctx.session.pendingContact = {
      step: 'phone',
      name,
      platforms: {},
    };

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Skip', 'contact_skip'),
        Markup.button.callback('Cancel', 'cancel'),
      ],
    ]);
    await ctx.reply(`Contact: ${name}\n\nPhone number?`, keyboard);
  }

  @Action(/^link_contact:(.+):(.+)$/)
  async onLinkContact(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const match = callbackData?.match(/^link_contact:([^:]+):(.+)$/);
    if (!match) return;

    const contactName = match[1];
    const noteDocId = match[2];

    await ctx.answerCbQuery();

    // Append wikilink to the note
    const noteContent = await this.couchSync.readFile(noteDocId);
    if (noteContent && !noteContent.includes(`[[${contactName}]]`)) {
      const updated = noteContent.trimEnd() + `\n\n[[${contactName}]]\n`;
      await this.couchSync.writeFile(noteDocId, updated);
    }

    await ctx.editMessageText(`Linked [[${contactName}]] to note.`);
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

    await ctx.editMessageText(`${title}\n\n${display}`, keyboard);
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

  // --- Content generation actions ---

  @Action(/^gen_topic:\d+$/)
  async onGenTopic(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const idx = parseInt(callbackData?.replace('gen_topic:', '') || '0', 10);
    const topics = ((ctx.session as Record<string, unknown>)?.suggestedTopics as string[]) || [];
    const topic = topics[idx] || '';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Topic: ${topic}`);
    await this.commandUpdate.generateAndReply(ctx, topic);
  }

  @Action(/^gen_format:.+$/)
  async onGenFormat(@Ctx() ctx: BotContext): Promise<void> {
    const callbackData = (ctx.callbackQuery as { data?: string })?.data;
    const format = callbackData?.replace('gen_format:', '') as ThreadsFormat;
    const gen = ctx.session?.contentGen;
    if (!gen?.lastTopic) {
      await ctx.answerCbQuery('No topic');
      return;
    }
    await ctx.answerCbQuery(`Switching to ${format}...`);
    await this.commandUpdate.generateAndReply(ctx, gen.lastTopic, format);
  }

  @Action('regen_threads')
  async onRegenThreads(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
    const gen = ctx.session?.contentGen;
    if (!gen?.lastGenerated) return;

    gen.awaitingRegenPrompt = true;

    await ctx.editMessageText(
      `Current post:\n\n${gen.lastGenerated}\n\n---\nSend feedback (what to change) or "ok" to regenerate as-is:`,
    );
  }

  @Action('save_draft')
  async onSaveDraft(@Ctx() ctx: BotContext): Promise<void> {
    const gen = ctx.session?.contentGen;
    if (!gen?.lastGenerated) {
      await ctx.answerCbQuery('Nothing to save');
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const markdown = `---\ntype: draft\ncontent_type: threads\ncreated: ${today}\nstatus: draft\n---\n\n${gen.lastGenerated}\n`;
    await this.couchSync.writeFile(`drafts/threads-${Date.now()}.md`, markdown);

    ctx.session.contentGen = undefined;
    await ctx.answerCbQuery('Saved!');
    await ctx.editMessageText(`Draft saved\n\n${gen.lastGenerated}`);
  }

  @Action('save_example')
  async onSaveExample(@Ctx() ctx: BotContext): Promise<void> {
    const gen = ctx.session?.contentGen;
    if (!gen?.lastGenerated) {
      await ctx.answerCbQuery('Nothing to save');
      return;
    }

    await this.contentAgent.saveVoiceSample(gen.lastGenerated);
    await ctx.answerCbQuery('Saved as voice example!');
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

  @Action('music_skip_title')
  async onMusicSkipTitle(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingMusic;
    if (!pending) return;

    await ctx.answerCbQuery();

    // Auto-name: track-1, track-2, etc.
    const existingTracks = await this.couchSync.listByPrefix('inbox/track-');
    const trackNum = existingTracks.length + 1;
    pending.title = `track-${trackNum}`;
    pending.awaitingTitle = false;
    pending.awaitingDescription = true;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Skip', 'music_skip_desc')],
    ]);
    await ctx.editMessageText(`Title: ${pending.title}\n\nAdd a description?`, keyboard);
  }

  @Action('music_skip_desc')
  async onMusicSkipDesc(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingMusic;
    if (!pending?.audioFileName) return;

    const audioFileName = pending.audioFileName;
    const title = pending.title || 'music-idea';
    ctx.session.pendingMusic = undefined;

    await ctx.answerCbQuery();

    ctx.session.pendingNote = {
      content: '',
      classification: {
        entityType: 'music',
        title,
        suggestedTags: ['sketch'],
        lifeArea: 'music',
        confidence: 0.8,
        musicData: {
          hasAudio: true,
          audioFileName,
        },
      },
      selectedTags: ['sketch'],
      selectedAreas: ['music'],
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

    const { text, links } = this.parseContactDisplay(content, fileName);

    type Btn = ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>;
    const rows: Btn[][] = [];
    for (let i = 0; i < links.length; i += 2) {
      rows.push(links.slice(i, i + 2).map((l) => Markup.button.url(l.label, l.url)));
    }
    rows.push([Markup.button.callback('« Back to contacts', 'contacts_page:0')]);
    const keyboard = Markup.inlineKeyboard(rows);

    const truncated = text.length > 3500
      ? text.slice(0, 3500) + '\n\n... (truncated)'
      : text;

    await ctx.editMessageText(truncated, keyboard);
  }

  private parseContactDisplay(
    content: string,
    fileName: string,
  ): { text: string; links: { label: string; url: string }[] } {
    const lines: string[] = [];
    const links: { label: string; url: string }[] = [];

    // Extract frontmatter fields
    const name = content.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1] || fileName;
    const phone = content.match(/^phone:\s*"?(.+?)"?\s*$/m)?.[1];
    const cityMet = content.match(/^city_met:\s*"?(.+?)"?\s*$/m)?.[1];
    const dateMet = content.match(/^date_met:\s*(.+)$/m)?.[1];
    const context = content.match(/^context:\s*"?(.+?)"?\s*$/m)?.[1];
    const tags = content.match(/^tags:\s*\[(.+)\]$/m)?.[1];

    lines.push(name);
    if (phone) lines.push(`Phone: ${phone}`);
    if (cityMet) lines.push(`Met in: ${cityMet}`);
    if (dateMet) lines.push(`Date: ${dateMet}`);
    if (context) lines.push(`Context: ${context}`);
    if (tags) lines.push(`Tags: ${tags}`);

    // Body after frontmatter
    const secondDash = content.indexOf('---', 4);
    const body = secondDash > 0 ? content.slice(secondDash + 3) : '';

    // Parse platform entries from the "## Contacts" section into tappable buttons
    const contactsSection =
      body.match(/##\s*Contacts\s*\n([\s\S]*?)(?=\n##\s|$)/)?.[1] || '';
    for (const rawLine of contactsSection.split('\n')) {
      const entry = rawLine.trim().replace(/^[-*]\s*/, '');
      const kv = entry.match(/^([A-Za-z][\w]*)\s*:\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1];
      const value = kv[2].trim();
      if (/^phone$/i.test(key)) continue; // already shown from frontmatter
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const md = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (md) {
        const handle = md[1];
        const url = md[2].trim();
        lines.push(`${label}: ${handle}`);
        if (/^(https?:|tg:)/i.test(url)) links.push({ label, url });
      } else {
        lines.push(`${label}: ${value}`);
      }
    }

    // Notes body (after "## Notes")
    const notes = body.match(/##\s*Notes\s*\n([\s\S]*)$/)?.[1]?.trim();
    if (notes) {
      lines.push('');
      lines.push(notes);
    }

    return { text: lines.join('\n'), links };
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

  @Action('voice_with_audio')
  async onVoiceWithAudio(@Ctx() ctx: BotContext): Promise<void> {
    const pending = ctx.session?.pendingVoice;
    if (!pending?.voiceFileId) return;

    await ctx.answerCbQuery('Saving audio...');

    try {
      const fileLink = await ctx.telegram.getFileLink(pending.voiceFileId);
      const response = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      const today = format(new Date(), 'yyyy-MM-dd');
      const audioFileName = `${today}-voice-${Date.now()}.ogg`;
      await this.writer.saveAttachment(audioFileName, audioBuffer);

      pending.withAudio = true;
      const { text, hintEntityType } = pending;
      ctx.session.pendingVoice = undefined;

      await ctx.editMessageText(`"${text}" + audio`);

      await this.processor.processMessage(ctx, text, {
        sourceType: 'voice',
        hintEntityType,
        audioFileName,
      });
    } catch (err) {
      this.logger.error(`Voice audio save failed: ${err}`);
      await ctx.editMessageText(`Error saving audio. Text preserved:\n"${pending.text}"`);
    }
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
