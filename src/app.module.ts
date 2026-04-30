import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { VaultModule } from './vault/vault.module.js';
import { AiModule } from './ai/ai.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TelegramModule,
    VaultModule,
    AiModule,
  ],
})
export class AppModule {}
