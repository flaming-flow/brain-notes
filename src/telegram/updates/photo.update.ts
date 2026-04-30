import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx } from 'nestjs-telegraf';
import { format } from 'date-fns';
import { AuthGuard } from '../guards/auth.guard.js';
import { MessageProcessorService } from '../services/message-processor.service.js';
import { AiService } from '../../ai/ai.service.js';
import { VaultService } from '../../vault/vault.service.js';
import { VaultWriterService } from '../../vault/vault-writer.service.js';
import { TemplateService } from '../../vault/services/template.service.js';
import { generateFileName } from '../../vault/utils/slug.util.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

@Update()
@UseGuards(AuthGuard)
export class PhotoUpdate {
  private readonly logger = new Logger(PhotoUpdate.name);

  constructor(
    private readonly processor: MessageProcessorService,
    private readonly ai: AiService,
    private readonly vault: VaultService,
    private readonly writer: VaultWriterService,
    private readonly tpl: TemplateService,
  ) {}

  @On('photo')
  async onPhoto(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const photos = message?.photo as Array<{ file_id: string; width: number; height: number }> | undefined;
    if (!photos || photos.length === 0) return;

    this.logger.log('Photo message received');

    try {
      // Get highest resolution
      const bestPhoto = photos[photos.length - 1];
      const caption = (message?.caption as string) || '';

      // Download image
      const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
      const response = await fetch(fileLink.href);
      const imageBuffer = Buffer.from(await response.arrayBuffer());

      // Save attachment
      const today = format(new Date(), 'yyyy-MM-dd');
      const ext = this.getImageExtension(fileLink.href);
      const imageFileName = `${today}-${Date.now()}${ext}`;
      await this.writer.saveAttachment(imageFileName, imageBuffer);

      if (!caption) {
        // No caption: save immediately with minimal classification
        const noteFileName = generateFileName('photo', today);
        const markdown = this.tpl.render('note', {
          tags: [],
          life_area: null,
          has_attachment: true,
          created: today,
        }, `![[${imageFileName}]]`);
        const filePath = await this.writer.writeFile('inbox', noteFileName, markdown);
        this.processor.storeLastSave(ctx, filePath, 'inbox', noteFileName);
        await ctx.reply(`Photo saved: ${noteFileName}`);
        return;
      }

      // With caption: go through AI classification + tag selection
      await this.processor.processMessage(ctx, caption, {
        sourceType: 'photo',
        imageFileName,
      });
    } catch (error) {
      this.logger.error(`Photo processing error: ${error}`);
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private getImageExtension(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('.png')) return '.png';
      if (pathname.endsWith('.webp')) return '.webp';
    } catch {}
    return '.jpg';
  }
}
