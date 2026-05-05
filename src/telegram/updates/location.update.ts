import { Logger, UseGuards } from '@nestjs/common';
import { Update, On, Ctx } from 'nestjs-telegraf';
import { AuthGuard } from '../guards/auth.guard.js';
import type { BotContext } from '../../shared/interfaces/session.interface.js';

@Update()
@UseGuards(AuthGuard)
export class LocationUpdate {
  private readonly logger = new Logger(LocationUpdate.name);

  @On('location')
  async onLocation(@Ctx() ctx: BotContext): Promise<void> {
    const message = ctx.message as unknown as Record<string, unknown>;
    const location = message?.location as { latitude: number; longitude: number } | undefined;
    if (!location) return;

    ctx.session ??= {} as BotContext['session'];
    ctx.session.lastLocation = {
      latitude: location.latitude,
      longitude: location.longitude,
      timestamp: Date.now(),
    };

    this.logger.log(`Location saved: ${location.latitude}, ${location.longitude}`);
    await ctx.reply(
      `Location saved: ${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}\n` +
      'Next notes will include this location.',
    );
  }
}
