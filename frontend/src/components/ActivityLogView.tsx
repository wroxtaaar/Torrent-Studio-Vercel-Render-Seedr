import React, { useState } from 'react';
import {
  History,
  Download,
  Play,
  Trash2,
  Sparkles,
  Share2,
  Cpu,
  Search,
  Filter,
  FileDown,
  RefreshCw
} from 'lucide-react';
import { ActivityLog } from '../types/index.ts';
import { formatTimeAgo } from '../utils/formatters.ts';

interface ActivityLogViewProps {
  logs: ActivityLog[];
  onClearLogs: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export const ActivityLogView: React.FC<ActivityLogViewProps> = ({
  logs,
  onClearLogs,
  onRefresh
}) => {
  const [filterType, setFilterType] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefresh();
    setIsRefreshing(false);
  };

  const handleExport = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `SeedFlow_Activity_Logs_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const filteredLogs = logs.filter((log) => {
    if (filterType !== 'all' && log.type !== filterType) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        log.action.toLowerCase().includes(q) ||
        log.details.toLowerCase().includes(q) ||
        log.userName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const getTypeIcon = (type: ActivityLog['type']) => {
    switch (type) {
      case 'download':
      case 'torrent':
        return <Download className="w-4 h-4 text-cyan-400" />;
      case 'stream':
        return <Play className="w-4 h-4 text-emerald-400" />;
      case 'cleanup':
        return <Sparkles className="w-4 h-4 text-purple-400" />;
      case 'share':
        return <Share2 className="w-4 h-4 text-amber-400" />;
      case 'delete':
        return <Trash2 className="w-4 h-4 text-rose-400" />;
      default:
        return <Cpu className="w-4 h-4 text-slate-400" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400" />
            <span>Transfer & System Activity Log</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Audit trail of all magnet downloads, streaming sessions, auto-cleanups, and file operations.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
            title="Refresh Logs"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={handleExport}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <FileDown className="w-4 h-4 text-cyan-400" />
            <span className="hidden sm:inline">Export JSON</span>
          </button>

          <button
            onClick={onClearLogs}
            className="px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-2.5">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search activity events..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Filter Badges */}
        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 text-xs">
          {['all', 'download', 'stream', 'cleanup', 'share', 'delete'].map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-3 py-1.5 rounded-xl capitalize font-medium transition whitespace-nowrap ${
                filterType === t
                  ? 'bg-cyan-500 text-slate-950 font-bold'
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Logs Table / List */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="py-16 text-center text-slate-500 text-xs">
            <History className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No activity records matching your criteria.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {filteredLogs.map((log) => (
              <div
                key={log.id}
                className="p-3.5 sm:p-4 hover:bg-slate-850/50 transition flex items-start justify-between gap-3 text-xs"
              >
                <div className="flex items-start gap-3 overflow-hidden">
                  <div className="p-2 rounded-xl bg-slate-950 border border-slate-800 shrink-0 mt-0.5">
                    {getTypeIcon(log.type)}
                  </div>
                  <div className="overflow-hidden">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-200">{log.action}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                        by {log.userName}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                          log.status === 'success'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : log.status === 'warning'
                            ? 'bg-amber-500/10 text-amber-400'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {log.status}
                      </span>
                    </div>
                    <p className="text-slate-400 mt-1 text-[11px] leading-relaxed break-words">
                      {log.details}
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <span className="text-[11px] text-slate-500 font-mono">
                    {formatTimeAgo(log.timestamp)}
                  </span>
                  <p className="text-[10px] text-slate-600 font-mono mt-0.5">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
