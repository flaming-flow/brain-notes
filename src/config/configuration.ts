export default () => ({
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    authorizedChatId: parseInt(process.env.AUTHORIZED_CHAT_ID || '0', 10),
  },
  vault: {
    basePath: process.env.VAULT_PATH || './vault',
  },
  ai: {
    provider: (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic',
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      askModel: process.env.ASK_MODEL || 'gpt-5-mini',
      contentModel: process.env.CONTENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1',
    },
    // /ask tuning — all env-configurable (no code constants).
    ask: {
      reasoningEffort: process.env.ASK_REASONING_EFFORT || 'low', // minimal|low|medium|high (reasoning models only)
      verify: process.env.ASK_VERIFY === 'true', // second fact-check pass; off by default (adds latency)
      contextBudgetChars: parseInt(process.env.ASK_CONTEXT_BUDGET_CHARS || '200000', 10),
      noteMaxChars: parseInt(process.env.ASK_NOTE_MAX_CHARS || '4000', 10),
      sourceLimit: parseInt(process.env.ASK_SOURCE_LIMIT || '10', 10),
      widePool: parseInt(process.env.ASK_WIDE_POOL || '500', 10),
    },
    // Content generation tuning — all env-configurable.
    content: {
      topicCount: parseInt(process.env.CONTENT_TOPIC_COUNT || '10', 10), // how many topics /generate suggests
      topicSampleSize: parseInt(process.env.CONTENT_TOPIC_SAMPLE || '25', 10), // notes randomly sampled per call (variety, not repetition)
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20241022',
    },
  },
  transcription: {
    model: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
  },
  qdrant: {
    url: process.env.QDRANT_URL || 'http://qdrant:6333',
    collection: process.env.QDRANT_COLLECTION || 'notes',
  },
  couchdb: {
    url: process.env.COUCHDB_URL || 'http://couchdb:5984',
    username: process.env.COUCHDB_USER || 'admin',
    password: process.env.COUCHDB_PASSWORD || 'changeme',
    database: process.env.COUCHDB_DB_NAME || 'obsidian-livesync',
  },
});
