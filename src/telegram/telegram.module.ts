import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { session } from 'telegraf';
import { AuthGuard } from './guards/auth.guard.js';
import { MessageProcessorService } from './services/message-processor.service.js';
import { VoiceService } from './services/voice.service.js';
import { CommandUpdate } from './updates/command.update.js';
import { TextUpdate } from './updates/text.update.js';
import { ActionUpdate } from './updates/action.update.js';
import { VoiceUpdate } from './updates/voice.update.js';
import { PhotoUpdate } from './updates/photo.update.js';
import { LocationUpdate } from './updates/location.update.js';
import { VaultModule } from '../vault/vault.module.js';
import { AiModule } from '../ai/ai.module.js';
import { CouchDBModule } from '../couchdb/couchdb.module.js';
import { VectorModule } from '../vector/vector.module.js';
import { ContentModule } from '../content/content.module.js';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow<string>('telegram.token'),
        middlewares: [session()],
      }),
    }),
    VaultModule,
    AiModule,
    CouchDBModule,
    VectorModule,
    ContentModule,
  ],
  providers: [
    MessageProcessorService,
    VoiceService,
    CommandUpdate,
    TextUpdate,
    ActionUpdate,
    VoiceUpdate,
    PhotoUpdate,
    LocationUpdate,
    AuthGuard,
  ],
})
export class TelegramModule {}
