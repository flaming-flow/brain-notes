const URL_REGEX = /https?:\/\/[^\s<>\"']+/gi;

export function extractUrls(text: string): string[] {
  return text.match(URL_REGEX) || [];
}

export function isUrl(text: string): boolean {
  return URL_REGEX.test(text.trim());
}

export function detectSourceType(url: string): string {
  const hostname = safeHostname(url);

  if (hostname.includes('instagram.com') || hostname.includes('instagr.am')) {
    return 'instagram';
  }
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
    return 'youtube';
  }
  if (hostname.includes('tiktok.com')) {
    return 'tiktok';
  }
  if (hostname.includes('spotify.com')) {
    return 'podcast';
  }
  if (hostname.includes('medium.com') || hostname.includes('substack.com')) {
    return 'article';
  }
  if (hostname.includes('t.me') || hostname.includes('telegram.me')) {
    return 'telegram';
  }

  return 'website';
}

export async function fetchUrlTitle(url: string): Promise<string> {
  try {
    const hostname = safeHostname(url);

    // YouTube: use free oEmbed API
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as { title?: string };
        if (data.title) return data.title;
      }
    }

    // Fallback: fetch HTML and extract <title>
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'NomadBrain/1.0' },
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    // Timeout or network error — fall through
  }
  return '';
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
