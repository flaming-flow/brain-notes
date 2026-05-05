import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

interface LiveSyncMetaDoc {
  _id: string;
  _rev?: string;
  type: 'plain' | 'newnote';
  path: string;
  children: string[];
  ctime: number;
  mtime: number;
  size: number;
  eden: Record<string, unknown>;
}

interface LiveSyncLeafDoc {
  _id: string;
  _rev?: string;
  type: 'leaf';
  data: string;
}

@Injectable()
export class CouchDBSyncService implements OnModuleInit {
  private readonly logger = new Logger(CouchDBSyncService.name);
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('couchdb.url');
    const database = this.config.getOrThrow<string>('couchdb.database');
    const username = this.config.getOrThrow<string>('couchdb.username');
    const password = this.config.getOrThrow<string>('couchdb.password');

    this.baseUrl = `${url}/${database}`;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    this.headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    };
  }

  async onModuleInit(): Promise<void> {
    await this.ensureDatabase();
  }

  private async ensureDatabase(): Promise<void> {
    const url = this.config.getOrThrow<string>('couchdb.url');
    const database = this.config.getOrThrow<string>('couchdb.database');

    // Check if DB exists
    const res = await fetch(this.baseUrl, { headers: this.headers });
    if (res.ok) {
      this.logger.log(`CouchDB database "${database}" exists`);
      return;
    }

    // Create DB
    const createRes = await fetch(this.baseUrl, {
      method: 'PUT',
      headers: this.headers,
    });

    if (!createRes.ok && createRes.status !== 412) {
      const body = await createRes.text();
      throw new Error(`Failed to create CouchDB database: ${createRes.status} ${body}`);
    }

    this.logger.log(`CouchDB database "${database}" created`);

    // Enable CORS for LiveSync clients
    await this.configureCORS(url);
  }

  private async configureCORS(couchUrl: string): Promise<void> {
    const nodeUrl = `${couchUrl}/_node/_local/_config`;

    const corsSettings: [string, string, string][] = [
      ['httpd', 'enable_cors', 'true'],
      ['cors', 'origins', '*'],
      ['cors', 'credentials', 'true'],
      ['cors', 'headers', 'accept, authorization, content-type, origin, referer'],
      ['cors', 'methods', 'GET, PUT, POST, HEAD, DELETE'],
      ['chttpd', 'max_http_request_size', '4294967296'],
    ];

    for (const [section, key, value] of corsSettings) {
      await fetch(`${nodeUrl}/${section}/${key}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify(value),
      });
    }

    this.logger.log('CouchDB CORS configured for LiveSync');
  }

  async writeFile(
    filePath: string,
    content: string,
  ): Promise<{ metaId: string; leafId: string }> {
    const now = Date.now();

    // Check if metadata doc already exists (need _rev for update)
    const existingMeta = await this.getDoc<LiveSyncMetaDoc>(filePath);
    const ctime = existingMeta?.ctime ?? now;

    // Create leaf document (content-addressable)
    const leafId = this.chunkId(content);
    const existingLeaf = await this.getDoc(leafId);
    if (!existingLeaf) {
      await this.putDoc({
        _id: leafId,
        type: 'leaf',
        data: content,
      });
    }

    // Create/update metadata document
    const metaDoc: Record<string, unknown> = {
      _id: filePath,
      type: 'plain',
      path: filePath,
      children: [leafId],
      ctime,
      mtime: now,
      size: Buffer.byteLength(content, 'utf8'),
      eden: {},
    };

    if (existingMeta?._rev) {
      metaDoc._rev = existingMeta._rev;
    }

    await this.putDoc(metaDoc);
    this.logger.log(`Synced to CouchDB: ${filePath}`);

    return { metaId: filePath, leafId };
  }

  async readFile(filePath: string): Promise<string | null> {
    const meta = await this.getDoc<LiveSyncMetaDoc>(filePath);
    if (!meta) return null;

    if (!Array.isArray(meta.children) || meta.children.length === 0) {
      // Doc exists but has no children (different format or empty)
      return null;
    }

    const chunks: string[] = [];
    for (const childId of meta.children) {
      const leaf = await this.getDoc<LiveSyncLeafDoc>(childId);
      if (!leaf) {
        this.logger.warn(`Missing chunk ${childId} for ${filePath}`);
        return null;
      }
      chunks.push(leaf.data);
    }
    return chunks.join('');
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    const url = `${this.baseUrl}/_all_docs?` +
      `startkey=${encodeURIComponent(JSON.stringify(prefix))}` +
      `&endkey=${encodeURIComponent(JSON.stringify(prefix + '\ufff0'))}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      rows: Array<{ id: string }>;
    };
    return data.rows.map(r => r.id);
  }

  async searchByContent(query: string, limit = 20): Promise<Array<{ id: string; snippet: string }>> {
    const allIds = await this.listByPrefix('');
    const results: Array<{ id: string; snippet: string }> = [];
    const lowerQuery = query.toLowerCase();

    for (const id of allIds) {
      if (id.startsWith('h:') || id.startsWith('_')) continue;
      if (!id.endsWith('.md')) continue;
      if (results.length >= limit) break;

      try {
        const content = await this.readFile(id);
        if (!content) continue;

        const lowerContent = content.toLowerCase();
        const idx = lowerContent.indexOf(lowerQuery);
        if (idx === -1) continue;

        const start = Math.max(0, idx - 40);
        const end = Math.min(content.length, idx + query.length + 40);
        const snippet = (start > 0 ? '...' : '') +
          content.slice(start, end).replace(/\n/g, ' ') +
          (end < content.length ? '...' : '');

        results.push({ id, snippet });
      } catch {
        // Skip unreadable docs
      }
    }

    return results;
  }

  async deleteFile(filePath: string): Promise<void> {
    const meta = await this.getDoc<LiveSyncMetaDoc>(filePath);
    if (meta?._rev) {
      await this.deleteDoc(filePath, meta._rev);
      this.logger.log(`Deleted from CouchDB: ${filePath}`);
    }
  }

  private chunkId(content: string): string {
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 40);
    return `h:${hash}`;
  }

  private async getDoc<T = Record<string, unknown>>(id: string): Promise<T | null> {
    const res = await fetch(
      `${this.baseUrl}/${encodeURIComponent(id)}`,
      { headers: this.headers },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`CouchDB GET failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async putDoc(doc: Record<string, unknown>): Promise<{ ok: boolean; id: string; rev: string }> {
    const id = doc._id as string;
    const res = await fetch(
      `${this.baseUrl}/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify(doc),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CouchDB PUT failed for "${id}": ${res.status} ${body}`);
    }
    return (await res.json()) as { ok: boolean; id: string; rev: string };
  }

  private async deleteDoc(id: string, rev: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/${encodeURIComponent(id)}?rev=${encodeURIComponent(rev)}`,
      { method: 'DELETE', headers: this.headers },
    );
    if (!res.ok) {
      throw new Error(`CouchDB DELETE failed for "${id}": ${res.status} ${res.statusText}`);
    }
  }
}
