import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

export interface ContactSummary {
  fileName: string;
  name: string;
}

@Injectable()
export class VaultReaderService {
  private readonly logger = new Logger(VaultReaderService.name);
  private readonly basePath: string;

  constructor(
    private readonly couchSync: CouchDBSyncService,
    config: ConfigService,
  ) {
    this.basePath = config.getOrThrow<string>('vault.basePath');
  }

  async listContacts(): Promise<ContactSummary[]> {
    try {
      return await this.listContactsFromCouchDB();
    } catch (err) {
      this.logger.warn(`CouchDB read failed, falling back to filesystem: ${(err as Error).message}`);
      return this.listContactsFromFS();
    }
  }

  async readContact(fileName: string): Promise<string | null> {
    try {
      const content = await this.couchSync.readFile(`contacts/${fileName}.md`);
      if (content) return content;
    } catch (err) {
      this.logger.warn(`CouchDB read failed for ${fileName}: ${(err as Error).message}`);
    }
    // Fallback to filesystem
    try {
      return await fs.readFile(
        path.join(this.basePath, 'contacts', `${fileName}.md`),
        'utf-8',
      );
    } catch {
      return null;
    }
  }

  private async listContactsFromCouchDB(): Promise<ContactSummary[]> {
    const ids = await this.couchSync.listByPrefix('contacts/');
    const contacts: ContactSummary[] = [];

    for (const id of ids) {
      const content = await this.couchSync.readFile(id);
      if (!content) continue;

      const fileName = id.replace('contacts/', '').replace('.md', '');
      const nameMatch = content.match(/^name:\s*"?(.+?)"?\s*$/m);
      contacts.push({
        fileName,
        name: nameMatch?.[1] || fileName,
      });
    }

    return contacts.sort((a, b) => b.fileName.localeCompare(a.fileName));
  }

  private async listContactsFromFS(): Promise<ContactSummary[]> {
    const dir = path.join(this.basePath, 'contacts');
    try {
      const files = await fs.readdir(dir);
      const contacts: ContactSummary[] = [];
      for (const file of files.filter(f => f.endsWith('.md')).sort().reverse()) {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const nameMatch = content.match(/^name:\s*"?(.+?)"?\s*$/m);
        contacts.push({
          fileName: file.replace('.md', ''),
          name: nameMatch?.[1] || file.replace('.md', ''),
        });
      }
      return contacts;
    } catch {
      return [];
    }
  }
}
