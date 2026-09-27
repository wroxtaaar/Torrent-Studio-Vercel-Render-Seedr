import React, { useState } from 'react';
import {
  X,
  HardDrive,
  Trash2,
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  Clock,
  RotateCcw,
  CheckCircle2,
  Database
} from 'lucide-react';
import { StorageStats, CleanupSettings } from '../types/index.ts';
import { formatBytes } from '../utils/formatters.ts';

interface StorageCleanupModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: StorageStats | null;
  settings: CleanupSettings | null;
  onUpdateSettings: (settings: Partial<CleanupSettings>) => Promise<void>;
  onRunCleanup: () => Promise<{ bytesFreed: number; filesRemoved: number; tempRemoved: number }>;
}

export const StorageCleanupModal: React.FC<StorageCleanupModalProps> = ({
  isOpen,
  onClose,
  stats,
  settings,
  onUpdateSettings,
  onRunCleanup
}) => {
  const [isRunningCleanup, setIsRunningCleanup] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{
    bytesFreed: number;
    filesRemoved: number;
    tempRemoved: number;
  } | null>(null);

  if (!isOpen || !stats || !settings) return null;

  const handleRunCleanup = async () => {
    try {
      setIsRunningCleanup(true);
      setCleanupResult(null);
      const res = await onRunCleanup();
      setCleanupResult(res);
    } catch (e) {
      console.error(e);
    } finally {
      setIsRunningCleanup(false);
    }
  };

  const getAlertBanner = () => {
    if (stats.alertLevel === 'critical') {
      return (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
          <div>
            <p className="font-bold">Critical Storage Alert (&gt;90% Capacity)</p>
            <p className="text-[11px] text-rose-400/90 mt-0.5">
              Server storage is almost exhausted. Automatic pruning is active, or run cleanup below.
            </p>
          </div>
        </div>
      );
    }
    if (stats.alertLevel === 'warning') {
      return (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <div>
            <p className="font-bold">Storage Advisory (&gt;80% Capacity)</p>
            <p className="text-[11px] text-amber-400/90 mt-0.5">
              Server storage is reaching high utilization.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
        <div>
          <p className="font-bold">Server Storage Status Healthy</p>
          <p className="text-[11px] text-emerald-400/90 mt-0.5">
            Full disk space unlocked. No 5GB artificial limits enforced.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500 to-indigo-600 text-slate-950 font-bold">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Server Storage & Auto-Cleanup</h3>
              <p className="text-xs text-slate-400">
                Uncapped Disk Allocation • Automatic Orphan & Fragment Garbage Collection
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Alert Status Banner */}
          {getAlertBanner()}

          {/* Storage Gauge */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Total Server Disk Capacity
                </span>
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                Uncapped Storage Tier
              </span>
            </div>

            {/* Progress bar */}
            <div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden flex">
                <div
                  className={`h-full transition-all duration-500 ${
                    stats.alertLevel === 'critical'
                      ? 'bg-rose-500'
                      : stats.alertLevel === 'warning'
                      ? 'bg-amber-500'
                      : 'bg-gradient-to-r from-cyan-500 to-indigo-500'
                  }`}
                  style={{ width: `${Math.max(1, stats.usedPercentage)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400 mt-2 font-mono">
                <span>Used: {formatBytes(stats.usedBytes)} ({stats.usedPercentage}%)</span>
                <span>Free: {formatBytes(stats.freeBytes)}</span>
                <span>Total: {formatBytes(stats.totalBytes)}</span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 italic">
              Unlike Seedr's 5GB free limit, SeedFlow utilizes the full physical capacity of your host server storage.
            </p>
          </div>

          {/* Automatic Cleanup Rules */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                Automatic Cleanup Engine
              </h4>
              <span className="text-[11px] text-emerald-400 font-medium">Always Active</span>
            </div>

            <div className="space-y-2">
              <label className="flex items-center justify-between p-3 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Purge Orphan Records on File Delete / Move
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Automatically cleans orphaned torrent task references and broken links after files are moved or deleted.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoPurgeOrphans}
                  onChange={(e) => onUpdateSettings({ autoPurgeOrphans: e.target.checked })}
                  className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 bg-slate-800 border-slate-700"
                />
              </label>

              <label className="flex items-center justify-between p-3 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Clean Temporary Download Cache Chunks
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Clears leftover temporary chunk fragments from interrupted or canceled downloads.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoCleanTempFiles}
                  onChange={(e) => onUpdateSettings({ autoCleanTempFiles: e.target.checked })}
                  className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 bg-slate-800 border-slate-700"
                />
              </label>

              <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Auto-Clean Completed Tasks Older Than
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Automatically remove completed torrent transfers after designated days.
                  </p>
                </div>
                <select
                  value={settings.autoCleanCompletedDays}
                  onChange={(e) => onUpdateSettings({ autoCleanCompletedDays: parseInt(e.target.value, 10) })}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value={0}>Never (Keep indefinitely)</option>
                  <option value={3}>3 Days</option>
                  <option value={7}>7 Days</option>
                  <option value={14}>14 Days</option>
                  <option value={30}>30 Days</option>
                </select>
              </div>
            </div>
          </div>

          {/* Cleanup Results Toast if just run */}
          {cleanupResult && (
            <div className="p-3.5 rounded-xl bg-cyan-950/40 border border-cyan-500/40 text-cyan-300 text-xs flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-cyan-400 shrink-0" />
              <div>
                <p className="font-bold">Cleanup Complete!</p>
                <p className="text-[11px] text-cyan-300/80 mt-0.5">
                  Recovered {formatBytes(cleanupResult.bytesFreed)} of server storage. Purged {cleanupResult.tempRemoved} temp blocks and {cleanupResult.filesRemoved} items.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <p className="text-[11px] text-slate-500 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            <span>Last cleaned: {settings.lastCleanedAt ? new Date(settings.lastCleanedAt).toLocaleTimeString() : 'Never'}</span>
          </p>

          <button
            onClick={handleRunCleanup}
            disabled={isRunningCleanup}
            className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-cyan-500/20"
          >
            {isRunningCleanup ? (
              <RotateCcw className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            <span>{isRunningCleanup ? 'Cleaning Disk...' : 'Run Storage Cleanup Now'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
