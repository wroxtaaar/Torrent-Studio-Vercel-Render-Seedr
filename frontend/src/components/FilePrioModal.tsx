import React, { useEffect, useState } from 'react';
import {
  X,
  FileCheck,
  CheckSquare,
  Square,
  Download
} from 'lucide-react';
import { TorrentItem } from '../types/index.ts';
import { formatBytes } from '../utils/formatters.ts';

interface FilePrioModalProps {
  torrent: TorrentItem | null;
  onClose: () => void;
  onUpdatePriority: (hash: string, fileId: string, priority: number) => Promise<void>;
}

export const FilePrioModal: React.FC<FilePrioModalProps> = ({
  torrent,
  onClose,
  onUpdatePriority
}) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [localFiles, setLocalFiles] = useState(torrent?.files || []);

  useEffect(() => {
    setLocalFiles(torrent?.files || []);
  }, [torrent]);

  if (!torrent) return null;

  const applyPriority = async (targetIds: number[], priority: number) => {
    if (targetIds.length === 0 || isUpdating) return;

    const previous = localFiles;
    const targetSet = new Set(targetIds);

    // Optimistic UI: checkbox/row status changes immediately.
    setLocalFiles(prev =>
      prev.map(file =>
        targetSet.has(file.index)
          ? { ...file, priority }
          : file
      )
    );

    // Keep the parent torrent in sync immediately too.
    torrent.files.forEach(file => {
      if (targetSet.has(file.index)) {
        file.priority = priority;
      }
    });

    try {
      setIsUpdating(true);
      await onUpdatePriority(torrent.hash, targetIds.join('|'), priority);
    } catch (e) {
      console.error(e);
      setLocalFiles(previous);
      await Promise.all(
        previous
          .filter(file => targetSet.has(file.index))
          .map(file => onUpdatePriority(torrent.hash, String(file.index), file.priority).catch(() => undefined))
      );
    } finally {
      setIsUpdating(false);
    }
  };

  // Clicking the checkbox toggles the actual qBittorrent download priority.
  const toggleDownload = async (index: number) => {
    const file = localFiles.find(f => f.index === index);
    if (!file) return;
    await applyPriority([index], file.priority > 0 ? 0 : 1);
  };

  const selectAll = async (all: boolean) => {
    const ids = localFiles.map(f => f.index);
    await applyPriority(ids, all ? 1 : 0);
  };

  const activeFiles = localFiles.filter(f => f.priority > 0);
  const activeSize = activeFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div
        className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400">
              <FileCheck className="w-5 h-5" />
            </div>
            <div className="truncate">
              <h3 className="text-base font-bold text-slate-100 truncate">Choose files to download</h3>
              <p className="text-xs text-slate-400 truncate">
                {activeFiles.length} of {localFiles.length} selected • {formatBytes(activeSize)} selected
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            aria-label="Close file selection"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-2.5 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500">Checked = download • Unchecked = skip</span>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => void selectAll(true)}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 font-semibold"
            >
              Select all
            </button>
            <button
              onClick={() => void selectAll(false)}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 font-semibold"
            >
              Select none
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {[...localFiles]
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
            .map((file) => {
              const isChecked = file.priority > 0;
              return (
                <div
                  key={file.index}
                  className="p-3 rounded-xl border text-xs transition flex items-center gap-3 bg-slate-850 border-slate-800 hover:border-slate-700"
                >
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void toggleDownload(file.index)}
                    className="shrink-0 p-0.5 rounded focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:opacity-40"
                    aria-label={isChecked ? `Skip ${file.name}` : `Include ${file.name}`}
                  >
                    {isChecked ? (
                      <CheckSquare className="w-5 h-5 text-cyan-400" />
                    ) : (
                      <Square className="w-5 h-5 text-slate-500" />
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void toggleDownload(file.index)}
                    className="min-w-0 flex-1 text-left disabled:opacity-60"
                  >
                    <p className="font-medium font-mono truncate text-slate-200">
                      {file.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span>{formatBytes(file.size)}</span>
                      <span>•</span>
                      <span className={file.progress >= 1 ? 'text-emerald-400 font-semibold' : isChecked ? 'text-cyan-400 font-medium' : 'text-slate-500'}>
                        {file.progress >= 1
                          ? `${(file.progress * 100).toFixed(1)}% downloaded`
                          : isChecked
                          ? 'Ready to download'
                          : 'Will be skipped'}
                      </span>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    {file.progress >= 1 && isChecked ? (
                      <a
                        href={`/api/torrents/download/${torrent.hash}/${file.index}`}
                        download={file.name}
                        className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold flex items-center gap-1 transition"
                        title="Download file to device"
                      >
                        <Download className="w-3 h-3" />
                        <span>Save</span>
                      </a>
                    ) : (
                      <span className={`px-2 py-1 rounded-lg text-[10px] font-bold border ${isChecked ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
                        {isChecked ? 'Selected' : 'Skipped'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 bg-slate-900 flex justify-between items-center">
          <div className="text-xs text-slate-400">
            {activeFiles.length === localFiles.length
              ? 'All files are selected for download.'
              : activeFiles.length === 0
              ? 'No files are selected.'
              : `${activeFiles.length} file${activeFiles.length === 1 ? '' : 's'} selected for download.`}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
