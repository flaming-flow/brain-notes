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

  async upsert(
    id: string,
    dense: number[],
    sparse: SparseVector,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Qdrant needs numeric or UUID ids, use hash of string id
    const numericId = this.hashId(id);

    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id: numericId,
            vector: { dense, text: { indices: sparse.indices, values: sparse.values } },
            payload: { ...payload, doc_id: id },
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

  async delete(id: string): Promise<void> {
    const numericId = this.hashId(id);
    await fetch(`${this.baseUrl}/collections/${this.collection}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: [numericId] }),
    });
  }

  /** Existing content hash for a doc, or null if the point isn't indexed. */
  async getContentHash(docId: string): Promise<string | null> {
    const numericId = this.hashId(docId);
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [numericId], with_payload: true }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: Array<{ payload?: Record<string, unknown> }>;
    };
    const payload = data.result?.[0]?.payload;
    // Guard against hash-id collisions: only trust the hash if doc_id matches.
    if (payload?.doc_id !== docId) return null;
    return (payload?.content_hash as string) ?? null;
  }

  /** All indexed points as { docId, contentHash }, paged via scroll. */
  async scrollDocs(): Promise<Array<{ docId: string; contentHash: string | null }>> {
    const out: Array<{ docId: string; contentHash: string | null }> = [];
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
        if (docId) out.push({ docId, contentHash: (pt.payload?.content_hash as string) ?? null });
      }

      offset = data.result?.next_page_offset;
      if (!offset) break;
    }

    return out;
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
