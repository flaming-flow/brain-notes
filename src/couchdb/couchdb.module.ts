import { Module } from '@nestjs/common';
import { CouchDBSyncService } from './couchdb-sync.service.js';

@Module({
  providers: [CouchDBSyncService],
  exports: [CouchDBSyncService],
})
export class CouchDBModule {}
