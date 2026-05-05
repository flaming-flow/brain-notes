export function generateFileName(title: string, date: string): string {
  const slug = slugify(title);
  if (!slug) {
    return date;
  }
  return `${date}-${slug}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // Keep unicode letters, numbers, spaces, hyphens
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
    .slice(0, 60);
}
