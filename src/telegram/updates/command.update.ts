import { UseGuards } from '@nestjs/common';
import { Update, Start, Help, Command, Ctx } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultReaderService } from '../../vault/vault-reader.service.js';
import { CouchDBSyncService } from '../../couchdb/couchdb-sync.service.js';
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
        'Команды:\n' +
        '/contact Имя — создать карточку контакта\n' +
        '/contacts — список всех контактов\n' +
        '/project Описание — создать проект\n' +
        '/music Описание — музыкальная заметка\n' +
        '/help — подробная справка',
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
        'Кнопки:\n' +
        '+ Contact — быстрое создание контакта\n' +
        'Contacts — список всех контактов\n\n' +
        'Команды:\n' +
        '/contact Имя — визард создания контакта\n' +
        '/contacts — список контактов с пагинацией\n' +
        '/project Описание — создать проект\n' +
        '/music Описание — музыкальная заметка\n' +
        '/music — режим записи (отправь аудио)\n' +
        '/help — эта справка',
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
