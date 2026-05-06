import { Module } from '@nestjs/common';
import { QdrantService } from './qdrant.service.js';
import { EmbeddingService } from './embedding.service.js';
import { CouchDBModule } from '../couchdb/couchdb.module.js';

@Module({
  imports: [CouchDBModule],
  providers: [QdrantService, EmbeddingService],
  exports: [EmbeddingService],
})
export class VectorModule {}
