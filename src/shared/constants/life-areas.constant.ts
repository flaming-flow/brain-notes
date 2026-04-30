export const LIFE_AREAS = [
  'dance',
  'movement',
  'philosophy',
  'travel',
  'content',
  'tech',
  'people',
  'health',
  'music',
] as const;

export type LifeArea = (typeof LIFE_AREAS)[number];
