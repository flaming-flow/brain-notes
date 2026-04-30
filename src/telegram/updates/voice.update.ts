import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import { VoiceService } from '../services/voice.service.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
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
  ) {}

  @On('voice')
  async onVoice(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const voiceData = message?.voice as { file_id: string; duration: number } | undefined;
    if (!voiceData) return;

    this.logger.log(`Voice message received (${voiceData.duration}s)`);

    try {
      await ctx.reply('Transcribing...');

      const fileLink = await ctx.telegram.getFileLink(voiceData.file_id);
      const rawText = await this.voice.transcribe(fileLink.href);
      await this.showTranscriptionPreview(ctx, rawText);
    } catch (error) {
      this.logger.error(`Voice processing error: ${error}`);
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
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
        awaitingDescription: true,
      };

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Skip', 'music_skip_desc')],
      ]);

      await ctx.reply('Audio saved. Add a description?', keyboard);
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
        Markup.button.callback('Edit', 'voice_edit'),
      ],
    ]);

    await ctx.reply(`${header}\n"${cleanedText}"`, keyboard);
  }
}
