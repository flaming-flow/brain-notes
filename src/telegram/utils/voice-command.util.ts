export interface VoiceCommandHint {
  entityType?: 'note' | 'link' | 'task' | 'contact' | 'event' | 'music' | 'project';
  cleanedText: string;
}

const ENTITY_TYPE_PATTERNS: { pattern: RegExp; type: VoiceCommandHint['entityType'] }[] = [
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+заметк[уиа]/i, type: 'note' },
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+задач[уиа]/i, type: 'task' },
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+контакт/i, type: 'contact' },
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+событи[ея]/i, type: 'event' },
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+ссылк[уиа]/i, type: 'link' },
  { pattern: /^(?:добавь|добавить|сохрани|сохранить)\s+линк/i, type: 'link' },
  { pattern: /^(?:добавь|добавить|новая|новый|новое|создай|создать)\s+музык/i, type: 'music' },
  { pattern: /^(?:музыкальная?\s+(?:идея|заметка|скетч))\s/i, type: 'music' },
  { pattern: /^(?:добавь|добавить|новый|новое|создай|создать)\s+проект/i, type: 'project' },
  { pattern: /^проект\s/i, type: 'project' },
  // Short forms
  { pattern: /^заметк[аиу]\s/i, type: 'note' },
  { pattern: /^задач[аиу]\s/i, type: 'task' },
  { pattern: /^контакт\s/i, type: 'contact' },
];

/**
 * Parses voice-transcribed text for command prefixes.
 * Extracts entityType only — lifeArea is chosen via buttons.
 */
export function parseVoiceCommand(text: string): VoiceCommandHint {
  const remaining = text.trim();

  for (const { pattern, type } of ENTITY_TYPE_PATTERNS) {
    const match = remaining.match(pattern);
    if (match) {
      const cleanedText = remaining.slice(match[0].length).trim();
      return {
        entityType: type,
        cleanedText: cleanedText || remaining,
      };
    }
  }

  return { cleanedText: remaining };
}
