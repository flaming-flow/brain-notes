import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LIFE_AREAS } from '../shared/constants/life-areas.constant.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

@Injectable()
export class VaultWriterService {
  private readonly logger = new Logger(VaultWriterService.name);
  readonly basePath: string;

  constructor(
    private readonly config: ConfigService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.basePath = this.config.getOrThrow<string>('vault.basePath');
  }

  async ensureVaultStructure(): Promise<void> {
    await this.ensureMocFiles();
    this.logger.log('Vault structure ensured in CouchDB');
  }

  private async ensureMocFiles(): Promise<void> {
    for (const area of LIFE_AREAS) {
      const docId = `MOC-${area}.md`;
      const existing = await this.couchSync.readFile(docId);
      if (!existing) {
        const content = `---\ntype: moc\nlife_area: ${area}\n---\n\n# ${area.charAt(0).toUpperCase() + area.slice(1)}\n\n`;
        await this.couchSync.writeFile(docId, content);
        this.logger.log(`Created MOC: ${docId}`);
      }
    }
  }

  async appendToMoc(lifeArea: string, wikilink: string): Promise<void> {
    const docId = `MOC-${lifeArea}.md`;
    const content = await this.couchSync.readFile(docId);
    if (content && !content.includes(wikilink)) {
      const updated = content + `- ${wikilink}\n`;
      await this.couchSync.writeFile(docId, updated);
    }
  }

  async writeFile(folder: string, fileName: string, content: string): Promise<string> {
    let docId = `${folder}/${fileName}.md`;

    // Handle collision: check if doc exists in CouchDB
    let actualFileName = fileName;
    let suffix = 1;
    while (await this.couchSync.readFile(docId) !== null) {
      actualFileName = `${fileName}-${suffix}`;
      docId = `${folder}/${actualFileName}.md`;
      suffix++;
    }

    await this.couchSync.writeFile(docId, content);
    this.logger.log(`Written: ${docId}`);
    return docId;
  }

  async appendToFile(filePath: string, content: string): Promise<void> {
    const existing = await this.couchSync.readFile(filePath);
    if (existing) {
      const updated = existing + `\n${content}\n`;
      await this.couchSync.writeFile(filePath, updated);
      this.logger.log(`Appended to: ${filePath}`);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.couchSync.deleteFile(filePath);
    this.logger.log(`Deleted: ${filePath}`);
  }

  async removeFromMoc(lifeArea: string, wikilink: string): Promise<void> {
    const docId = `MOC-${lifeArea}.md`;
    const content = await this.couchSync.readFile(docId);
    if (content) {
      const updated = content.replace(`- ${wikilink}\n`, '');
      if (updated !== content) {
        await this.couchSync.writeFile(docId, updated);
        this.logger.log(`Removed from MOC-${lifeArea}: ${wikilink}`);
      }
    }
  }

  async saveAttachment(fileName: string, data: Buffer): Promise<string> {
    const dirPath = path.join(this.basePath, 'attachments');
    await fs.mkdir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, fileName);
    await fs.writeFile(filePath, data);
    this.logger.log(`Attachment saved: ${filePath}`);
    return filePath;
  }
}
