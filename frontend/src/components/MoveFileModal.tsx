import React, { useState } from 'react';
import { X, FolderInput, Folder, Check } from 'lucide-react';
import { StorageFile, StorageFolder } from '../types/index.ts';

interface MoveFileModalProps {
  file: StorageFile | null;
  folders: StorageFolder[];
  onClose: () => void;
  onMove: (fileId: string, targetFolder: string) => Promise<void>;
}

export const MoveFileModal: React.FC<MoveFileModalProps> = ({
  file,
  folders,
  onClose,
  onMove
}) => {
  if (!file) return null;

  const [selectedFolder, setSelectedFolder] = useState(file.folder);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      await onMove(file.id, selectedFolder);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400">
              <FolderInput className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Move File</h3>
              <p className="text-xs text-slate-400 truncate max-w-xs">{file.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-xs text-slate-300 font-semibold">Select Destination Directory:</p>

          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            <div
              onClick={() => setSelectedFolder('/')}
              className={`p-2.5 rounded-xl border text-xs cursor-pointer transition flex items-center justify-between ${
                selectedFolder === '/'
                  ? 'bg-cyan-950/40 border-cyan-500/50 text-cyan-300 font-semibold'
                  : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <Folder className="w-4 h-4 text-cyan-400" />
                <span>Root Storage ( / )</span>
              </div>
              {selectedFolder === '/' && <Check className="w-4 h-4 text-cyan-400" />}
            </div>

            {folders.filter(f => f.path !== '/').map((folder) => (
              <div
                key={folder.id}
                onClick={() => setSelectedFolder(folder.path)}
                className={`p-2.5 rounded-xl border text-xs cursor-pointer transition flex items-center justify-between ${
                  selectedFolder === folder.path
                    ? 'bg-cyan-950/40 border-cyan-500/50 text-cyan-300 font-semibold'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Folder className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span className="truncate">{folder.name}</span>
                </div>
                {selectedFolder === folder.path && <Check className="w-4 h-4 text-cyan-400 shrink-0" />}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-medium hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-bold flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Move File</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
