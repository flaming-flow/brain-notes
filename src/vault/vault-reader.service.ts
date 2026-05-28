import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

export interface ContactSummary {
  fileName: string;
  name: string;
}

export interface TagFrequency {
  tag: string;
  count: number;
}

@Injectable()
export class VaultReaderService {
  private readonly logger = new Logger(VaultReaderService.name);
  private readonly basePath: string;
  private tagCache?: { tags: TagFrequency[]; at: number };
  private readonly TAG_CACHE_TTL = 5 * 60_000;

  constructor(
    private readonly couchSync: CouchDBSyncService,
    config: ConfigService,
  ) {
    this.basePath = config.getOrThrow<string>('vault.basePath');
  }

  /**
   * All tags used across the vault, ranked by frequency (most used first).
   * Cached for 5 min so the picker / dedup checks stay snappy.
   */
  async getTagVocabulary(): Promise<TagFrequency[]> {
    if (this.tagCache && Date.now() - this.tagCache.at < this.TAG_CACHE_TTL) {
      return this.tagCache.tags;
    }

    const counts = new Map<string, number>();
    const collect = (content: string | null): void => {
      if (!content) return;
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match?.[1]) return;
      try {
        const fm = yaml.load(match[1]) as Record<string, unknown>;
        if (Array.isArray(fm?.tags)) {
          for (const tag of fm.tags) {
            if (typeof tag === 'string' && tag.trim()) {
              const t = tag.trim();
              counts.set(t, (counts.get(t) || 0) + 1);
            }
          }
        }
      } catch { /* skip malformed frontmatter */ }
    };

    try {
      const ids: string[] = [];
      for (const prefix of ['inbox/', 'projects/', 'contacts/']) {
        ids.push(...(await this.couchSync.listByPrefix(prefix)));
      }
      for (const id of ids) {
        if (!id.endsWith('.md')) continue;
        collect(await this.couchSync.readFile(id));
      }
    } catch (err) {
      this.logger.warn(`Tag vocabulary CouchDB read failed: ${(err as Error).message}`);
      for (const dir of ['inbox', 'projects', 'contacts']) {
        try {
          const files = await fs.readdir(path.join(this.basePath, dir));
          for (const file of files) {
            if (!file.endsWith('.md')) continue;
            collect(await fs.readFile(path.join(this.basePath, dir, file), 'utf-8'));
          }
        } catch { /* skip missing dir */ }
      }
    }

    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
    this.tagCache = { tags, at: Date.now() };
    return tags;
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
