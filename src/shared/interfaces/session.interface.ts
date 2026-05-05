import { Context } from 'telegraf';
import { ClassificationResult } from '../../ai/dto/classification-result.dto.js';
import { ForwardMetadata } from './forward-metadata.interface.js';

export interface PendingNote {
  content: string;
  url?: string;
  classification: ClassificationResult;
  selectedTags: string[];
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
  awaitingDescription?: boolean;
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

export interface BotSession {
  pendingNote?: PendingNote;
  pendingContact?: PendingContact;
  pendingVoice?: PendingVoice;
  pendingMusic?: PendingMusic;
  pendingEdit?: PendingEdit;
  lastSave?: LastSave;
  lastLocation?: SavedLocation;
  templateHint?: 'note' | 'event';
}

export type BotContext = Context & { session: BotSession };
