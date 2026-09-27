import React, { useState } from 'react';
import {
  X,
  Cpu,
  CheckCircle2,
  RefreshCw,
  Zap
} from 'lucide-react';
import { QbtSettings } from '../types/index.ts';
import { api } from '../api/client.ts';

interface QbtSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: QbtSettings | null;
  onSave: (settings: Partial<QbtSettings>) => Promise<void>;
}

export const QbtSettingsModal: React.FC<QbtSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [testSuccess, setTestSuccess] = useState(false);

  const handleTestConnection = async () => {
    setIsSaving(true);
    setTestSuccess(false);
    try {
      const current = await api.getQbtSettings();
      setTestSuccess(Boolean(current.connected));
    } catch (e) {
      setTestSuccess(false);
      console.error('qBittorrent connection test failed:', e);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !settings) return null;

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave({ isExternal: false });
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
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-slate-950 font-bold">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">qBittorrent WebAPI Orchestrator</h3>
              <p className="text-xs text-slate-400">
                Core BitTorrent Protocol Engine & API Orchestration
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
        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Engine Status Banner */}
          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <div>
                <p className="text-xs font-bold text-slate-200">
                  Integrated VPS qBittorrent
                </p>
                <p className="text-[11px] text-slate-400 font-mono">
                  {settings.version || 'Unknown version'} • Status: {settings.connected ? 'Connected' : 'Disconnected'}
                </p>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              OPERATIONAL
            </span>
          </div>

          {/* Integrated VPS qBittorrent */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300">
              qBittorrent Engine
            </label>
            <div className="p-3.5 rounded-xl bg-cyan-950/30 border border-cyan-500/40">
              <p className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-cyan-400" />
                <span>Integrated VPS qBittorrent</span>
              </p>
              <p className="text-[10px] text-slate-400 mt-1">
                qBittorrent runs privately on this Oracle VPS and is controlled by SeedFlow through its WebAPI.
              </p>
            </div>
          </div>

          {/* Active WebAPI Endpoints Overview */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Active qBittorrent WebAPI Endpoints
            </h4>
            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-400">
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/info</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/add</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/files</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/filePrio</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/pause</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/sync/maindata</span>
            </div>
          </div>

          {testSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>WebAPI endpoint ping verified successfully!</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 sm:px-5 py-3.5 border-t border-slate-800 bg-slate-900/90 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isSaving}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSaving ? 'animate-spin' : ''}`} />
            <span>Test Connection</span>
          </button>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition shadow-lg shadow-cyan-500/20"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
