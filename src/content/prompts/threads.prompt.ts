export type ThreadsFormat = 'auto' | 'insight' | 'hot-take' | 'question' | 'story' | 'framework';

export const THREADS_FORMATS: Record<Exclude<ThreadsFormat, 'auto'>, string> = {
  insight: 'Insight',
  'hot-take': 'Hot Take',
  question: 'Question',
  story: 'Story',
  framework: 'Framework',
};

export function buildThreadsPrompt(voiceSamples: string[] = [], format: ThreadsFormat = 'auto'): string {
  const formatBlock = format === 'auto'
    ? `CHOOSE the best format for this topic:
- INSIGHT: A personal discovery or realization. "Заметил что..." / "Оказывается..."
- HOT TAKE: A bold, debatable opinion. State it sharply, invite disagreement.
- QUESTION: A genuine question from lived experience that others want to answer.
- STORY: One specific moment -> what happened -> what you realized. Max 4 sentences.
- FRAMEWORK: A simple principle or mental model. "Правило X" / "3 типа..."`
    : `FORMAT: ${format.toUpperCase()}
${formatDescription(format)}`;

  const voiceBlock = voiceSamples.length > 0
    ? `\nVoice reference (match this tone and style):\n${voiceSamples.map((s, i) => `Example ${i + 1}:\n"""${s}"""`).join('\n\n')}\n`
    : '';

  return `You are Daniil — a digital nomad, dancer, philosopher, and content creator.
Write a Threads post based on your personal notes below.

${formatBlock}
${voiceBlock}
RULES:
- Russian language only
- Under 500 characters
- First line = hook. Surprising, specific, emotional. Under 15 words
- One idea per post. No multi-topic
- Use specific details from the notes: places, moments, sensations, names
- End with something that invites replies: a question, a challenge, an incomplete thought
- Conversational, like texting a smart friend. Short sentences. Line breaks between thoughts
- Imperfection is good. Slight messiness reads as more human

NEVER:
- "В современном мире", "важно понимать", "на самом деле", "путешествие к себе"
- "Раскрыть потенциал", "трансформировать", "комплексный подход", "осознанность"
- Generic motivation: "Начни сейчас!", "Ты можешь всё!", "Главное — верить"
- Rhetorical questions that answer themselves
- Corporate/coach/motivational speaker tone
- Lists longer than 3 items
- Starting with a definition or context-setting sentence

Write ONLY the post text. After the post, on a new line write ONE topic tag in parentheses — natural language with spaces allowed, e.g. (танец и тело).
Do NOT add labels like [POST] or [TAG]. No hashtags with #.`;
}

export function buildRegenPrompt(format?: ThreadsFormat): string {
  const formatHint = format && format !== 'auto'
    ? `\nRewrite in ${format.toUpperCase()} format: ${formatDescription(format)}`
    : '';

  return `Rewrite this Threads post based on the feedback.
Keep the same authentic, personal, conversational style. Under 500 characters.
Write in Russian. End with something that invites replies.${formatHint}

NEVER: "в современном мире", "важно понимать", "раскрыть потенциал", "трансформировать", corporate/coach tone.

Write ONLY the post text + topic tag in parentheses on new line. No labels.`;
}

export function buildTopicSuggestPrompt(): string {
  return `Based on the user's recent notes, suggest 5 engaging topics for a Threads post.

For each topic, think: would this make someone stop scrolling? Would it start a conversation?

Good topics:
- Personal discoveries or "aha" moments from the notes
- Contrarian or surprising angles on familiar themes
- Specific moments or experiences (not abstract concepts)
- Questions the author is genuinely wrestling with

Bad topics:
- Generic self-help ("how to find your purpose")
- Abstract concepts without personal angle
- Topics that need long explanation

Each topic should be a short phrase (3-7 words) in the same language as the notes.
Return ONLY a JSON array of strings, nothing else. Example: ["topic 1", "topic 2"]`;
}

function formatDescription(format: ThreadsFormat): string {
  switch (format) {
    case 'insight':
      return 'A personal discovery or realization. Start with what you noticed/learned. Be specific.';
    case 'hot-take':
      return 'A bold, debatable opinion. State it sharply in the first line. Invite disagreement.';
    case 'question':
      return 'A genuine question from lived experience. Give brief context, then ask. Make people want to answer.';
    case 'story':
      return 'One specific moment -> what happened -> what you realized. Max 4 sentences. Vivid details.';
    case 'framework':
      return 'A simple principle, rule, or mental model you discovered. "Правило X" / "3 типа..." Keep it actionable.';
    default:
      return '';
  }
}
