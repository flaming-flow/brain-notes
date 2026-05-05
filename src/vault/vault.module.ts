import { Module, OnModuleInit } from '@nestjs/common';
import { VaultService } from './vault.service.js';
import { VaultWriterService } from './vault-writer.service.js';
import { VaultReaderService } from './vault-reader.service.js';
import { TemplateService } from './services/template.service.js';
import { CouchDBModule } from '../couchdb/couchdb.module.js';

@Module({
  imports: [CouchDBModule],
  providers: [VaultService, VaultWriterService, VaultReaderService, TemplateService],
  exports: [VaultService, VaultWriterService, VaultReaderService, TemplateService],
})
export class VaultModule implements OnModuleInit {
  constructor(private readonly writer: VaultWriterService) {}

  async onModuleInit(): Promise<void> {
    await this.writer.ensureVaultStructure();
  }
}
