import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  X,
  Loader2,
  Download,
  ExternalLink,
  Users,
  Database,
  AlertCircle,
  SlidersHorizontal
} from 'lucide-react';
import { api, TorrentSearchResult } from '../api/client.ts';
import { formatBytes } from '../utils/formatters.ts';

interface TorrentSearchPanelProps {
  onAdd: (
    source: string,
    size: number,
    title: string,
    infoHash?: string,
    sourceUrl?: string,
    descriptorUrl?: string,
    metadata?: {
      name: string;
      hash: string;
      files: { index: number; name: string; size: number; path: string; type: string; priority?: number }[];
      totalSize: number;
    }
  ) => void | Promise<void>;
}

function formatPublished(value?: string) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const TorrentSearchPanel: React.FC<TorrentSearchPanelProps> = ({ onAdd }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TorrentSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState<'time' | 'size' | 'seeds'>('seeds');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');
  const [minSeeders, setMinSeeders] = useState(0);
  const [showRecentSearches, setShowRecentSearches] = useState(false);
  const [addingTorrentKey, setAddingTorrentKey] = useState<string | null>(null);

  // Metadata is prefetched in small batches so search remains fast while the
  // most likely results are already resolved when the user clicks Add.
  const metadataCacheRef = useRef(new Map<string, {
    name: string;
    hash: string;
    files: { index: number; name: string; size: number; path: string; type: string; priority?: number }[];
    totalSize: number;
  }>());
  const metadataInFlightRef = useRef(new Set<string>());
  const prefetchGenerationRef = useRef(0);
  const recentSearchRef = useRef<HTMLDivElement | null>(null);
  const apiFetchRecent = (input: RequestInfo | URL, init?: RequestInit) => {
    const base = (String(import.meta.env.VITE_API_URL || '').trim() || 'https://torrent-studio-vercel-render-seedr-26fd.onrender.com').replace(/\/+$/, '');
    const value = String(input);
    return fetch(value.startsWith('/') ? base + value : value, init);
  };

  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('seedflow_recent_searches');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string').slice(0, 10)
        : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let cancelled = false;

    apiFetchRecent('/api/search/recent')
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (cancelled) return;
        const serverRecents = Array.isArray(data?.searches)
          ? data.searches.filter((value: unknown): value is string => typeof value === 'string').slice(0, 7)
          : [];
        if (serverRecents.length > 0) {
          setRecentSearches(serverRecents);
          try {
            localStorage.setItem('seedflow_recent_searches', JSON.stringify(serverRecents));
          } catch {}
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showRecentSearches) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !recentSearchRef.current?.contains(target)) {
        setShowRecentSearches(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [showRecentSearches]);

  const saveRecentSearch = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;

    setRecentSearches(prev => {
      const next = [
        normalized,
        ...prev.filter(item => item.toLowerCase() !== normalized.toLowerCase())
      ].slice(0, 7);

      try {
        localStorage.setItem('seedflow_recent_searches', JSON.stringify(next));
      } catch {}

      void apiFetchRecent('/api/search/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search: normalized })
      }).catch(() => {});

      return next;
    });
  };








  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('Enter at least 2 characters to search.');
      setResults([]);
      setSearched(false);
      return;
    }

    try {
      setIsSearching(true);
      setShowRecentSearches(false);
      setError('');
      saveRecentSearch(trimmed);
      const data = await api.searchTorrents(trimmed, 50);
      setResults(data);
      setSearched(true);

      // Do not wait for metadata before displaying results. Start resolving
      // the first two results immediately, then the next two after that batch
      // finishes. The cache is used by Add when available.
      const generation = ++prefetchGenerationRef.current;
      void (async () => {
        const candidates = data.slice(0, 4);
        for (let start = 0; start < candidates.length; start += 2) {
          if (prefetchGenerationRef.current !== generation) return;

          const batch = candidates.slice(start, start + 2);
          await Promise.allSettled(batch.map(async (result) => {
            const source = result.magnetUrl || result.downloadUrl || result.sourceUrl;
            const key = result.infoHash || source || result.title;
            if (!source || !key || metadataCacheRef.current.has(key) || metadataInFlightRef.current.has(key)) {
              return;
            }

            metadataInFlightRef.current.add(key);
            try {
              const metadata = await api.inspectMagnet(
                source,
                'Downloads',
                result.infoUrl || result.sourceUrl || '',
                result.descriptorUrl || ''
              );

              if (
                metadata &&
                !metadata.pending &&
                Array.isArray(metadata.files) &&
                metadata.files.length > 0
              ) {
                metadataCacheRef.current.set(key, {
                  name: String(metadata.name || '').trim(),
                  hash: String(metadata.hash || result.infoHash || '').trim(),
                  files: metadata.files,
                  totalSize: Number(metadata.totalSize || 0)
                });
              }
            } catch {
              // Add will simply resolve this result on demand if prefetch fails.
            } finally {
              metadataInFlightRef.current.delete(key);
            }
          }));
        }
      })();

      if (data.length === 0) {
        setError('No matching torrent results were found.');
      }
    } catch (err: any) {
      setResults([]);
      setSearched(true);
      setError(err?.message || 'Torrent search failed.');
    } finally {
      setIsSearching(false);
    }
  };

  const sortedResults = useMemo(() => {
    const sorted = results.filter(result => (Number(result.seeders) || 0) >= minSeeders);

    sorted.sort((a, b) => {
      let aValue = 0;
      let bValue = 0;

      if (sortBy === 'time') {
        aValue = a.publishDate ? new Date(a.publishDate).getTime() : 0;
        bValue = b.publishDate ? new Date(b.publishDate).getTime() : 0;
      } else if (sortBy === 'size') {
        aValue = Number(a.size) || 0;
        bValue = Number(b.size) || 0;
      } else {
        aValue = Number(a.seeders) || 0;
        bValue = Number(b.seeders) || 0;
      }

      const comparison = aValue - bValue;
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [results, minSeeders, sortBy, sortDirection]);

  return (
    <div className="space-y-2.5 sm:space-y-4">
      <div className="p-2.5 sm:p-5 rounded-xl sm:rounded-2xl bg-slate-900 border border-slate-800">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Search className="w-5 h-5 text-cyan-400" />
            Search Torrents
          </h2>
          <p className="hidden sm:block text-xs text-slate-400">
            Search cached torrent indexes for movies and TV. Search works independently of the Render backend.
          </p>
        </div>

        <form data-torrent-search="true" onSubmit={runSearch} className="mt-2.5 sm:mt-4 flex flex-row gap-1.5 sm:gap-2">
          <div ref={recentSearchRef} className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onFocus={() => {
                if (!searched && recentSearches.length > 0) setShowRecentSearches(true);
              }}
              onChange={(e) => {
                setQuery(e.target.value);
                if (error) setError('');
                if (recentSearches.length > 0) setShowRecentSearches(true);
              }}
              placeholder="Search movies, TV, music, software..."
              className="w-full pl-9 pr-10 py-2 sm:py-2.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20"
            />
            {query && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  setError('');
                  setSearched(false);
                  setResults([]);
                  setShowRecentSearches(recentSearches.length > 0);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {showRecentSearches && recentSearches.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-2 z-30 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800">
                  <span className="text-[11px] font-semibold text-slate-400">Recent Searches</span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {recentSearches.slice(0, 7).map((search, index) => (
                    <div
                      key={search}
                      className="flex items-center gap-1 border-b border-slate-800/70 last:border-b-0 hover:bg-slate-800 transition"
                    >
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setQuery(search);
                          setError('');
                          setShowRecentSearches(false);
                          // A recent search is already a known-good query, so
                          // run it immediately instead of making the user press
                          // Search again.
                          window.setTimeout(() => {
                            const form = document.querySelector('form[data-torrent-search="true"]') as HTMLFormElement | null;
                            form?.requestSubmit();
                          }, 0);
                        }}
                        className="min-w-0 flex-1 px-3 py-2.5 text-left flex items-center gap-2.5 active:bg-slate-700 transition"
                      >
                        <span className="w-5 h-5 shrink-0 rounded-md bg-slate-800 text-slate-500 text-[10px] font-bold flex items-center justify-center">
                          {index + 1}
                        </span>
                        <span className="truncate text-xs text-slate-200">{search}</span>
                      </button>

                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setRecentSearches(prev => {
                            const next = prev.filter(item => item !== search);
                            try {
                              localStorage.setItem('seedflow_recent_searches', JSON.stringify(next));
                            } catch {}
                            return next;
                          });
                        }}
                        className="mr-2 p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition shrink-0"
                        title="Delete recent search"
                        aria-label={`Delete recent search: ${search}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={isSearching}
            className="w-10 sm:w-auto px-2 sm:px-4 py-2 rounded-lg sm:rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 text-xs font-bold flex items-center justify-center gap-2 transition"
          >
            {isSearching ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                <span className="hidden sm:inline">Search</span>
              </>
            )}
          </button>
        </form>


      </div>

      {error && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{error}</div>
            {error.toLowerCase().includes('configured') ? (
              <div className="text-amber-400/80 mt-1">
                Try the full movie or series title, and include a year or season/episode when needed.
              </div>
            ) : null}
          </div>
        </div>
      )}

      {sortedResults.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
            <div className="text-xs text-slate-400">
              {sortedResults.length} of {results.length} result{results.length === 1 ? '' : 's'}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 text-xs">
              <select
                value={minSeeders}
                onChange={(e) => setMinSeeders(Number(e.target.value))}
                className="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-cyan-500"
                title="Minimum seeders"
                aria-label="Minimum seeders"
              >
                <option value={0}>All seeders</option>
                <option value={1}>1+ seeders</option>
                <option value={5}>5+ seeders</option>
                <option value={10}>10+ seeders</option>
                <option value={20}>20+ seeders</option>
                <option value={50}>50+ seeders</option>
              </select>
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                <select
                  value={sortBy}
                  onChange={(e) => {
                    const nextSortBy = e.target.value as 'time' | 'size' | 'seeds';
                    setSortBy(nextSortBy);
                    // Time and seed counts default to descending; file size
                    // defaults to ascending so the smallest result appears first.
                    setSortDirection(nextSortBy === 'size' ? 'asc' : 'desc');
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-cyan-500"
                  title="Sort search results"
                >
                  <option value="time">Time</option>
                  <option value="size">Size</option>
                  <option value="seeds">Seeds</option>
                </select>
              </div>

              <select
                value={sortDirection}
                onChange={(e) => setSortDirection(e.target.value as 'desc' | 'asc')}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-cyan-500"
                title="Sort order"
                aria-label="Sort order"
              >
                <option value="desc">
                  {sortBy === 'time' ? 'Newest first' : sortBy === 'size' ? 'Largest first' : 'Most seeds first'}
                </option>
                <option value="asc">
                  {sortBy === 'time' ? 'Oldest first' : sortBy === 'size' ? 'Smallest first' : 'Fewest seeds first'}
                </option>
              </select>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900 divide-y divide-slate-800/80">
            {sortedResults.map((result, index) => (
              <div
                key={result.guid || result.infoHash || (result.title + '-' + index)}
                className="p-2.5 sm:p-4 hover:bg-slate-900/80 transition"
              >
                <div className="flex flex-row items-center gap-2 sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-cyan-500/10 border border-cyan-500/20 shrink-0">
                        <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-[13px] sm:text-sm font-semibold text-slate-100 line-clamp-2">
                          {result.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 mt-1 text-[10px] sm:text-[11px] text-slate-500">
                          <span>{result.indexer || 'Unknown indexer'}</span>
                          <span>{formatPublished(result.publishDate)}</span>
                          {result.protocol && <span className="uppercase">{result.protocol}</span>}
                          {result.infoHash && (
                            <span className="font-mono truncate max-w-[220px]" title={result.infoHash}>
                              {result.infoHash}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2 sm:mt-3 text-[11px] sm:text-xs text-slate-400">
                      <span className="font-mono">{formatBytes(result.size)}</span>
                      <span className="flex items-center gap-1 text-emerald-400">
                        <Users className="w-3.5 h-3.5" />
                        {result.seeders} seeders
                      </span>
                      <span className="text-slate-500">{result.leechers} leechers</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {result.infoUrl && (
                      <a
                        href={result.infoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                        title="Open result information"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}

                    {(() => {
                      const source = result.magnetUrl || result.downloadUrl || result.sourceUrl;
                      const torrentKey = result.infoHash || source || result.title;
                      const isAdding = addingTorrentKey === torrentKey;

                      return (
                        <button
                          type="button"
                          disabled={!source || isAdding}
                          onClick={async () => {
                            if (!source || isAdding) return;

                            setAddingTorrentKey(torrentKey);
                            try {
                              const metadata = metadataCacheRef.current.get(torrentKey);
                              await onAdd(
                                source,
                                Number(result.size) || 0,
                                result.title,
                                result.infoHash,
                                result.infoUrl || result.sourceUrl || '',
                                result.descriptorUrl || '',
                                metadata
                              );
                            } finally {
                              setAddingTorrentKey(current => current === torrentKey ? null : current);
                            }
                          }}
                          className="px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-lg sm:rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
                        >
                          {isAdding ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                          <span className="hidden sm:inline">{isAdding ? 'Adding…' : 'Add'}</span>
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isSearching && searched && sortedResults.length === 0 && !error && (
        <div className="py-14 text-center rounded-2xl bg-slate-900 border border-slate-800">
          <Search className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-slate-300">
            {results.length > 0 ? 'No results match your filters' : 'No results'}
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            {results.length > 0
              ? 'Lower the minimum seeders filter to see more results.'
              : 'Try a broader search term or enable more torrent indexers.'}
          </p>
        </div>
      )}
    </div>
  );
};
