import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { QdrantService } from './qdrant.service.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openai: OpenAI;
  private readonly model = 'text-embedding-3-small';

  constructor(
    private readonly config: ConfigService,
    private readonly qdrant: QdrantService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
  }

  async indexNote(docId: string, content: string): Promise<void> {
    try {
      // Strip frontmatter for embedding
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || content;

      if (body.length < 10) return; // Skip very short notes

      const vector = await this.embed(body);

      // Extract metadata from frontmatter
      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const areaMatch = content.match(/^life_area:\s*(.+)$/m);
      const tagsMatch = content.match(/^tags:\s*\[(.+)\]$/m);

      await this.qdrant.upsert(docId, vector, {
        type: typeMatch?.[1]?.trim() || 'note',
        life_area: areaMatch?.[1]?.trim() || '',
        tags: tagsMatch?.[1]?.trim() || '',
        preview: body.slice(0, 200),
      });

      this.logger.log(`Indexed: ${docId}`);
    } catch (err) {
      this.logger.warn(`Index failed for ${docId}: ${(err as Error).message}`);
    }
  }

  async removeNote(docId: string): Promise<void> {
    try {
      await this.qdrant.delete(docId);
    } catch {
      // Ignore
    }
  }

  async searchSimilar(query: string, limit = 5): Promise<Array<{ docId: string; score: number; preview: string }>> {
    const vector = await this.embed(query);
    const results = await this.qdrant.search(vector, limit);
    return results.map((r) => ({
      docId: r.id,
      score: r.score,
      preview: (r.payload.preview as string) || '',
    }));
  }

  async indexAllNotes(): Promise<number> {
    const prefixes = ['inbox/', 'contacts/', 'projects/'];
    let count = 0;

    for (const prefix of prefixes) {
      const ids = await this.couchSync.listByPrefix(prefix);
      for (const id of ids) {
        const content = await this.couchSync.readFile(id);
        if (content) {
          await this.indexNote(id, content);
          count++;
        }
      }
    }

    this.logger.log(`Indexed ${count} notes total`);
    return count;
  }

  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000), // Max token limit safety
    });
    return response.data[0].embedding;
  }
}
