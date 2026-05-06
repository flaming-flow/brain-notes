import { Module } from '@nestjs/common';
import { ContentAgentService } from './content-agent.service.js';
import { VectorModule } from '../vector/vector.module.js';
import { CouchDBModule } from '../couchdb/couchdb.module.js';

@Module({
  imports: [VectorModule, CouchDBModule],
  providers: [ContentAgentService],
  exports: [ContentAgentService],
})
export class ContentModule {}
