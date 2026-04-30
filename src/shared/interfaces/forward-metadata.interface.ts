export interface ForwardMetadata {
  sourceName: string;
  sourceType: 'user' | 'channel' | 'group' | 'hidden';
  sourceUsername?: string;
  forwardDate?: string;
}
