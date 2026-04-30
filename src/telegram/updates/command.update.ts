import { UseGuards } from '@nestjs/common';
import { Update, Start, Help, Command, Ctx } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

@Update()
@UseGuards(AuthGuard)
export class CommandUpdate {
  constructor(private readonly processor: MessageProcessorService) {}

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
        'Что создаю автоматически:\n' +
        '- Заметки, идеи, размышления\n' +
        '- Задачи и чеклисты (сохраняются сразу)\n' +
        '- Контакты (распознаются по имени и контексту)\n' +
        '- События (воркшопы, фестивали)\n' +
        '- Музыкальные идеи\n' +
        '- Проекты с целью и планом\n\n' +
        'Команды:\n' +
        '/contact Имя — создать карточку контакта\n' +
        '/project Описание — создать проект\n' +
        '/music Описание — музыкальная заметка\n' +
        '/music — режим записи (отправь аудио)\n' +
        '/help — подробная справка',
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
        'Типы заметок:\n' +
        '- Заметка — мысли, идеи, наблюдения\n' +
        '- Задача — "купить", "не забыть", "записаться"\n' +
        '- Чеклист — несколько задач в одном сообщении\n' +
        '- Контакт — "познакомился с Марией на танцах"\n' +
        '- Событие — воркшоп, фестиваль, мастер-класс\n' +
        '- Ссылка — URL на видео, статью, инструмент\n' +
        '- Музыка — идея мелодии, бита, текст песни\n' +
        '- Проект — цель + план действий + результат\n\n' +
        'Автоматически:\n' +
        '- Задачи и чеклисты сохраняются сразу (без выбора тегов)\n' +
        '- Контакты распознаются AI и сохраняются в contacts/\n' +
        '- Проекты сохраняются в projects/\n\n' +
        'Фишки:\n' +
        '- Ответь на сохранённую заметку — текст дополнится\n' +
        '- Undo — 60 сек после сохранения можно отменить\n' +
        '- Несколько ссылок в одном сообщении — сохранятся батчем\n' +
        '- Голосовые команды: "добавь заметку...", "создай задачу..."\n\n' +
        'Команды:\n' +
        '/contact Имя — визард создания контакта (телефон, соцсети, контекст)\n' +
        '/project Описание — создать проект с целью и планом действий\n' +
        '/music Описание — создать музыкальную заметку\n' +
        '/music — режим записи: отправь аудио, добавь описание\n' +
        '/help — эта справка',
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
      // Enter music mode: await audio
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
      await ctx.reply('Usage: /contact Name\nExample: /contact Maria Gonzalez');
      return;
    }

    ctx.session ??= {} as BotContext['session'];
    ctx.session.pendingContact = {
      step: 'phone',
      name,
      platforms: {},
    };

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Skip', 'contact_skip')],
    ]);

    await ctx.reply(`Contact: ${name}\n\nPhone number?`, keyboard);
  }
}
