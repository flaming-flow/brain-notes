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
  sourceType?: 'text' | 'voice' | 'forward' | 'photo' | 'audio';
  forwardMeta?: ForwardMetadata;
  imageFileName?: string;
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
  timestamp: number;
}

export interface PendingVoice {
  text: string;
  hintEntityType?: 'note' | 'link' | 'task' | 'contact' | 'event' | 'music' | 'project';
  waitingForEdit?: boolean;
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

export interface ContentGeneration {
  lastGenerated?: string;
  lastTopic?: string;
  lastFormat?: string;
  lastSources?: string[];
  awaitingRegenPrompt?: boolean;
}

export interface SavedNoteRef {
  filePath: string;
  fileName: string;
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
}

export type BotContext = Context & { session: BotSession };
