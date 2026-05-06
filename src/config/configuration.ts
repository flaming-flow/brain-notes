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
      contentModel: process.env.CONTENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
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
