import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { CouchDBModule } from '../couchdb/couchdb.module.js';

@Module({
  imports: [CouchDBModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
