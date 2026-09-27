const KNABEN_URL = 'https://api.knaben.org/v1';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'movie', 'film', 'series', 'season', 'episode',
  'web', 'show', 'tv'
]);

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) || []).filter(Boolean);
}

function mediaParts(value: string): {
  title: string;
  season: number | null;
  episode: number | null;
} {
  let q = value.replace(/\s+/g, ' ').trim();

  const seasonMatch = q.match(/\b(?:season|series)\s*(\d{1,2})\b/i);
  const episodeMatch = q.match(/\bS(\d{1,2})(?:E(\d{1,3}))?\b/i);

  const season = seasonMatch
    ? Number(seasonMatch[1])
    : episodeMatch
      ? Number(episodeMatch[1])
      : null;

  const episode = episodeMatch?.[2] ? Number(episodeMatch[2]) : null;

  q = q
    .replace(/\b(?:season|series)\s*\d{1,2}\b/gi, ' ')
    .replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:2160p|1440p|1080p|720p|480p|4k|8k|webrip|web-dl|bluray|brrip|x264|x265|h264|h265|hevc|hdr)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: q, season, episode };
}

function titleMatches(title: string, targetTokens: string[]): boolean {
  const haystack = new Set(tokens(title));
  return targetTokens.every((token) => haystack.has(token));
}

function seasonMatches(title: string, season: number | null, episode: number | null): boolean {
  if (season == null) return true;

  const upper = title.toUpperCase();
  const sxe = upper.match(/\bS(\d{1,2})(?:E(\d{1,3}))?\b/);
  if (sxe) {
    if (Number(sxe[1]) !== season) return false;
    if (episode != null && (!sxe[2] || Number(sxe[2]) !== episode)) return false;
    return true;
  }

  const word = upper.match(/\bSEASON[\s._-]*(\d{1,2})\b/);
  if (word) {
    return Number(word[1]) === season && episode == null;
  }

  return false;
}

function isMediaCategory(category: string): boolean {
  if (!category) return true;
  const c = category.toLowerCase();
  if (/(anime|games|music|software|books|porn|xxx|adult)/.test(c)) return false;
  return /(video|movie|tv|television|series)/.test(c);
}

function parseIntSafe(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export async function GET(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const url = new URL(req.url, 'http://localhost');
  const query = (url.searchParams.get('q') || '').trim();
  const requestedLimit = parseIntSafe(url.searchParams.get('limit') || '50');
  const limit = Math.min(Math.max(requestedLimit || 50, 1), 50);

  if (!query) {
    return new Response(JSON.stringify([]), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const { title, season, episode } = mediaParts(query);
  const normalizedTitle = title || query;
  const targetTokens = tokens(normalizedTitle).filter((t) => !STOPWORDS.has(t));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

  try {
    const response = await fetch(KNABEN_URL, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        search_type: '100%',
        search_field: 'title',
        query: normalizedTitle,
        order_by: 'seeders',
        order_direction: 'desc',
        from: 0,
        size: 300,
        hide_unsafe: true,
        hide_xxx: true,
        seconds_since_last_seen: 604800
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Knaben returned HTTP ${response.status}`);
    }

    const payload: any = await response.json();
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];

    const filtered = hits
      .filter((hit: any) => {
        const name = String(hit?.title || '').trim();
        const category = String(hit?.category || '').trim();

        if (!name) return false;
        if (targetTokens.length && !titleMatches(name, targetTokens)) return false;
        if (!isMediaCategory(category)) return false;
        if (!seasonMatches(name, season, episode)) return false;

        return true;
      })
      .map((hit: any) => {
        const magnet = String(hit?.magnetUrl || '').trim();
        const hash = String(hit?.hash || '').trim().toLowerCase();

        return {
          guid: `knaben-${String(hit?.id || hash || hit?.title || '')}`,
          title: String(hit?.title || ''),
          size: parseIntSafe(hit?.bytes),
          seeders: parseIntSafe(hit?.seeders),
          leechers: parseIntSafe(hit?.peers),
          indexer: String(hit?.cachedOrigin || hit?.tracker || 'Knaben'),
          protocol: 'torrent',
          publishDate: String(hit?.date || ''),
          infoHash: /^[0-9a-f]{40}$/i.test(hash) ? hash : '',
          magnetUrl: magnet || undefined,
          downloadUrl: magnet || undefined,
          infoUrl: String(hit?.details || ''),
          sourceUrl: String(hit?.details || ''),
          category
        };
      });

    filtered.sort((a: any, b: any) => {
      const aExact = tokens(a.title).join(' ') === tokens(normalizedTitle).join(' ') ? 1 : 0;
      const bExact = tokens(b.title).join(' ') === tokens(normalizedTitle).join(' ') ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return Number(b.seeders || 0) - Number(a.seeders || 0);
    });

    const seen = new Set<string>();
    const results = filtered.filter((item: any) => {
      const key = item.infoHash || item.magnetUrl || item.guid;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);

    return new Response(JSON.stringify(results), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 's-maxage=30, stale-while-revalidate=120'
      }
    });
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'Search provider timed out'
      : String(error?.message || 'Search provider failed');

    return new Response(JSON.stringify({
      error: message,
      results: []
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 's-maxage=10, stale-while-revalidate=30'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const maxDuration = 6;
