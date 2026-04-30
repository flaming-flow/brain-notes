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
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20241022',
    },
  },
  transcription: {
    model: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
  },
});
