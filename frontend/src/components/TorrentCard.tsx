import React, { useState } from 'react';
import {
  Download,
  Pause,
  Play,
  Trash2,
  FileCheck,
  CheckCircle2,
  Clock,
  Users
} from 'lucide-react';
import { TorrentItem } from '../types/index.ts';
import { formatBytes, formatSpeed, formatETA } from '../utils/formatters.ts';

interface TorrentCardProps {
  torrent: TorrentItem;
  onPause: (hash: string) => Promise<void>;
  onResume: (hash: string) => Promise<void>;
  onDelete: (hash: string) => void;
  onSelectFiles: (torrent: TorrentItem) => void;
  onStream: (torrent: TorrentItem) => void;
}

export const TorrentCard: React.FC<TorrentCardProps> = ({
  torrent,
  onPause,
  onResume,
  onDelete,
  onSelectFiles,
  onStream
}) => {
  const [isActionPending, setIsActionPending] = useState(false);

  // qBittorrent 5.x can report stoppedDL/stoppedUP. Normalize the raw
  // state here as a defensive fallback so the Resume action is never hidden.
  const rawState = String(torrent.state);
  const isCompleted = (rawState === 'completed' || rawState === 'pausedUP' || rawState === 'stoppedUP') || torrent.progress >= 1;
  const isDownloading = rawState === 'downloading' || rawState === 'forcedDL' || rawState === 'metaDL' || rawState === 'forcedMetaDL';
  const isStalled = rawState === 'stalledDL';
  const isPaused = rawState === 'pausedDL' || rawState === 'stoppedDL';
  const canPause = isDownloading || isStalled;
  const canResume = isPaused;

  const totalFiles = torrent.files?.length || 1;
  const activeFiles = torrent.files ? torrent.files.filter(f => f.priority > 0).length : totalFiles;
  const skippedFiles = totalFiles - activeFiles;
  const downloadTargetSize =
    torrent.selected_size && torrent.selected_size > 0
      ? torrent.selected_size
      : torrent.total_size;

  const progressPercent = Math.round(torrent.progress * 1000) / 10;

  const statusLabel =
    isCompleted ? 'Completed' :
    isPaused ? 'Paused' :
    isStalled ? 'Stalled' :
    torrent.state === 'checkingDL' ? 'Checking' :
    torrent.state === 'error' ? 'Error' :
    torrent.state === 'uploading' ? 'Seeding' :
    torrent.state;

  const statusClass =
    isCompleted
      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
      : isPaused
      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
      : isStalled
      ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
      : isDownloading
      ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 animate-pulse'
      : torrent.state === 'error'
      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
      : 'bg-slate-800 text-slate-400';

  const handleTransferAction = async (action: () => Promise<void>) => {
    if (isActionPending) return;
    setIsActionPending(true);
    try {
      await action();
    } finally {
      setIsActionPending(false);
    }
  };

  return (
    <div
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, select, textarea')) return;
        onSelectFiles(torrent);
      }}
      className="p-3 sm:p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700/80 transition shadow-lg flex flex-col gap-3 group cursor-pointer"
      title="Open files"
    >
      {/* Top row: Title and Status */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
        <div className="overflow-hidden flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${statusClass}`}
            >
              {statusLabel}
            </span>
            <span className="text-[11px] text-slate-500 font-medium">
              {torrent.category || 'Downloads'}
            </span>
          </div>
          <h3
            className="text-sm font-semibold text-slate-100 mt-1 line-clamp-2 sm:truncate break-words group-hover:text-cyan-400 transition"
            title={torrent.name}
          >
            {torrent.name}
          </h3>
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-1 shrink-0 flex-wrap sm:flex-nowrap">
          {/* Selective Files inspector */}
          <button
            onClick={() => onSelectFiles(torrent)}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 text-xs font-medium transition flex items-center gap-1.5 tap-target justify-center"
            title="Inspect & Select Files"
          >
            <FileCheck className="w-4 h-4 text-cyan-400" />
            <span className="hidden sm:inline text-xs">
              {skippedFiles > 0
                ? `${activeFiles}/${totalFiles} files (${skippedFiles} skipped)`
                : `${totalFiles} files`}
            </span>
          </button>

          {/* Stream completed media */}
          {isCompleted && (() => {
            const streamableFile = torrent.files?.find(f => {
              if (f.priority <= 0 || f.progress < 0.999) return false;
              return /\.(mkv|mp4|m4v|webm|mov|avi|mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name);
            });

            return streamableFile ? (
              <button
                onClick={() => onStream(torrent)}
                className="px-2.5 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-400 text-xs font-semibold transition tap-target flex items-center gap-1.5 justify-center"
                title="Stream completed media"
              >
                <Play className="w-4 h-4 fill-current" />
                <span className="hidden sm:inline text-xs font-bold">Stream</span>
              </button>
            ) : null;
          })()}

          {/* Direct Download for completed torrents */}
          {isCompleted && (
            <a
              href={`/api/torrents/download/${torrent.hash}`}
              download={
                activeFiles === 1
                  ? (torrent.files.find(f => f.priority > 0)?.name || torrent.name)
                  : `${torrent.name}.zip`
              }
              className="px-2.5 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-xs font-semibold transition tap-target flex items-center gap-1.5 justify-center"
              title={activeFiles === 1 ? 'Download Completed File' : 'Download All Files (.zip)'}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline text-xs font-bold">
                {activeFiles === 1 ? 'Download' : 'Download ZIP'}
              </span>
            </a>
          )}

          {/* Pause / Resume */}
          {canPause && (
            <button
              onClick={() => void handleTransferAction(() => onPause(torrent.hash))}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition tap-target flex items-center justify-center"
              title="Pause Transfer"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}

          {canResume && (
            <button
              onClick={() => void handleTransferAction(() => onResume(torrent.hash))}
              className="p-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 transition tap-target flex items-center justify-center"
              title="Resume Transfer"
            >
              <Play className="w-4 h-4 fill-current" />
            </button>
          )}

          {/* Delete */}
          <button
            onClick={() => onDelete(torrent.hash)}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition tap-target flex items-center justify-center"
            title="Remove Torrent Task"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div>
        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden flex">
          <div
            className={`h-full transition-all duration-300 ${
              isCompleted
                ? 'bg-emerald-500'
                : isPaused
                ? 'bg-amber-500'
                : isStalled
                ? 'bg-orange-500'
                : 'bg-gradient-to-r from-cyan-500 to-indigo-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Telemetry row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between flex-wrap gap-2 text-xs font-mono text-slate-400">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-slate-200 font-semibold">{progressPercent}%</span>
          <span>
            {formatBytes(downloadTargetSize * torrent.progress)} / {formatBytes(downloadTargetSize)}
            {skippedFiles > 0 && (
              <span className="text-slate-500 text-[11px] ml-1">
                ({formatBytes(torrent.total_size)} total)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2.5 sm:justify-end flex-wrap">
          {isDownloading && (
            <>
              <span className="text-cyan-400 flex items-center gap-1">
                <Download className="w-3.5 h-3.5" />
                {formatSpeed(torrent.dlspeed)}
              </span>
              <span className="text-slate-500 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {formatETA(torrent.eta)}
              </span>
            </>
          )}

          {isStalled && (
            <span className="text-orange-400 flex items-center gap-1 font-sans">
              <Clock className="w-3.5 h-3.5" />
              Waiting for peers
            </span>
          )}

          {isPaused && (
            <span className="text-amber-400 flex items-center gap-1 font-sans">
              <Pause className="w-3.5 h-3.5" />
              Transfer paused
            </span>
          )}

          {isCompleted && (
            <span className="text-emerald-400 flex items-center gap-1 font-sans">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Direct Links Ready
            </span>
          )}

          <span className="flex items-center gap-1 text-slate-500 hidden sm:flex">
            <Users className="w-3.5 h-3.5" />
            {torrent.num_seeds} / {torrent.num_leechs}
          </span>
        </div>
      </div>
    </div>
  );
};
