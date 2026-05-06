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
      this.logger.log(`Qdrant collection "${this.collection}" exists`);
      return;
    }

    const createRes = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          size: this.vectorSize,
          distance: 'Cosine',
        },
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Failed to create Qdrant collection: ${createRes.status} ${body}`);
    }

    this.logger.log(`Qdrant collection "${this.collection}" created`);
  }

  async upsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    // Qdrant needs numeric or UUID ids, use hash of string id
    const numericId = this.hashId(id);

    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id: numericId,
            vector,
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

  async search(vector: number[], limit = 5): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
      }),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: Array<{ id: number; score: number; payload: Record<string, unknown> }>;
    };

    return data.result.map((r) => ({
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

  private hashId(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      const char = id.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash);
  }
}
