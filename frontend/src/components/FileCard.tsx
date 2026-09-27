import React, { useState } from 'react';
import {
  Film,
  Music,
  FileText,
  FileArchive,
  Image as ImageIcon,
  File,
  Play,
  Download,
  Copy,
  Check,
  MoreVertical,
  Trash2,
  Edit2,
  FolderInput,
  Share2
} from 'lucide-react';
import { StorageFile } from '../types/index.ts';
import { formatBytes, formatTimeAgo } from '../utils/formatters.ts';

interface FileCardProps {
  file: StorageFile;
  onPlay: (file: StorageFile) => void;
  onDelete: (id: string) => void;
  onRename: (file: StorageFile) => void;
  onMove: (file: StorageFile) => void;
  canEdit?: boolean;
  canDelete?: boolean;
}

export const FileCard: React.FC<FileCardProps> = ({
  file,
  onPlay,
  onDelete,
  onRename,
  onMove,
  canEdit = true,
  canDelete = true
}) => {
  const [copied, setCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const copyLink = () => {
    const directUrl = window.location.origin + file.downloadUrl;
    navigator.clipboard.writeText(directUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getIcon = () => {
    switch (file.type) {
      case 'video':
        return <Film className="w-5 h-5 text-indigo-400" />;
      case 'audio':
        return <Music className="w-5 h-5 text-cyan-400" />;
      case 'image':
        return <ImageIcon className="w-5 h-5 text-pink-400" />;
      case 'archive':
        return <FileArchive className="w-5 h-5 text-amber-400" />;
      case 'document':
        return <FileText className="w-5 h-5 text-emerald-400" />;
      default:
        return <File className="w-5 h-5 text-slate-400" />;
    }
  };

  return (
    <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700/80 transition shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 group relative">
      {/* File Info */}
      <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0 w-full">
        <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 shrink-0">
          {getIcon()}
        </div>

        <div className="truncate flex-1">
          <div className="flex items-center gap-2">
            <h4
              onClick={() => file.isStreamable && onPlay(file)}
              className={`text-xs sm:text-sm font-semibold truncate ${
                file.isStreamable
                  ? 'cursor-pointer text-slate-200 hover:text-cyan-400 transition'
                  : 'text-slate-200'
              }`}
              title={file.name}
            >
              {file.name}
            </h4>
          </div>

          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
            <span className="font-mono text-slate-300">{formatBytes(file.size)}</span>
            <span>•</span>
            <span>{formatTimeAgo(file.createdAt)}</span>
            <span className="hidden sm:inline">•</span>
            <span className="text-slate-500 hidden sm:inline">Owner: {file.ownerName}</span>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-1.5 shrink-0 w-full sm:w-auto">
        {/* Stream button for playable media */}
        {file.isStreamable && (
          <button
            onClick={() => onPlay(file)}
            className="px-2.5 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 transition tap-target"
            title="Stream in Browser"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span className="hidden sm:inline">Stream</span>
          </button>
        )}

        {/* Direct Download Link */}
        <a
          href={file.downloadUrl}
          download={file.name}
          className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition tap-target flex items-center justify-center"
          title="Direct Download Link"
        >
          <Download className="w-4 h-4" />
        </a>

        {/* Copy Direct Link */}
        <button
          onClick={copyLink}
          className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 transition tap-target flex items-center justify-center"
          title="Copy Direct Download Link"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
        </button>

        {/* Quick Delete File */}
        {canDelete && (
          <button
            onClick={() => onDelete(file.id)}
            className="p-2 rounded-xl bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition tap-target flex items-center justify-center"
            title="Delete File"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}

        {/* More Menu Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition tap-target flex items-center justify-center"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {showMenu && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setShowMenu(false)}
              />
              <div className="absolute right-0 top-full mt-1.5 z-30 w-44 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-1 text-xs">
                {canEdit && (
                  <>
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        onMove(file);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-slate-800 text-slate-300 flex items-center gap-2"
                    >
                      <FolderInput className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Move File</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        onRename(file);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-slate-800 text-slate-300 flex items-center gap-2"
                    >
                      <Edit2 className="w-3.5 h-3.5 text-amber-400" />
                      <span>Rename</span>
                    </button>
                  </>
                )}

                {canDelete && (
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      onDelete(file.id);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-rose-500/10 text-rose-400 flex items-center gap-2 border-t border-slate-800"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete File</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
