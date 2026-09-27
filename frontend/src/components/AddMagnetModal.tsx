import React, { useState, useEffect, useRef } from 'react';
import {
  Link2,
  X,
  FileCheck,
  Film,
  Music,
  FileArchive,
  FileText,
  FolderDown,
  CheckSquare,
  Square,
  AlertCircle,
  HelpCircle,
  Copy,
  FileDown,
  Loader2,
  Sliders,
  Check,
  Ban,
  Plus,
  Trash2,
  RotateCcw
} from 'lucide-react';
import { api } from '../api/client.ts';
import { formatBytes } from '../utils/formatters.ts';

interface AddMagnetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  onAdd: (
    magnet: string,
    category: string,
    selectedFiles?: number[],
    manifest?: { name: string; size: number; priority: number }[],
    existingHash?: string,
    forceBackend?: 'seedr' | 'qbittorrent',
    selectedNames?: string[],
     seedrTaskId?: number | string,
    torrentName?: string
  ) => Promise<void>;
  defaultFolder?: string;
  initialMagnet?: string;
}

interface InspectFileItem {
  index: number;
  name: string;
  size: number;
  type: 'video' | 'audio' | 'archive' | 'document' | 'other';
  selected: boolean;
}



export const AddMagnetModal: React.FC<AddMagnetModalProps> = ({
  isOpen,
  onClose,
  onOpen,
  onAdd,
  defaultFolder = 'Downloads',
  initialMagnet = ''
}) => {
  const [magnetInput, setMagnetInput] = useState('');
  const [category, setCategory] = useState(defaultFolder);
  const [inspectedFiles, setInspectedFiles] = useState<InspectFileItem[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionSource, setInspectionSource] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showManifestEditor, setShowManifestEditor] = useState(false);
  const [customFileCount, setCustomFileCount] = useState<number>(16);
  const [pasteManifestText, setPasteManifestText] = useState('');
  const [inspectedHash, setInspectedHash] = useState('');
  const [inspectedTorrentName, setInspectedTorrentName] = useState('');
  const [backgroundMode, setBackgroundMode] = useState(false);

  const inspectTimeoutRef = useRef<any>(null);
  const [copiedMagnet, setCopiedMagnet] = useState(false);

  // Reset or initialize modal state
  useEffect(() => {
    if (isOpen && !initialMagnet.trim()) {
      // A normal Add Magnet open must always start clean. Otherwise a
      // previously opened search result can leak into the next session.
      setMagnetInput('');
      setInspectedFiles([]);
      setInspectedHash('');
      setInspectedTorrentName('');
      setInspectionSource('');
      setCopiedMagnet(false);
    }

    if (isOpen) {
      setBackgroundMode(false);
      setError('');
      setShowManifestEditor(false);
      setPasteManifestText('');
    }
  }, [isOpen, initialMagnet]);

  const classifyFileType = (name: string): InspectFileItem['type'] => {
    const lower = String(name || '').toLowerCase();
    if (/\.(mp4|mkv|m4v|webm|mov|avi|wmv|flv|ts|m2ts)$/.test(lower)) return 'video';
    if (/\.(mp3|wav|flac|aac|ogg|m4a|opus|wma)$/.test(lower)) return 'audio';
    if (/\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/.test(lower)) return 'archive';
    if (/\.(pdf|txt|md|json|csv|srt|vtt|ass|sub)$/.test(lower)) return 'document';
    return 'other';
  };

  const inferTorrentName = (
    files: { name: string; path?: string }[],
    fallback = ''
  ): string => {
    if (fallback.trim()) return fallback.trim();

    if (!files.length) return '';

    // Multi-file torrents commonly expose paths like:
    // "Torrent Folder Name/Season 1/Episode.mkv".
    // Use the common first path segment as the folder/torrent name.
    const segments = files
      .map(file => String(file.path || file.name || '').replace(/\\/g, '/').split('/').filter(Boolean))
      .filter(parts => parts.length > 1);

    if (segments.length === files.length) {
      const first = segments[0][0];
      if (first && segments.every(parts => parts[0] === first)) {
        return first;
      }
    }

    return String(files[0]?.name || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || '';
  };

  const applyFileList = (files: { index: number; name: string; size: number; path?: string; type?: string; priority?: number }[]) => {
    const singleFile = files.length === 1;
    setInspectedFiles(
      files.map((f) => ({
        index: Number(f.index),
        name: f.name,
        size: Number(f.size || 0),
        type: (f.type as InspectFileItem['type']) || classifyFileType(f.name),
        selected: singleFile ? true : Number(f.priority ?? 0) > 0
      }))
    );
    setCustomFileCount(files.length);
    setInspectedTorrentName(prev => prev || inferTorrentName(files));
  };

  const startSingleFileDownload = async (
    source: string,
    files: { index: number; name: string; size: number; path?: string; type?: string; priority?: number }[],
    hash?: string,
    seedrTaskId?: number | string | null,
    torrentName?: string
  ) => {
    if (files.length !== 1) return;

    const file = files[0];
    const fileSize = Number(file.size || 0);

    const manifest = [{
      name: file.name,
      size: fileSize,
      priority: 1
    }];

    try {
      setIsLoading(true);
      setError('');

      // A single-file torrent needs no selection UI. Use Seedr whenever
      // the file fits in the currently available free-account space.
      // There is no hard 5 GB cutoff: remaining quota is the limit.
      let forceBackend: 'seedr' | 'qbittorrent' = 'qbittorrent';
      if (fileSize > 0) {
        try {
          const quota = await api.getSeedrQuota();
          if (quota.configured && fileSize < quota.remainingSpace) {
            forceBackend = 'seedr';
          }
        } catch {
          // Quota lookup is best-effort; fall back to qBittorrent.
        }
      }

      const selectedBackend = seedrTaskId != null ? 'seedr' : forceBackend;
      let seedrSource =
        selectedBackend === 'seedr' && hash && /^[a-f0-9]{40}$/i.test(hash)
          ? `magnet:?xt=urn:btih:${hash.toLowerCase()}`
          : source;


      await onAdd(
        seedrSource,
        category,
        [Number(file.index)],
        manifest,
        hash || undefined,
        selectedBackend,
        undefined,
        seedrTaskId ?? undefined,
        torrentName || inspectedTorrentName || file.name
      );
      setBackgroundMode(false);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to start cloud torrent download');
    } finally {
      setIsLoading(false);
    }
  };

  // Add the torrent paused first, then poll qBittorrent's real file list.
  // This avoids relying on fetchMetadata returning a complete descriptor.
  const triggerInspect = async (link: string, background = false) => {
    const source = link.trim();
    if (!source) {
      setInspectedFiles([]);
      setInspectionSource('');
      return;
    }

    try {
      setIsInspecting(true);
      setBackgroundMode(background);
      setError('');
      setInspectedFiles([]);

      // Always use qBittorrent for metadata inspection. This keeps the
      // Seedr task from starting before the user has selected files. Seedr
      // does not reliably support pausing prepared tasks on this account.
      setInspectionSource(
        isSearchGrab
          ? 'Loading torrent metadata...'
          : 'Adding torrent paused and waiting for qBittorrent metadata...'
      );

      const data = await api.inspectMagnet(source, category);

      if (data && Array.isArray(data.files) && data.files.length > 0) {
        const hash = String(data.hash || '').trim().toLowerCase();
        setInspectedHash(hash);
         const resolvedSource =
           data.source === 'search_torrent_descriptor' && hash
             ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(data.name || data.files[0]?.name || 'torrent')}`
             : source;

         if (resolvedSource !== source) {
           setMagnetInput(resolvedSource);
         }
        applyFileList(data.files);
        setInspectedTorrentName(String(data.name || '').trim());

        if (data.files.length === 1) {
           await startSingleFileDownload(
             resolvedSource,
             data.files,
             hash,
             null,
             inferTorrentName(data.files, String(data.name || '').trim())
           );
          return;
        }

         setInspectionSource(isSearchGrab ? '✓ Torrent metadata loaded • Multi-file torrent stays paused while you choose files' : '✓ qBittorrent metadata loaded • Multi-file torrent stays paused while you choose files');
        return;
      }

      const hash = String(data?.hash || '').trim().toLowerCase();
      if (!hash) {
        throw new Error(
          data?.message ||
          'qBittorrent did not return a torrent hash. Please verify the magnet URI and try again.'
        );
      }

      if (!data?.pending && data?.source !== 'qbt_torrent_pending') {
        throw new Error(data?.message || 'qBittorrent did not return the torrent file list.');
      }

      const maxAttempts = 120;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const files = await api.getTorrentFiles(hash);
          if (files.length > 0) {
            const normalizedFiles = files.map((f) => ({
              index: f.index,
              name: f.name,
              size: f.size,
              path: f.path,
              type: classifyFileType(f.name),
              priority: f.priority
            }));
            setInspectedHash(hash);
            setInspectedTorrentName(prev => prev || inferTorrentName(normalizedFiles));
            applyFileList(normalizedFiles);

            if (normalizedFiles.length === 1) {
              await startSingleFileDownload(
                source,
                normalizedFiles,
                hash,
                null,
                inferTorrentName(normalizedFiles, inspectedTorrentName)
              );
              return;
            }

            setInspectionSource('✓ qBittorrent metadata loaded • Multi-file torrent stays paused while you choose files');
            return;
          }
        } catch {
          // Metadata may not be available yet; keep polling.
        }

        const seconds = attempt * 2;
        setInspectionSource(
          `qBittorrent is resolving metadata... (${seconds}s) • Torrent is safely paused`
        );
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      throw new Error(
        'qBittorrent has not returned the file list yet. The torrent remains paused. Click Load File List to retry.'
      );
    } catch (err: any) {
      console.warn('Inspect magnet error:', err);
      setInspectedFiles([]);
      setInspectionSource('');
      setError(err?.message || 'Could not load torrent metadata from qBittorrent.');
    } finally {
      setIsInspecting(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !initialMagnet.trim()) return;

    const source = initialMagnet.trim();
    setMagnetInput(source);
    setInspectedFiles([]);
    setInspectionSource('');
    setError('');
    void triggerInspect(source, false);
  }, [isOpen, initialMagnet]);

  const handleInputChange = (val: string) => {
    setBackgroundMode(false);
    setMagnetInput(val);
    setError('');
    setInspectedFiles([]);
    setInspectedHash('');
    setInspectedTorrentName('');
    setInspectionSource('');
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
  };

  const toggleFile = (index: number) => {
    setInspectedFiles(prev =>
      prev.map(f => (f.index === index ? { ...f, selected: !f.selected } : f))
    );
  };

  const selectAll = (selected: boolean) => {
    setInspectedFiles(prev => prev.map(f => ({ ...f, selected })));
  };

  const selectOnlyVideos = () => {
    setInspectedFiles(prev =>
      prev.map(f => ({ ...f, selected: f.type === 'video' }))
    );
  };

  const selectOnlyAudio = () => {
    setInspectedFiles(prev =>
      prev.map(f => ({ ...f, selected: f.type === 'audio' }))
    );
  };

  const selectedFiles = inspectedFiles.filter(f => f.selected);
  const selectedCount = selectedFiles.length;
  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const totalTorrentSize = inspectedFiles.reduce((acc, f) => acc + f.size, 0);

  const isSingleFile = inspectedFiles.length === 1;
  const isSearchGrab = /^\/api\/search\/torrents\/grab\//i.test(magnetInput.trim());

  const isDirectSeedrSource =
    !isSearchGrab &&
    (/^magnet:\?/i.test(magnetInput.trim()) || /^[a-f0-9]{40}$/i.test(magnetInput.trim()));

  const resolveMagnetUri = async (): Promise<string> => {
    const source = magnetInput.trim();

    if (/^magnet:\?/i.test(source)) return source;
    if (/^[a-f0-9]{40}$/i.test(source)) {
      const name = inspectedFiles[0]?.name?.split('/').pop() || 'torrent';
      return `magnet:?xt=urn:btih:${source.toLowerCase()}&dn=${encodeURIComponent(name)}`;
    }

    if (source.startsWith('/api/') || /^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      const text = (await response.text()).trim();
      if (/^magnet:\?/i.test(text)) return text;
    }

    if (inspectedHash) {
      const name = inspectedFiles[0]?.name?.split('/').pop() || 'torrent';
      return `magnet:?xt=urn:btih:${inspectedHash}&dn=${encodeURIComponent(name)}`;
    }

    throw new Error('A magnet link is not available for this torrent.');
  };

  const handleCopyMagnet = async () => {
    try {
      const magnet = await resolveMagnetUri();

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(magnet);
      } else {
        const area = document.createElement('textarea');
        area.value = magnet;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand('copy');
        area.remove();
      }

      setCopiedMagnet(true);
      window.setTimeout(() => setCopiedMagnet(false), 1600);
    } catch (err: any) {
      setError(err?.message || 'Could not copy the magnet link.');
    }
  };

  const handleDownloadTorrent = async () => {
    if (!inspectedHash) {
      setError('The torrent hash is not available yet.');
      return;
    }

    try {
      const blob = await api.exportTorrent(inspectedHash);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const baseName = inspectedFiles[0]?.name?.split('/').pop() || 'torrent';
      anchor.href = url;
      anchor.download = baseName.replace(/\.[^.]+$/, '') + '.torrent';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || 'Could not download the .torrent file.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!magnetInput.trim()) {
      setError('Please provide a magnet link or hash.');
      return;
    }

    // For a pasted magnet we must know whether it contains one file or
    // multiple files before deciding which backend to use. Seedr can start
    // fetching as soon as it receives a task, so multi-file magnets are
    // inspected with qBittorrent first and remain paused until confirmed.
    if (isDirectSeedrSource && inspectedFiles.length === 0) {
      await triggerInspect(magnetInput.trim(), false);
      return;
    }


    if (isInspecting) {
      setError('Please wait while the torrent file list is being loaded.');
      return;
    }

    if (inspectedFiles.length === 0) {
      setError('Please wait for the torrent file list to load before starting the download.');
      return;
    }

    if (selectedCount === 0) {
      setError('Please select at least 1 file to download from this torrent.');
      return;
    }

    const selectedFileIndexes = inspectedFiles.filter(f => f.selected).map(f => f.index);
    const manifest = inspectedFiles.map(f => ({
      name: f.name,
      size: f.size,
      priority: f.selected ? 1 : 0
    }));

    try {
      setIsLoading(true);
      setError('');
      let selectedBackend: 'seedr' | 'qbittorrent' | undefined;
      try {
        // Once the user has selected the files, the selected size—not the
        // aggregate torrent size—determines whether Seedr can handle it.
        // This applies to pasted magnets, search/grab links, and other
        // sources that qBittorrent can inspect and resolve to an info hash.
        const quota = await api.getSeedrQuota();
        if (
          quota.configured &&
          totalSelectedSize > 0 &&
          totalSelectedSize < quota.remainingSpace &&
          totalSelectedSize >= totalTorrentSize
        ) {
          selectedBackend = 'seedr';
        }
      } catch {
        // Quota lookup is best-effort; qBittorrent remains the fallback.
      }

      let downloadSource =
        selectedBackend === 'seedr' &&
        inspectedHash &&
        /^[a-f0-9]{40}$/i.test(inspectedHash)
          ? `magnet:?xt=urn:btih:${inspectedHash.toLowerCase()}`
          : magnetInput.trim();


      await onAdd(
        downloadSource,
        category,
        selectedFileIndexes,
        manifest,
        inspectedHash || undefined,
        selectedBackend,
        undefined,
        undefined,
        inspectedTorrentName
      );
      setBackgroundMode(false);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to start cloud torrent download');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen && !backgroundMode) return null;

  if (backgroundMode) {
    const ready = !isInspecting && inspectedFiles.length > 0;
    const failed = !isInspecting && Boolean(error);

    return (
      <div className="fixed right-3 bottom-[5.75rem] md:bottom-6 z-50 w-[min(92vw,24rem)]">
        <div className="rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-slate-700 shadow-2xl p-3.5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 shrink-0">
              {isInspecting ? (
                <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
              ) : ready ? (
                <FileCheck className="w-5 h-5 text-emerald-400" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-400" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-100 truncate">
                {isInspecting ? 'Resolving torrent in background' : ready ? 'Torrent metadata ready' : 'Torrent loading failed'}
              </p>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                {isInspecting
                  ? 'You can keep using SeedFlow. The torrent remains safely paused while qBittorrent resolves its metadata.'
                  : ready
                  ? `${inspectedFiles.length} file${inspectedFiles.length === 1 ? '' : 's'} found. Open the selector when you're ready.`
                  : error}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setBackgroundMode(false);
                onOpen();
              }}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition shrink-0"
              title="Open torrent selector"
              aria-label="Open torrent selector"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {isInspecting ? (
            <div className="mt-3 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full w-1/3 bg-cyan-500 rounded-full animate-pulse" />
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setBackgroundMode(false);
                  onOpen();
                }}
                className="flex-1 px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition"
              >
                {ready ? 'Open File Selection' : 'Open & Retry'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setBackgroundMode(false);
                  onClose();
                }}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div 
        className="relative w-full max-w-3xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[96vh] sm:max-h-[94vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/95">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-slate-950 font-bold shadow-md shadow-cyan-500/20">
              <Link2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Add Magnet / .Torrent & Select Files</h3>
              <p className="text-xs text-slate-400">
                qBittorrent WebAPI • Real File Metadata & Selective Downloading
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-3 sm:space-y-4">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="font-medium">{error}</span>
            </div>
          )}

          {/* Torrent source */}
          {isSearchGrab ? (
            <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Link2 className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-semibold text-slate-200">Torrent Link</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyMagnet()}
                  className="flex-1 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-400 text-xs font-semibold transition flex items-center justify-center gap-2"
                >
                  {copiedMagnet ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copiedMagnet ? 'Magnet Copied' : 'Copy Magnet Link'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDownloadTorrent()}
                  disabled={!inspectedHash}
                  className="flex-1 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold transition flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FileDown className="w-4 h-4" />
                  Download .torrent
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Magnet URI / Torrent Hash
              </label>
              <textarea
                rows={2}
                value={magnetInput}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder="Paste magnet:?xt=urn:btih:... or torrent hash"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 text-xs font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition resize-none"
              />
              {isInspecting && (
                <div className="mt-2 text-cyan-400 flex items-center gap-1.5 text-xs font-medium animate-pulse">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-[11px]">Resolving...</span>
                </div>
              )}
            </div>
          )}

          {/* File details / selective file selection */}
          {inspectedFiles.length > 0 && (
            isSingleFile ? (
              <div className="rounded-xl bg-slate-950/90 border border-slate-800/90 p-3.5 shadow-inner">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 shrink-0">
                    {inspectedFiles[0].type === 'video' && <Film className="w-5 h-5 text-indigo-400" />}
                    {inspectedFiles[0].type === 'audio' && <Music className="w-5 h-5 text-cyan-400" />}
                    {inspectedFiles[0].type === 'document' && <FileText className="w-5 h-5 text-emerald-400" />}
                    {inspectedFiles[0].type === 'archive' && <FileArchive className="w-5 h-5 text-amber-400" />}
                    {inspectedFiles[0].type === 'other' && <HelpCircle className="w-5 h-5 text-slate-400" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold text-cyan-400 mb-1">Torrent file</div>
                    <div className="text-sm font-semibold text-slate-100 break-words">
                      {inspectedFiles[0].name}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 font-mono">
                      <span>{formatBytes(inspectedFiles[0].size)}</span>
                      <span className="text-slate-600">•</span>
                      <span>{inspectedFiles[0].type}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
          {inspectedFiles.length > 0 && (
            <div className="rounded-xl bg-slate-950/90 border border-slate-800/90 overflow-hidden shadow-inner">
              {/* Header with question and bulk controls */}
              <div className="p-3.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileCheck className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-white">
                      Which files do you want to download? ({inspectedFiles.length} files found)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {inspectionSource && (
                      <span className="text-cyan-400 font-medium mr-2">{inspectionSource} •</span>
                    )}
                    Only checked files will be downloaded. Unchecked files will be skipped.
                  </p>
                </div>

                {/* Bulk selection pills */}
                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    onClick={() => selectAll(true)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-[11px] font-medium"
                  >
                    Select All ({inspectedFiles.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAll(false)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-[11px] font-medium"
                  >
                    Deselect All
                  </button>
                  <button
                    type="button"
                    onClick={selectOnlyVideos}
                    className="px-2 py-1 rounded-lg bg-indigo-950/60 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 transition text-[11px] font-medium"
                  >
                    Videos Only
                  </button>
                  {inspectedFiles.some(f => f.type === 'audio') && (
                    <button
                      type="button"
                      onClick={selectOnlyAudio}
                      className="px-2 py-1 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition text-[11px] font-medium"
                    >
                      Audio Only
                    </button>
                  )}
                </div>
              </div>

              {/* File item list */}
              <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/60 p-1">
                {[...inspectedFiles]
                  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
                  .map((file) => (
                  <div
                    key={file.index}
                    onClick={() => toggleFile(file.index)}
                    className={`flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition select-none ${
                      file.selected
                        ? 'bg-cyan-950/20 hover:bg-cyan-950/30 text-slate-100'
                        : 'hover:bg-slate-900/50 text-slate-500 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden pr-2">
                      <div className="shrink-0">
                        {file.selected ? (
                          <CheckSquare className="w-4 h-4 text-cyan-400" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-600" />
                        )}
                      </div>
                      <div className="shrink-0">
                        {file.type === 'video' && <Film className="w-4 h-4 text-indigo-400" />}
                        {file.type === 'audio' && <Music className="w-4 h-4 text-cyan-400" />}
                        {file.type === 'document' && <FileText className="w-4 h-4 text-emerald-400" />}
                        {file.type === 'archive' && <FileArchive className="w-4 h-4 text-amber-400" />}
                        {file.type === 'other' && <HelpCircle className="w-4 h-4 text-slate-400" />}
                      </div>
                      <span className={`text-xs font-mono truncate ${file.selected ? 'font-medium text-slate-200' : 'line-through text-slate-500'}`}>
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                        file.selected
                          ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      }`}>
                        {file.selected ? '✓ Download' : '✕ Skip'}
                      </span>
                      <span className="font-mono text-xs text-slate-300 w-20 text-right">
                        {formatBytes(file.size)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Selection summary bar */}
              <div className="p-2.5 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-[11px] sm:text-xs text-slate-400">
                <span>
                  Selected: <strong className="text-cyan-400">{selectedCount}</strong> of {inspectedFiles.length} files ({inspectedFiles.length - selectedCount} skipped)
                </span>
                <span>
                  Selected Download Size: <strong className="text-cyan-400 font-mono">{formatBytes(totalSelectedSize)}</strong> / {formatBytes(totalTorrentSize)} total
                </span>
              </div>
            </div>
          )}
              </>
            )
          )}

        </form>

        {/* Modal Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-3 sm:px-5 py-3 border-t border-slate-800 bg-slate-900/95">
          <div className="text-[11px] sm:text-xs text-slate-400 w-full sm:w-auto">
            {isSingleFile && inspectedFiles.length > 0 ? (
              <span>Ready to download</span>
            ) : selectedCount > 0 ? (
              <span>Downloading <strong className="text-cyan-400">{selectedCount}</strong> file(s) ({formatBytes(totalSelectedSize)}) • {inspectedFiles.length - selectedCount} skipped</span>
            ) : inspectedFiles.length > 0 ? (
              <span className="text-rose-400">No files selected</span>
            ) : (
              <span>Paste a magnet link or torrent hash to load the file list</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (isDirectSeedrSource && inspectedFiles.length === 0) {
                  void triggerInspect(magnetInput.trim(), false);
                } else if (isDirectSeedrSource || selectedCount > 0) {
                  void handleSubmit({ preventDefault: () => {} } as React.FormEvent);
                } else if (magnetInput.trim() && !isInspecting) {
                  void triggerInspect(magnetInput.trim());
                } else if (!magnetInput.trim()) {
                  setError('Paste a magnet link, torrent hash, or upload a .torrent file first.');
                }
              }}
              disabled={
                isLoading ||
                isInspecting ||
                (inspectedFiles.length > 0 && selectedCount === 0)
              }
              className="flex-1 sm:flex-none px-4 sm:px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-cyan-500/20"
            >
              {isInspecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderDown className="w-4 h-4" />
              )}
              <span>
                {isLoading
                  ? 'Adding Task...'
                  : isSingleFile && selectedCount > 0
                  ? 'Download File'
                  : selectedCount > 0
                  ? `Download ${selectedCount} Selected File(s)`
                  : isInspecting
                  ? 'Loading File List...'
                  : !magnetInput.trim()
                  ? 'Paste Magnet First'
                  : inspectedFiles.length === 0
                  ? 'Load File List'
                  : 'Select Files to Continue'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
