import { Context } from 'telegraf';
import { ClassificationResult } from '../../ai/dto/classification-result.dto.js';
import { ForwardMetadata } from './forward-metadata.interface.js';

export interface PendingNote {
  content: string;
  url?: string;
  classification: ClassificationResult;
  selectedTags: string[];
  selectedAreas: string[];
  waitingForCustomTag?: boolean;
  pendingNewTag?: string;
  rankedTags?: string[];
  tagPickerPage?: number;
  tagSearchQuery?: string;
  waitingForTagSearch?: boolean;
  sourceType?: 'text' | 'voice' | 'forward' | 'photo' | 'audio';
  forwardMeta?: ForwardMetadata;
  imageFileName?: string;
  audioFileName?: string;
}

export interface PendingContact {
  step: 'name' | 'phone' | 'platforms' | 'platform_handle' | 'context_city';
  name: string;
  phone?: string;
  platforms: Record<string, string>;
  currentPlatform?: string; // which platform we're collecting handle for
  context?: string;
  cityMet?: string;
}

export interface LastSave {
  filePath: string;
  folder: string;
  fileName: string;
  lifeArea?: string;
  source?: 'own' | 'quote';
  book?: string;
  timestamp: number;
}

export interface PendingVoice {
  text: string;
  hintEntityType?: 'note' | 'link' | 'task' | 'contact' | 'event' | 'music' | 'project';
  waitingForEdit?: boolean;
  voiceFileId?: string;
  withAudio?: boolean;
}

export interface PendingMusic {
  awaitingAudio?: boolean;
  audioFileName?: string;
  awaitingTitle?: boolean;
  awaitingDescription?: boolean;
  title?: string;
}

export interface PendingEdit {
  text: string;
  filePath: string;
  fileName: string;
}

export interface SavedLocation {
  latitude: number;
  longitude: number;
  name?: string;
  timestamp: number;
}

export interface ContentGenMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface ContentGeneration {
  topic: string;
  sources: string[];
  systemPrompt: string; // persona + rules + voice samples + notes context, built once
  messages: ContentGenMessage[]; // transcript: user topic -> assistant v1 -> user feedback -> ...
  currentPost: string; // last assistant message, used by Save actions
  format: string;
  awaitingRegenPrompt?: boolean;
  // Manual edit: waiting for the author to send his own rewritten version of the post.
  awaitingEditText?: boolean;
  // Unpacker: paused after retrieval, waiting for the author's answers before generating.
  contextBlock?: string;
  voiceSamples?: string[];
  unpackQuestions?: string[];
  awaitingUnpackAnswers?: boolean;
  // Storytelling-plot axis (optional second step on top of a generated post).
  basePost?: string; // the un-plotted post (v1); plot restyles always start from here
  suggestedPlots?: { id: string; label: string }[];
  activePlot?: string; // plot id currently being previewed as v2
  plotIntensity?: number; // -2..2, 0 = base
  plotPreview?: string; // current v2 text being previewed (not yet accepted)
}

export interface SavedNoteRef {
  filePath: string;
  fileName: string;
}

export interface PendingPeople {
  noteDocId: string;
  matches: { name: string; existing: string[] }[];
}

export interface AutoLinkedContacts {
  noteDocId: string;
  names: string[];
}

export interface BotSession {
  pendingNote?: PendingNote;
  pendingContact?: PendingContact;
  pendingVoice?: PendingVoice;
  pendingMusic?: PendingMusic;
  pendingEdit?: PendingEdit;
  lastSave?: LastSave;
  savedNotes?: Record<number, SavedNoteRef>; // message_id → note ref
  lastLocation?: SavedLocation;
  templateHint?: 'note' | 'event';
  contentGen?: ContentGeneration;
  pendingPeople?: PendingPeople;
  autoLinkedContacts?: AutoLinkedContacts;
}

export type BotContext = Context & { session: BotSession };
