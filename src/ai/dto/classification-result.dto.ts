export interface ClassificationResult {
  entityType: 'note' | 'link' | 'task' | 'task_list' | 'contact' | 'event' | 'music' | 'project';
  title: string;
  suggestedTags: string[];
  lifeArea: string;
  confidence: number;
  source?: 'own' | 'quote';
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
  recurrence?: string;
  items?: string[];
  quoteData?: {
    author?: string;
    bookTitle?: string;
  };
  contactData?: {
    name: string;
    context?: string;
    platforms?: Record<string, string>;
    cityMet?: string;
  };
  eventData?: {
    eventName: string;
    date?: string;
    location?: string;
    organizer?: string;
  };
  musicData?: {
    hasAudio: boolean;
    audioFileName?: string;
    description?: string;
  };
  projectData?: {
    goal: string;
    actionPlan?: string[];
    lifeAreas?: string[];
  };
  mentionedPeople?: string[];
}
