import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly vectorSize = 1536; // text-embedding-3-small

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('qdrant.url', 'http://qdrant:6333');
    this.collection = this.config.get<string>('qdrant.collection', 'notes');
  }

  async onModuleInit(): Promise<void> {
    await this.ensureCollection();
  }

  private async ensureCollection(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}`);
    if (res.ok) {
      const data = (await res.json()) as {
        result?: { config?: { params?: { vectors?: Record<string, unknown>; sparse_vectors?: Record<string, unknown> } } };
      };
      const params = data.result?.config?.params;
      const isHybrid = !!params?.vectors?.dense && !!params?.sparse_vectors?.text;
      if (isHybrid) {
        this.logger.log(`Qdrant collection "${this.collection}" exists (hybrid)`);
        return;
      }
      // Legacy single-vector schema — recreate for hybrid search.
      // Data is rebuilt from CouchDB, so a follow-up /reindex is required.
      this.logger.warn(`Recreating "${this.collection}" for hybrid search — run /reindex to repopulate`);
      await fetch(`${this.baseUrl}/collections/${this.collection}`, { method: 'DELETE' });
    }

    const createRes = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          dense: { size: this.vectorSize, distance: 'Cosine' },
        },
        sparse_vectors: {
          text: { modifier: 'idf' },
        },
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Failed to create Qdrant collection: ${createRes.status} ${body}`);
    }

    this.logger.log(`Qdrant collection "${this.collection}" created (hybrid)`);
  }

  /**
   * Upsert one chunk. `pointKey` is the unique point identity (e.g.
   * `notes/foo.md#2`); `payload.doc_id` carries the owning note so all chunks
   * of a note can be found/deleted together.
   */
  async upsert(
    pointKey: string,
    dense: number[],
    sparse: SparseVector,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Qdrant needs numeric or UUID ids, use hash of the point key.
    const numericId = this.hashId(pointKey);

    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id: numericId,
            vector: { dense, text: { indices: sparse.indices, values: sparse.values } },
            payload,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant upsert failed: ${res.status} ${body}`);
    }
  }

  /**
   * Hybrid retrieval: dense (semantic) + sparse (BM25/keyword) prefetch,
   * merged with Reciprocal Rank Fusion. Falls back to dense-only when the
   * query has no usable sparse terms.
   */
  async queryHybrid(dense: number[], sparse: SparseVector, limit = 5): Promise<SearchResult[]> {
    const hasSparse = sparse.indices.length > 0;

    const body = hasSparse
      ? {
          prefetch: [
            { query: dense, using: 'dense', limit: limit * 4 },
            { query: { indices: sparse.indices, values: sparse.values }, using: 'text', limit: limit * 4 },
          ],
          query: { fusion: 'rrf' },
          limit,
          with_payload: true,
        }
      : { query: dense, using: 'dense', limit, with_payload: true };

    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      this.logger.warn(`Qdrant query failed: ${res.status} ${await res.text()}`);
      return [];
    }

    const data = (await res.json()) as {
      result?: { points?: Array<{ id: number; score: number; payload: Record<string, unknown> }> };
    };

    return (data.result?.points ?? []).map((r) => ({
      id: (r.payload.doc_id as string) || String(r.id),
      score: r.score,
      payload: r.payload,
    }));
  }

  /** Delete every chunk belonging to a note, matched by doc_id payload. */
  async delete(docId: string): Promise<void> {
    await fetch(`${this.baseUrl}/collections/${this.collection}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
      }),
    });
  }

  /**
   * Content hash stored on a note's chunks, or null if not indexed. All chunks
   * of a note share the same whole-note hash, so reading any one suffices.
   */
  async getContentHash(docId: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
        limit: 1,
        with_payload: true,
        with_vector: false,
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: { points?: Array<{ payload?: Record<string, unknown> }> };
    };
    const payload = data.result?.points?.[0]?.payload;
    // Legacy points (pre-chunking) lack chunk_index — treat as unindexed so
    // /reindex re-chunks them instead of skipping on a matching hash.
    if (payload == null || typeof payload.chunk_index !== 'number') return null;
    return (payload.content_hash as string) ?? null;
  }

  /**
   * All indexed notes as { docId, contentHash }, deduped across chunks and
   * paged via scroll. Used to reconcile deletions against CouchDB.
   */
  async scrollDocs(): Promise<Array<{ docId: string; contentHash: string | null }>> {
    const byDoc = new Map<string, string | null>();
    let offset: unknown = undefined;

    for (;;) {
      const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 256, with_payload: true, with_vector: false, offset }),
      });
      if (!res.ok) break;

      const data = (await res.json()) as {
        result?: {
          points?: Array<{ payload?: Record<string, unknown> }>;
          next_page_offset?: unknown;
        };
      };

      for (const pt of data.result?.points ?? []) {
        const docId = pt.payload?.doc_id as string | undefined;
        if (docId && !byDoc.has(docId)) {
          byDoc.set(docId, (pt.payload?.content_hash as string) ?? null);
        }
      }

      offset = data.result?.next_page_offset;
      if (!offset) break;
    }

    return [...byDoc].map(([docId, contentHash]) => ({ docId, contentHash }));
  }

  private hashId(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      const char = id.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash);
  }
}
