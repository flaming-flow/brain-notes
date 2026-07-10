import { UseGuards } from '@nestjs/common';
import { Update, Start, Help, Command, Ctx } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultReaderService } from '../../vault/vault-reader.service.js';
import { CouchDBSyncService } from '../../couchdb/couchdb-sync.service.js';
import { EmbeddingService } from '../../vector/embedding.service.js';
import { ContentAgentService } from '../../content/content-agent.service.js';
import { THREADS_FORMATS, type ThreadsFormat } from '../../content/prompts/threads.prompt.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

const CONTACTS_PER_PAGE = 8;

const MAIN_KEYBOARD = Markup.keyboard([
  ['+ Contact', 'Contacts', 'Music'],
  ['Event', 'Idea'],
  [Markup.button.locationRequest('Send Location')],
]).resize();

@Update()
@UseGuards(AuthGuard)
export class CommandUpdate {
  constructor(
    private readonly processor: MessageProcessorService,
    private readonly reader: VaultReaderService,
    private readonly couchSync: CouchDBSyncService,
    private readonly embedding: EmbeddingService,
    private readonly contentAgent: ContentAgentService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      'Nomad Brain\n\n' +
        'Отправь мне что угодно — я сохраню в твой vault:\n\n' +
        'Что я принимаю:\n' +
        '- Текст — AI классифицирует, ты выбираешь теги\n' +
        '- Голосовое — транскрибирую и обработаю как текст\n' +
        '- Фото — сохраню с вложением\n' +
        '- Пересланное — сохраню с указанием источника\n' +
        '- Ссылки — сохраню как ресурс (несколько ссылок — батчем)\n' +
        '- Аудиофайл — транскрибирую\n\n' +
        'Commands:\n' +
        '/contact Name — create contact\n' +
        '/contacts — list contacts\n' +
        '/search keyword — search notes\n' +
        '/ask question — AI answers from your notes\n' +
        '/generate threads [topic] — generate Threads post\n' +
        '/project Description — create project\n' +
        '/music Description — music note\n' +
        '/reindex — reindex all notes for AI\n' +
        '/help — full guide',
      MAIN_KEYBOARD,
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      'Как пользоваться:\n\n' +
        '1. Отправь сообщение (текст, голосовое, фото, пересланное)\n' +
        '2. AI классифицирует и предложит теги\n' +
        '3. Нажимай теги чтобы выбрать/убрать\n' +
        '4. Нажми Save для сохранения\n\n' +
        'Buttons:\n' +
        '+ Contact — create contact\n' +
        'Contacts — list contacts\n' +
        'Event / Idea — quick templates\n' +
        'Music — record audio\n\n' +
        'Commands:\n' +
        '/contact Name — contact wizard\n' +
        '/contacts — contacts with pagination\n' +
        '/search keyword — text search in notes\n' +
        '/ask question — AI answers from your notes\n' +
        '/generate threads [topic] — generate Threads post\n' +
        '/generate threads — AI picks topic from notes\n' +
        '/project Description — create project\n' +
        '/music Description — music note\n' +
        '/reindex — reindex all notes for AI search\n' +
        '/help — this guide',
      MAIN_KEYBOARD,
    );
  }

  @Command('project')
  async onProjectCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const description = text.replace(/^\/project\s*/i, '').trim();
    if (!description) {
      await ctx.reply('Usage: /project Description\nExample: /project Launch online dance course');
      return;
    }

    await this.processor.processMessage(ctx, description, {
      hintEntityType: 'project',
    });
  }

  @Command('music')
  async onMusicCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const description = text.replace(/^\/music\s*/i, '').trim();

    if (!description) {
      ctx.session ??= {} as BotContext['session'];
      ctx.session.pendingMusic = { awaitingAudio: true };
      await ctx.reply('Send audio for your music idea.');
      return;
    }

    await this.processor.processMessage(ctx, description, {
      hintEntityType: 'music',
    });
  }

  @Command('contact')
  async onContactCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const name = text.replace(/^\/contact\s*/i, '').trim();
    if (!name) {
      await ctx.reply('Введи имя контакта:', Markup.forceReply());
      ctx.session ??= {} as BotContext['session'];
      ctx.session.pendingContact = {
        step: 'name',
        name: '',
        platforms: {},
      };
      return;
    }

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

  @Command('contacts')
  async onContactsCommand(@Ctx() ctx: BotContext): Promise<void> {
    await this.showContactsPage(ctx, 0);
  }

  @Command('search')
  async onSearchCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const query = text.replace(/^\/search\s*/i, '').trim();
    if (!query) {
      await ctx.reply('Usage: /search keyword');
      return;
    }

    await ctx.reply('Searching...');
    const results = await this.couchSync.searchByContent(query, 10);

    if (results.length === 0) {
      await ctx.reply(`No results for "${query}"`);
      return;
    }

    const buttons = results.map((r) => {
      const label = r.id.replace('.md', '').replace(/^[^/]+\//, '');
      return [Markup.button.callback(label.slice(0, 60), `view_note:${r.id}`)];
    });

    const keyboard = Markup.inlineKeyboard(buttons);
    await ctx.reply(`Found ${results.length} result(s) for "${query}":`, keyboard);
  }

  @Command('ask')
  async onAskCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const question = text.replace(/^\/ask\s*/i, '').trim();
    if (!question) {
      await ctx.reply('Usage: /ask your question');
      return;
    }

    await ctx.reply('Thinking...');
    const { answer, sources } = await this.contentAgent.ask(question);

    // Show contact buttons if contacts found in sources
    const contactSources = sources.filter((s) => s.startsWith('contacts/'));
    if (contactSources.length > 0) {
      const buttons = contactSources.map((s) => {
        const name = s.replace('contacts/', '').replace('.md', '');
        return [Markup.button.callback(name, `view_contact:${name}`)];
      });
      const keyboard = Markup.inlineKeyboard(buttons);
      await ctx.reply(answer, keyboard);
    } else {
      await ctx.reply(answer);
    }
  }

  @Command('generate')
  async onGenerateCommand(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as { text?: string };
    const text = message?.text || '';
    const args = text.replace(/^\/generate\s*/i, '').trim();

    // Parse format and optional topic
    const parts = args.split(/\s+/);
    const format = (parts[0] || 'threads').toLowerCase();

    if (format !== 'threads') {
      await ctx.reply('Supported formats: threads\nUsage: /generate threads [topic]');
      return;
    }

    const topic = parts.slice(1).join(' ') || '';

    // No topic — suggest topics first
    if (!topic) {
      await ctx.reply('Looking at your notes...');
      const topics = await this.contentAgent.suggestTopics();

      if (topics.length === 0) {
        await ctx.reply('No notes yet. Send me some ideas first!');
        return;
      }

      ctx.session ??= {} as BotContext['session'];
      (ctx.session as Record<string, unknown>).suggestedTopics = topics;

      const buttons = topics.map((t, i) => [
        Markup.button.callback(t.slice(0, 60), `gen_topic:${i}`),
      ]);

      const keyboard = Markup.inlineKeyboard(buttons);
      await ctx.reply('Pick a topic or write your own:', keyboard);
      return;
    }

    await this.generateAndReply(ctx, topic);
  }

  async generateAndReply(ctx: BotContext, topic: string, format: ThreadsFormat = 'auto'): Promise<void> {
    await ctx.reply('Looking at your notes...');

    const session = await this.contentAgent.startSession(topic);
    if (!session) {
      await ctx.reply('No relevant notes found for this topic. Try /reindex first.');
      return;
    }

    ctx.session ??= {} as BotContext['session'];
    ctx.session.contentGen = {
      topic,
      format,
      sources: session.sources,
      systemPrompt: session.systemPrompt,
      contextBlock: session.contextBlock,
      voiceSamples: session.voiceSamples,
      messages: [],
      currentPost: '',
    };

    // Unpacker: ask the author for specifics the notes lack, then generate.
    const questions = await this.contentAgent.buildUnpackQuestions(topic, session.contextBlock);
    if (questions.length === 0) {
      await this.runGeneration(ctx);
      return;
    }

    ctx.session.contentGen.unpackQuestions = questions;
    ctx.session.contentGen.awaitingUnpackAnswers = true;

    const qText = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Skip → generate', 'gen_skip_unpack')],
    ]);
    await ctx.reply(
      `Before I write — help me make it sharper:\n\n${qText}\n\nAnswer in one message (text or voice), or Skip.`,
      keyboard,
    );
  }

  /** Runs the actual generation using the paused session. `enrichment` = the
   *  author's unpack answers (empty when skipped). */
  async runGeneration(ctx: BotContext, enrichment = ''): Promise<void> {
    const gen = ctx.session?.contentGen;
    if (!gen) return;
    gen.awaitingUnpackAnswers = false;

    await ctx.reply('Generating...');

    const post = await this.contentAgent.generateFirst(
      gen.systemPrompt,
      gen.contextBlock ?? '',
      gen.topic,
      gen.format as ThreadsFormat,
      enrichment,
      gen.voiceSamples ?? [],
    );

    gen.messages = [
      {
        role: 'user',
        content: enrichment ? `Topic: ${gen.topic}\n\nAnswers:\n${enrichment}` : `Topic: ${gen.topic}`,
      },
      { role: 'assistant', content: post },
    ];
    gen.currentPost = post;

    await this.replyWithPost(ctx, post, gen.sources);
  }

  replyWithPost(ctx: BotContext, post: string, sources: string[] = []): Promise<void> {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Post text wrapped in <pre> so Telegram renders a tap-to-copy block
    // containing ONLY the post; sources stay outside it as plain text.
    const sourcesText = sources.length > 0
      ? `\n\nBased on: ${sources.map((s) => `"${esc(s)}"`).join(', ')}`
      : '';

    const formatButtons = Object.entries(THREADS_FORMATS).map(
      ([key, label]) => Markup.button.callback(label, `gen_format:${key}`),
    );

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Regenerate', 'regen_threads'),
        Markup.button.callback('Save as draft', 'save_draft'),
      ],
      formatButtons,
      [
        Markup.button.callback('Save as example', 'save_example'),
        Markup.button.callback('Cancel', 'gen_cancel'),
      ],
    ]);

    return ctx.reply(`<pre>${esc(post)}</pre>${sourcesText}`, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
    }) as unknown as Promise<void>;
  }

  @Command('reindex')
  async onReindexCommand(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.reply('Reindexing all notes...');
    const count = await this.embedding.indexAllNotes();
    await ctx.reply(`Done. Indexed ${count} notes.`);
  }

  async showContactsPage(ctx: BotContext, page: number, edit = false): Promise<void> {
    const contacts = await this.reader.listContacts();

    if (contacts.length === 0) {
      const text = 'No contacts yet. Use /contact Name to create one.';
      if (edit) {
        await ctx.editMessageText(text);
      } else {
        await ctx.reply(text);
      }
      return;
    }

    const totalPages = Math.ceil(contacts.length / CONTACTS_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageContacts = contacts.slice(
      safePage * CONTACTS_PER_PAGE,
      (safePage + 1) * CONTACTS_PER_PAGE,
    );

    const buttons = pageContacts.map(c => [
      Markup.button.callback(c.name, `view_contact:${c.fileName}`),
    ]);

    const navRow: ReturnType<typeof Markup.button.callback>[] = [];
    if (safePage > 0) {
      navRow.push(Markup.button.callback('« Prev', `contacts_page:${safePage - 1}`));
    }
    navRow.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, 'noop'));
    if (safePage < totalPages - 1) {
      navRow.push(Markup.button.callback('Next »', `contacts_page:${safePage + 1}`));
    }

    const keyboard = Markup.inlineKeyboard([...buttons, navRow]);
    const text = `Contacts (${contacts.length}):`;

    if (edit) {
      await ctx.editMessageText(text, keyboard);
    } else {
      await ctx.reply(text, keyboard);
    }
  }
}
