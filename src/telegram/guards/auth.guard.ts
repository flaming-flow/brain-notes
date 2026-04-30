import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegrafExecutionContext } from 'nestjs-telegraf';
import { Context } from 'telegraf';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly authorizedChatId: number;

  constructor(private readonly config: ConfigService) {
    this.authorizedChatId = this.config.getOrThrow<number>('telegram.authorizedChatId');
  }

  canActivate(context: ExecutionContext): boolean {
    const ctx = TelegrafExecutionContext.create(context).getContext<Context>();
    const chatId = ctx.from?.id;
    return chatId === this.authorizedChatId;
  }
}
