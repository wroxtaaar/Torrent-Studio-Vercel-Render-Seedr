import React, { useState, useEffect } from 'react';
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  Info,
  X,
  Volume2,
  VolumeX,
  Send,
  Sparkles
} from 'lucide-react';
import { AppNotification } from '../types/index.ts';
import { formatTimeAgo } from '../utils/formatters.ts';
import { requestPushPermission, dispatchBrowserNotification, getNotificationPermission } from '../utils/notifications.ts';

interface NotificationCenterProps {
  notifications: AppNotification[];
  isOpen: boolean;
  onClose: () => void;
  onMarkRead: () => Promise<void>;
  onTestPush: () => Promise<void>;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  notifications,
  isOpen,
  onClose,
  onMarkRead,
  onTestPush
}) => {
  const [pushStatus, setPushStatus] = useState<NotificationPermission>(() => {
    return getNotificationPermission();
  });
  const [soundEnabled, setSoundEnabled] = useState(true);

  if (!isOpen) return null;

  const handleEnablePush = async () => {
    const result = await requestPushPermission();
    setPushStatus(result);
    if (result === 'granted') {
      dispatchBrowserNotification(
        'SeedFlow Push Notifications Enabled',
        'You will now receive instant push alerts whenever cloud torrent downloads finish!'
      );
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-md bg-slate-900 border-l border-slate-800 h-full shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 relative">
              <Bell className="w-5 h-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping" />
              )}
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Notifications & Alerts</h3>
              <p className="text-[11px] text-slate-400">
                {unreadCount} unread • Push & Storage Alerts
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button
                onClick={onMarkRead}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 font-medium transition"
              >
                Mark Read
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Push Notification & Audio Status Card */}
        <div className="p-4 bg-slate-950/70 border-b border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-semibold text-slate-200">Browser Push Alerts</span>
            </div>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                pushStatus === 'granted'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`}
            >
              {pushStatus === 'granted' ? 'Active' : 'Not Granted'}
            </span>
          </div>

          <p className="text-[11px] text-slate-400">
            Get instant mobile & desktop alerts when cloud transfers finish, even when your browser is minimized.
          </p>

          <div className="flex items-center gap-2">
            {pushStatus !== 'granted' ? (
              <button
                onClick={handleEnablePush}
                className="flex-1 py-1.5 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition"
              >
                Enable Push Notifications
              </button>
            ) : (
              <button
                onClick={onTestPush}
                className="flex-1 py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 transition"
              >
                <Send className="w-3.5 h-3.5 text-cyan-400" />
                <span>Send Test Alert</span>
              </button>
            )}

            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-2 rounded-lg border text-xs transition ${
                soundEnabled
                  ? 'bg-slate-800 border-slate-700 text-cyan-400'
                  : 'bg-slate-900 border-slate-800 text-slate-500'
              }`}
              title={soundEnabled ? 'Chime Sound Enabled' : 'Chime Sound Muted'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Notification List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {notifications.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">
              <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No notifications yet</p>
            </div>
          ) : (
            notifications.map((n) => {
              const isTransfer = n.type === 'transfer_complete';
              const isWarning = n.type === 'storage_warning';

              return (
                <div
                  key={n.id}
                  className={`p-3.5 rounded-xl border text-xs transition flex gap-3 ${
                    !n.read
                      ? 'bg-slate-850 border-cyan-500/30'
                      : 'bg-slate-950/40 border-slate-800/80 text-slate-400'
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {isTransfer ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : isWarning ? (
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Info className="w-4 h-4 text-cyan-400" />
                    )}
                  </div>

                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center justify-between gap-1">
                      <p className={`font-semibold truncate ${!n.read ? 'text-slate-100' : 'text-slate-300'}`}>
                        {n.title}
                      </p>
                      <span className="text-[10px] text-slate-500 shrink-0">
                        {formatTimeAgo(n.timestamp)}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                      {n.message}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
