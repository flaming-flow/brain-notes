import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { VoiceService } from '../services/voice.service.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { CouchDBSyncService } from '../../couchdb/couchdb-sync.service.js';
import { parseVoiceCommand } from '../utils/voice-command.util.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';
import { format } from 'date-fns';

@Update()
@UseGuards(AuthGuard)
export class VoiceUpdate {
  private readonly logger = new Logger(VoiceUpdate.name);

  constructor(
    private readonly voice: VoiceService,
    private readonly processor: MessageProcessorService,
    private readonly writer: VaultWriterService,
    private readonly couchSync: CouchDBSyncService,
  ) {}

  @On('voice')
  async onVoice(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const voiceData = message?.voice as { file_id: string; duration: number } | undefined;
    if (!voiceData) return;

    this.logger.log(`Voice message received (${voiceData.duration}s)`);

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Check if replying to a saved note — voice append
    const replyTo = message?.reply_to_message as unknown as Record<string, unknown> | undefined;
    const replyText = (replyTo?.text as string) || '';
    const savedMatch = replyText.match(/Saved:\s*(.+?)(?:\n|$)/);

    if (savedMatch) {
      await ctx.reply('Transcribing for edit...');
      const fileLink = await ctx.telegram.getFileLink(voiceData.file_id);
      this.voice.transcribe(fileLink.href).then(
        async (rawText) => {
          const fileName = savedMatch[1].trim();
          let filePath: string | undefined;
          for (const folder of ['inbox', 'contacts', 'projects']) {
            const docId = `${folder}/${fileName}.md`;
            const content = await this.couchSync.readFile(docId);
            if (content) { filePath = docId; break; }
          }
          if (!filePath) {
            await ctx.telegram.sendMessage(chatId, 'Note not found.');
            return;
          }
          ctx.session ??= {} as BotContext['session'];
          ctx.session.pendingEdit = { text: rawText, filePath, fileName };
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('Append', 'edit_append'),
              Markup.button.callback('Replace', 'edit_replace'),
              Markup.button.callback('Cancel', 'cancel'),
            ],
          ]);
          await ctx.telegram.sendMessage(chatId, `"${rawText}"\n\n"${fileName}" — Append or replace?`, { reply_markup: keyboard.reply_markup });
        },
        async (error) => {
          await ctx.telegram.sendMessage(chatId, `Voice error: ${(error as Error).message}`);
        },
      );
      return;
    }

    await ctx.reply('Got it, processing...');

    // Process in background — don't block the user
    const fileLink = await ctx.telegram.getFileLink(voiceData.file_id);
    this.voice.transcribe(fileLink.href).then(
      async (rawText) => {
        await this.showTranscriptionPreview(ctx, rawText);
      },
      async (error) => {
        this.logger.error(`Voice processing error: ${error}`);
        await ctx.telegram.sendMessage(chatId, `Voice error: ${error instanceof Error ? error.message : 'unknown'}`);
      },
    );
  }

  @On('audio')
  async onAudio(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const audioData = message?.audio as { file_id: string; file_name?: string; mime_type?: string } | undefined;
    if (!audioData) return;

    // Music mode: save audio as music note instead of transcribing
    if (ctx.session?.pendingMusic?.awaitingAudio) {
      await this.handleMusicAudio(ctx, audioData);
      return;
    }

    this.logger.log('Audio file received');

    try {
      await ctx.reply('Transcribing audio...');

      const fileLink = await ctx.telegram.getFileLink(audioData.file_id);
      const rawText = await this.voice.transcribe(fileLink.href);
      await this.showTranscriptionPreview(ctx, rawText);
    } catch (error) {
      this.logger.error(`Audio processing error: ${error}`);
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async handleMusicAudio(
    ctx: BotContext,
    audioData: { file_id: string; file_name?: string; mime_type?: string },
  ): Promise<void> {
    try {
      this.logger.log(`Music audio received: ${audioData.file_name || 'unnamed'}`);

      const fileLink = await ctx.telegram.getFileLink(audioData.file_id);
      const response = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      const today = format(new Date(), 'yyyy-MM-dd');
      const ext = this.getAudioExtension(audioData.file_name, audioData.mime_type);
      const audioFileName = `${today}-music-${Date.now()}${ext}`;
      await this.writer.saveAttachment(audioFileName, audioBuffer);

      ctx.session.pendingMusic = {
        audioFileName,
        awaitingTitle: true,
      };

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Skip', 'music_skip_title')],
      ]);

      await ctx.reply('Audio saved. Give it a title?', keyboard);
    } catch (error) {
      this.logger.error(`Music audio error: ${error}`);
      ctx.session.pendingMusic = undefined;
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private getAudioExtension(fileName?: string, mimeType?: string): string {
    if (fileName) {
      const ext = fileName.match(/\.[^.]+$/)?.[0];
      if (ext) return ext;
    }
    if (mimeType?.includes('ogg')) return '.ogg';
    if (mimeType?.includes('mp3') || mimeType?.includes('mpeg')) return '.mp3';
    if (mimeType?.includes('wav')) return '.wav';
    if (mimeType?.includes('m4a') || mimeType?.includes('mp4')) return '.m4a';
    return '.mp3';
  }

  private async showTranscriptionPreview(ctx: BotContext, rawText: string): Promise<void> {
    const { entityType, cleanedText } = parseVoiceCommand(rawText);

    ctx.session ??= {} as BotContext['session'];
    ctx.session.pendingVoice = {
      text: cleanedText,
      hintEntityType: entityType,
    };

    const header = entityType
      ? `Voice command: ${entityType}`
      : 'Transcribed';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('OK', 'voice_ok'),
        Markup.button.callback('Polish', 'voice_polish'),
        Markup.button.callback('Edit', 'voice_edit'),
      ],
    ]);

    await ctx.reply(`${header}\n"${cleanedText}"`, keyboard);
  }
}
