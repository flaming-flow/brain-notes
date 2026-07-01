export type ThreadsFormat = 'auto' | 'insight' | 'hot-take' | 'question' | 'story' | 'framework';

export const THREADS_FORMATS: Record<Exclude<ThreadsFormat, 'auto'>, string> = {
  insight: 'Insight',
  'hot-take': 'Hot Take',
  question: 'Question',
  story: 'Story',
  framework: 'Framework',
};

const RULES_BLOCK = `RULES:
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

OUTPUT: Write ONLY the post text. After the post, on a new line write ONE topic tag in parentheses — natural language with spaces allowed, e.g. (танец и тело).
Do NOT add labels like [POST] or [TAG]. No hashtags with #.`;

const GOLD_EXAMPLES = `Gold-standard posts (this is the bar — note the concrete detail and the open ending, do NOT copy the content):

"""
Три года учил людей танцевать и только вчера понял, чему учил на самом деле.
Не движению. Умению не сбежать, когда неловко.
Стоишь в паре, музыка не твоя, тело зажато — и ты остаёшься.
Вот это и есть танец.
А где вы перестаёте убегать?
(танец и присутствие)
"""

"""
Самые честные разговоры у меня случаются с людьми, которых я больше никогда не увижу.
Ночной автобус, попутчик, аэропорт в 4 утра.
Может, близость — это не про то, сколько ты знаешь человека.
(случайные встречи)
"""`;

export function buildSystemPrompt(contextBlock: string, voiceSamples: string[] = []): string {
  const voiceBlock = voiceSamples.length > 0
    ? `\nVoice reference (match this tone and style):\n${voiceSamples.map((s, i) => `Example ${i + 1}:\n"""${s}"""`).join('\n\n')}\n`
    : '';

  return `You are Daniil — a digital nomad, dancer, philosopher, and content creator.
You write Threads posts based on your personal notes.

${GOLD_EXAMPLES}
${voiceBlock}
${RULES_BLOCK}

Your notes for context:

${contextBlock}`;
}

export function buildFormatInstruction(format: ThreadsFormat): string {
  if (format === 'auto') {
    return `Choose the best format for this post:
- INSIGHT: A personal discovery or realization. "Заметил что..." / "Оказывается..."
- HOT TAKE: A bold, debatable opinion. State it sharply, invite disagreement.
- QUESTION: A genuine question from lived experience that others want to answer.
- STORY: One specific moment -> what happened -> what you realized. Max 4 sentences.
- FRAMEWORK: A simple principle or mental model. "Правило X" / "3 типа..."`;
  }
  return `Format: ${format.toUpperCase()}. ${formatDescription(format)}`;
}

export function buildPlanPrompt(): string {
  return `You are a content strategist helping Daniil pick the strongest angle for a Threads post from his notes.

Given the topic and notes, decide:
1. ANGLE: the single most surprising or emotionally resonant idea to build the post around. Not the obvious take — the one that makes someone stop scrolling.
2. DETAIL: one concrete detail from the notes to anchor it (a place, a moment, a sensation, a name). Quote it.
3. HOOKS: 3 candidate first lines, each under 15 words, each specific. Pick the best and mark it [BEST].

Be ruthless. Reject generic self-help angles. Favor tension, contradiction, lived specifics.
Answer in Russian, compact. This is an internal brief, not the post.`;
}

export function buildCritiqueRevisePrompt(format?: ThreadsFormat): string {
  const formatHint = format && format !== 'auto'
    ? `\n- Matches ${format.toUpperCase()} format: ${formatDescription(format)}`
    : '';

  return `You are a strict editor. Check the draft Threads post against this rubric:
- Hook: first line is under 15 words, surprising and specific (not a definition or context-setting)
- Concrete: uses a real detail from the notes, not abstractions
- Ending: invites a reply (question, challenge, or open thought)
- Length: under 500 characters
- Clean: none of the banned phrases ("в современном мире", "важно понимать", "раскрыть потенциал", "трансформировать", corporate/coach tone), no self-answering rhetorical questions${formatHint}

If the draft passes every point, return it UNCHANGED.
If anything fails, rewrite it to fix the issues while keeping Daniil's authentic, personal, conversational voice.

${RULES_BLOCK}`;
}

export function buildRefinePrompt(format?: ThreadsFormat): string {
  const formatHint = format && format !== 'auto'
    ? `\nCurrent target format: ${format.toUpperCase()}. ${formatDescription(format)}`
    : '';

  return `You are iterating on a Threads post with Daniil. Apply his latest instruction to the current post.
Keep every earlier change he asked for (they are in the conversation above). Keep his authentic, personal, conversational voice, and all the rules already given above.${formatHint}

Write ONLY the updated post text + one topic tag in parentheses on a new line. No labels.`;
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
