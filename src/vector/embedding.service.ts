import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { QdrantService } from './qdrant.service.js';
import { CouchDBSyncService } from '../couchdb/couchdb-sync.service.js';

const NOTE_PREFIXES = ['inbox/', 'contacts/', 'projects/'];
const FEED_TIMEOUT_MS = 60000;
const FEED_BACKOFF_MS = 5000;

function isNoteId(id: string): boolean {
  return id.endsWith('.md') && NOTE_PREFIXES.some((p) => id.startsWith(p));
}

// Cosine similarity above which an existing tag is auto-selected for a note.
// text-embedding-3-small produces compressed scores for short tag strings —
// tune against the real vault if pre-selection feels too eager or too sparse.
const TAG_SIM_THRESHOLD = 0.3;
const MAX_AUTO_TAGS = 3;

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openai: OpenAI;
  private readonly model = 'text-embedding-3-small';
  private readonly tagVectorCache = new Map<string, number[]>();

  static readonly TAG_SIM_THRESHOLD = TAG_SIM_THRESHOLD;
  static readonly MAX_AUTO_TAGS = MAX_AUTO_TAGS;

  constructor(
    private readonly config: ConfigService,
    private readonly qdrant: QdrantService,
    private readonly couchSync: CouchDBSyncService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
  }

  onModuleInit(): void {
    // Fire-and-forget: keeps Qdrant in sync with edits/deletions made in Obsidian.
    void this.runChangeFeed();
  }

  private async runChangeFeed(): Promise<void> {
    let since = await this.couchSync.readSyncSeq();
    if (!since) {
      // First run: start from "now" so we don't replay the whole history.
      // Run /reindex once to establish the baseline and clean phantoms.
      since = await this.couchSync.getUpdateSeq();
      await this.couchSync.writeSyncSeq(since);
    }

    this.logger.log(`Vector change-feed started from seq ${since}`);

    for (;;) {
      try {
        const { results, last_seq } = await this.couchSync.changes(since, FEED_TIMEOUT_MS);

        const seen = new Set<string>();
        for (const change of results) {
          if (seen.has(change.id) || !isNoteId(change.id)) continue;
          seen.add(change.id);

          if (change.deleted) {
            await this.removeNote(change.id);
            this.logger.log(`Feed removed: ${change.id}`);
          } else {
            const content = await this.couchSync.readFile(change.id);
            if (content) await this.indexNote(change.id, content);
          }
        }

        since = last_seq;
        await this.couchSync.writeSyncSeq(since);
      } catch (err) {
        this.logger.warn(`Change-feed error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, FEED_BACKOFF_MS));
      }
    }
  }

  async indexNote(docId: string, content: string): Promise<void> {
    try {
      // For contacts: include frontmatter (name, context, city_met)
      // For others: strip frontmatter
      const isContact = docId.startsWith('contacts/');
      let body: string;

      if (isContact) {
        // Include key frontmatter fields for better search
        const name = content.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const context = content.match(/^context:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const cityMet = content.match(/^city_met:\s*"?(.+?)"?\s*$/m)?.[1] || '';
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        const noteBody = bodyMatch?.[1]?.trim() || '';
        body = [name, context, cityMet, noteBody].filter(Boolean).join('. ');
      } else {
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        body = bodyMatch?.[1]?.trim() || content;
      }

      if (body.length < 10) return;

      // Skip re-embedding when the indexed content is identical.
      const contentHash = createHash('sha256').update(body).digest('hex');
      if ((await this.qdrant.getContentHash(docId)) === contentHash) return;

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
        content_hash: contentHash,
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
    this.logger.log(`Search "${query.slice(0, 50)}": ${results.map((r) => `${r.id}(${r.score.toFixed(2)})`).join(', ')}`);
    return results.map((r) => ({
      docId: r.id,
      score: r.score,
      preview: (r.payload.preview as string) || '',
    }));
  }

  /**
   * Full mirror of CouchDB into Qdrant: upserts current notes (skipping
   * unchanged ones via content hash) and deletes points for notes that no
   * longer exist — e.g. files deleted or renamed in Obsidian.
   */
  async indexAllNotes(): Promise<number> {
    const valid = new Set<string>();
    let count = 0;

    for (const prefix of NOTE_PREFIXES) {
      const ids = await this.couchSync.listByPrefix(prefix);
      for (const id of ids) {
        if (!isNoteId(id)) continue;
        valid.add(id);
        const content = await this.couchSync.readFile(id);
        if (content) {
          await this.indexNote(id, content);
          count++;
        }
      }
    }

    // Reconcile deletions: drop any indexed point no longer backed by a note.
    let removed = 0;
    for (const { docId } of await this.qdrant.scrollDocs()) {
      if (!valid.has(docId)) {
        await this.qdrant.delete(docId);
        removed++;
      }
    }

    this.logger.log(`Reindex done: ${count} notes indexed, ${removed} stale points removed`);
    return count;
  }

  /**
   * Rank tags by semantic relevance to the note text (cosine similarity).
   * Tag vectors are cached in-memory; only previously unseen tags are embedded.
   * Returns [] on any failure so callers can fall back to plain ordering.
   */
  async rankTags(
    noteText: string,
    tags: string[],
  ): Promise<{ tag: string; score: number }[]> {
    const unique = [...new Set(tags.filter((t) => t && t.trim()))];
    if (unique.length === 0 || noteText.trim().length === 0) return [];

    try {
      const uncached = unique.filter((t) => !this.tagVectorCache.has(t));
      if (uncached.length > 0) {
        const vectors = await this.embedBatch(uncached.map((t) => t.replace(/-/g, ' ')));
        uncached.forEach((tag, i) => {
          if (vectors[i]) this.tagVectorCache.set(tag, vectors[i]);
        });
      }

      const noteVec = await this.embed(noteText);

      return unique
        .map((tag) => {
          const vec = this.tagVectorCache.get(tag);
          return { tag, score: vec ? this.cosine(noteVec, vec) : -1 };
        })
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      this.logger.warn(`rankTags failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000), // Max token limit safety
    });
    return response.data[0].embedding;
  }

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: inputs.map((i) => i.slice(0, 8000)),
    });
    // OpenAI returns data in input order, but sort by index to be safe.
    return [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
