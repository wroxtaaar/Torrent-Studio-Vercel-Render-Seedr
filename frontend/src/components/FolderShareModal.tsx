import React, { useState } from 'react';
import {
  X,
  Users,
  Shield,
  Eye,
  Edit3,
  UserCheck,
  Globe,
  Lock,
  Check
} from 'lucide-react';
import { StorageFolder, UserProfile, UserPermission } from '../types/index.ts';

interface FolderShareModalProps {
  folder: StorageFolder | null;
  users: UserProfile[];
  onClose: () => void;
  onSave: (folderId: string, isShared: boolean, permissions: Record<string, UserPermission>) => Promise<void>;
}

export const FolderShareModal: React.FC<FolderShareModalProps> = ({
  folder,
  users,
  onClose,
  onSave
}) => {
  if (!folder) return null;

  const [isShared, setIsShared] = useState(folder.isShared);
  const [permissions, setPermissions] = useState<Record<string, UserPermission>>({
    ...folder.permissions
  });
  const [isSaving, setIsSaving] = useState(false);

  const handlePermissionChange = (userId: string, perm: UserPermission) => {
    setPermissions(prev => ({
      ...prev,
      [userId]: perm
    }));
  };

  const handleToggleUserAccess = (userId: string) => {
    setPermissions(prev => {
      const copy = { ...prev };
      if (copy[userId]) {
        delete copy[userId];
      } else {
        copy[userId] = 'viewer';
      }
      return copy;
    });
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave(folder.id, isShared, permissions);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Folder Access & Sharing</h3>
              <p className="text-xs text-slate-400 truncate max-w-xs">{folder.path}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Share Toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950 border border-slate-800">
            <div className="flex items-center gap-3">
              {isShared ? (
                <Globe className="w-5 h-5 text-cyan-400" />
              ) : (
                <Lock className="w-5 h-5 text-slate-400" />
              )}
              <div>
                <p className="text-xs font-bold text-slate-200">
                  {isShared ? 'Shared Folder (Multi-User Enabled)' : 'Private Folder (Owner Only)'}
                </p>
                <p className="text-[11px] text-slate-400">
                  {isShared
                    ? 'Authorized users can access files based on customized permission roles.'
                    : 'Only folder owner has access to files.'}
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsShared(!isShared)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                isShared
                  ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {isShared ? 'Shared' : 'Enable Share'}
            </button>
          </div>

          {/* User Permissions Table */}
          {isShared && (
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                User Permission Levels
              </h4>

              <div className="space-y-2">
                {users.map((u) => {
                  const isOwner = u.id === folder.ownerId;
                  const hasAccess = isOwner || !!permissions[u.id];
                  const currentRole: UserPermission = isOwner
                    ? 'admin'
                    : permissions[u.id] || 'viewer';

                  return (
                    <div
                      key={u.id}
                      className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <img
                          src={u.avatar}
                          alt={u.name}
                          className="w-8 h-8 rounded-full object-cover border border-slate-700 shrink-0"
                        />
                        <div className="truncate">
                          <p className="text-xs font-semibold text-slate-200 flex items-center gap-1.5 truncate">
                            <span>{u.name}</span>
                            {isOwner && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-normal">
                                Owner
                              </span>
                            )}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">{u.email}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isOwner ? (
                          <span className="text-xs font-semibold text-slate-400 px-2 py-1 bg-slate-800 rounded-lg">
                            Full Control
                          </span>
                        ) : hasAccess ? (
                          <select
                            value={currentRole}
                            onChange={(e) =>
                              handlePermissionChange(u.id, e.target.value as UserPermission)
                            }
                            className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                          >
                            <option value="viewer">Viewer (Stream / Read)</option>
                            <option value="editor">Editor (Upload / Rename)</option>
                            <option value="admin">Admin (Full Control)</option>
                          </select>
                        ) : (
                          <button
                            onClick={() => handleToggleUserAccess(u.id)}
                            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs font-medium transition"
                          >
                            Grant Access
                          </button>
                        )}

                        {!isOwner && hasAccess && (
                          <button
                            onClick={() => handleToggleUserAccess(u.id)}
                            className="p-1 rounded text-slate-500 hover:text-rose-400"
                            title="Revoke Access"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Role explanations */}
          <div className="p-3 rounded-xl bg-slate-950/40 border border-slate-800/60 text-[11px] text-slate-400 space-y-1">
            <p><span className="font-semibold text-slate-300">Viewer:</span> Can play/stream media and download direct links.</p>
            <p><span className="font-semibold text-slate-300">Editor:</span> Can also move files, upload magnets, and rename items.</p>
            <p><span className="font-semibold text-slate-300">Admin:</span> Full folder management including deletion and member permissions.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-cyan-500/20"
          >
            <Check className="w-4 h-4" />
            <span>{isSaving ? 'Saving...' : 'Save Permissions'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
