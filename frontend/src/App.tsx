/**
 * SeedFlow - Cloud Torrent & Media Streaming Application
 * Seedr-style webapp with qBittorrent WebAPI v2 orchestration,
 * unlimited server storage, HTTP range streaming, and selective downloads.
 */

// Deployment marker: frontend is deployed from main via Vercel.
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Cloud,
  Download,
  Copy,
  Upload,
  HardDrive,
  Folder,
  File,
  FolderPlus,
  Play,
  Share2,
  History,
  Settings,
  Bell,
  Plus,
  Search,
  Filter,
  Moon,
  Sun,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Users,
  ChevronRight,
  Sparkles,
  Layers,
  ArrowUpDown,
  ExternalLink,
  Film,
  Music,
  CheckCircle2,
  Loader2
} from 'lucide-react';

import {
  TorrentItem,
  StorageFile,
  StorageFolder,
  UserProfile,
  StorageStats,
  ActivityLog,
  AppNotification,
  CleanupSettings,
  UserPermission
} from './types/index.ts';

import { api } from './api/client.ts';
import { formatBytes, formatQuotaBytes, formatSpeed } from './utils/formatters.ts';
import { dispatchBrowserNotification, playNotificationSound } from './utils/notifications.ts';

import { TorrentCard } from './components/TorrentCard.tsx';
import { FileCard } from './components/FileCard.tsx';
import { MediaPlayerModal } from './components/MediaPlayerModal.tsx';
import { AddMagnetModal } from './components/AddMagnetModal.tsx';
import { FilePrioModal } from './components/FilePrioModal.tsx';
import { StorageCleanupModal } from './components/StorageCleanupModal.tsx';
import { FolderShareModal } from './components/FolderShareModal.tsx';
import { NotificationCenter } from './components/NotificationCenter.tsx';
import { ActivityLogView } from './components/ActivityLogView.tsx';
import { CreateFolderModal } from './components/CreateFolderModal.tsx';
import { MoveFileModal } from './components/MoveFileModal.tsx';
import { RenameModal } from './components/RenameModal.tsx';
import { ConfirmDeleteModal } from './components/ConfirmDeleteModal.tsx';
import { TorrentSearchPanel } from './components/TorrentSearchPanel.tsx';

export default function App() {
  // Navigation & Theme
  const [activeTab, setActiveTab] = useState<'search' | 'files' | 'shared' | 'activity' | 'storage'>(() => {
    try {
      const saved = window.localStorage.getItem('seedflow_active_tab');
      return saved === 'search' || saved === 'files' || saved === 'shared' || saved === 'activity' || saved === 'storage'
        ? saved
        : 'search';
    } catch {
      return 'search';
    }
  });
  type BackgroundMetadataJobRecord = {
    jobId: string;
    hash: string;
    name: string;
    status: string;
    rounds: number;
    startedAt: number;
    updatedAt: number;
    deadlineAt: number;
    elapsedSeconds: number;
    remainingSeconds: number;
    fileCount: number;
    totalSize: number;
    source: string;
    error?: string | null;
  };

  const [backgroundMetadataJob, setBackgroundMetadataJob] = useState<{
    active: boolean;
    title: string;
    message: string;
    ready?: boolean;
    error?: string;
    jobId?: string;
  } | null>(null);
  const [backgroundMetadataJobs, setBackgroundMetadataJobs] = useState<BackgroundMetadataJobRecord[]>([]);
  const [backgroundMetadataLoading, setBackgroundMetadataLoading] = useState(false);

  // Keep background metadata jobs connected to the UI after the selector closes.
  // Once a resolver finishes, the cached metadata is immediately available when
  // the user opens the selector again.
  useEffect(() => {
    const jobId = backgroundMetadataJob?.jobId;
    if (!backgroundMetadataJob?.active || !jobId) return;

    let stopped = false;
    const poll = async () => {
      try {
        const data = await api.getTorrentMetadataStatus(jobId);
        if (stopped) return;

        if (Array.isArray(data?.files) && data.files.length > 0) {
          setBackgroundMetadataJob({
            active: false,
            ready: true,
            title: 'Torrent metadata ready',
            message: `${data.files.length} file${data.files.length === 1 ? '' : 's'} found. Open the selector to choose files.`,
            jobId
          });
          return;
        }

        if (data?.status === 'error') {
          setBackgroundMetadataJob({
            active: false,
            error: String(data?.message || 'Torrent metadata could not be resolved.'),
            title: 'Torrent metadata failed',
            message: String(data?.message || 'Torrent metadata could not be resolved.'),
            jobId
          });
        }
      } catch {
        // The job may still be running or the Render instance may be waking.
        // Keep polling rather than turning a transient status request into a
        // false failure.
      }
    };

    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [backgroundMetadataJob?.active, backgroundMetadataJob?.jobId]);
  const refreshBackgroundMetadataJobs = useCallback(async () => {
    try {
      setBackgroundMetadataLoading(true);
      const data = await api.getTorrentMetadataJobs();
      setBackgroundMetadataJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch {
      // Metadata jobs are best-effort UI state. A transient API/Render wake-up
      // failure must not affect the rest of the Files screen.
    } finally {
      setBackgroundMetadataLoading(false);
    }
  }, []);

  // Restore the server-side metadata queue when the page loads. Keep polling
  // while at least one job is still resolving, then slow down once everything
  // is terminal so the list remains useful without unnecessary requests.
  const hasActiveBackgroundMetadataJobs = backgroundMetadataJobs.some(
    job => job.status === 'queued' || job.status === 'resolving'
  );

  useEffect(() => {
    void refreshBackgroundMetadataJobs();
    if (!hasActiveBackgroundMetadataJobs) return;
    const timer = window.setInterval(
      () => { void refreshBackgroundMetadataJobs(); },
      5000
    );
    return () => window.clearInterval(timer);
  }, [refreshBackgroundMetadataJobs, hasActiveBackgroundMetadataJobs]);

  const [initialSourceUrl, setInitialSourceUrl] = useState('');
  const [initialDescriptorUrl, setInitialDescriptorUrl] = useState('');

  const [theme, setTheme] = useState<'dark' | 'dim' | 'light'>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
  return (localStorage.getItem('seedflow_theme') as any) || 'dark';
      }
    } catch {
      // Sandboxed or iframe storage restricted
    }
    return 'dark';
  });

  // Core Data
  const [torrents, setTorrents] = useState<TorrentItem[]>([]);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [folders, setFolders] = useState<StorageFolder[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [activeUser, setActiveUser] = useState<UserProfile | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const activityStorageKey = 'seedflow_activity_logs';
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>(() => {
    try {
      const raw = window.localStorage.getItem(activityStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [cleanupSettings, setCleanupSettings] = useState<CleanupSettings | null>(null);
  type SeedrNotice = {
    taskId: number | string | null;
    name: string;
    folderName: string;
    folderId: string;
    status: 'waiting' | 'downloading' | 'completed' | 'not_found';
    progress: number;
    downloadUrl: string | null;
    files: Array<{
      id: string;
      name: string;
      size: number;
      folderId: string;
      folderPath: string;
      url: string | null;
      available?: boolean;
    }>;
    seedrReply: string;
  };

  const seedrNoticeStorageKey = 'seedflow_seedr_notice';
  const [seedrNotice, setSeedrNotice] = useState<SeedrNotice | null>(() => {
    try {
      const raw = window.localStorage.getItem(seedrNoticeStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.taskId == null) return null;      return {        taskId: parsed.taskId,
        name: String(parsed.name || 'Seedr download'),
        folderName: String(parsed.folderName || ''),
        folderId: String(parsed.folderId || ''),
        status: parsed.status === 'completed' ? 'completed' : parsed.status === 'downloading' ? 'downloading' : 'waiting',
        progress: Math.max(0, Math.min(100, Number(parsed.progress) || 0)),
        downloadUrl: typeof parsed.downloadUrl === 'string' ? parsed.downloadUrl : null,
        files: Array.isArray(parsed.files) ? parsed.files : [],
        seedrReply: String(parsed.seedrReply || ''),
      };
    } catch {
      return null;
    }
  });
  const [seedrFiles, setSeedrFiles] = useState<Array<{ id: string; streamId?: string; name: string; size: number; folderId: string; folderPath: string }>>([]);
  const [seedrLibraryRoot, setSeedrLibraryRoot] = useState<{
    id: string;
    folderId: string;
    name: string;
    path: string;
    filesCount: number;
    totalSize: number;
    folderCount: number;
  } | null>(null);
  const [seedrLibraryFolders, setSeedrLibraryFolders] = useState<Array<{
    id: string;
    folderId: string;
    name: string;
    path: string;
    filesCount: number;
    totalSize: number;
    folderCount: number;
    active?: boolean;
    progress?: number;
  }>>([]);
  const [seedrFolderContentsLoading, setSeedrFolderContentsLoading] = useState(false);
  const [seedrPrefetchLoading, setSeedrPrefetchLoading] = useState(false);
  const [seedrFolderContentsCache, setSeedrFolderContentsCache] = useState<Record<string, Array<{
    id: string;
    streamId?: string;
    name: string;
    size: number;
    folderId: string;
    folderPath: string;
  }>>>({});
  // Track background folder-content requests so clicking a folder while its
  // automatic prefetch is still running reuses the same promise instead of
  // issuing a duplicate API request.
  const seedrFolderContentsRequests = useRef<Record<string, Promise<Array<{
    id: string;
    streamId?: string;
    name: string;
    size: number;
    folderId: string;
    folderPath: string;
  }>>>>({});
  const [seedrConfigured, setSeedrConfigured] = useState(false);
  const [seedrQuota, setSeedrQuota] = useState<{ maxSpace: number; usedSpace: number; remainingSpace: number } | null>(null);
  const [seedrQuotaError, setSeedrQuotaError] = useState<string | null>(null);
  const [seedrLoading, setSeedrLoading] = useState(false);
  const [seedrError, setSeedrError] = useState<string | null>(null);
  const [seedrDeleteNotice, setSeedrDeleteNotice] = useState<string | null>(null);
  const [copiedSeedrFileId, setCopiedSeedrFileId] = useState<string | null>(null);
  const [seedrAddBlockedNotice, setSeedrAddBlockedNotice] = useState<string | null>(null);
  const [seedrInsufficientSpacePrompt, setSeedrInsufficientSpacePrompt] = useState<{
    requiredBytes: number;
    remainingBytes: number;
    magnet: string;
    category: string;
    selectedFiles?: number[];
    manifest?: { index?: number; name: string; size: number; priority: number }[];
    existingHash?: string;
  } | null>(null);
  // Two-stage Seedr playback UX: first show progress while resolving the
  // stream URL, then the player shows its own browser-loading state.
  const [seedrStreamLoadingId, setSeedrStreamLoadingId] = useState<string | null>(null);
  const [isCancellingSeedr, setIsCancellingSeedr] = useState(false);
  const [activeSeedrFolderOpen, setActiveSeedrFolderOpen] = useState(false);
  const [selectedSeedrFolderId, setSelectedSeedrFolderId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('seedflow_seedr_folder') || null;
    } catch {
      return null;
    }
  });
  const seedrTorrentNamesKey = 'seedflow_seedr_torrent_names';
  const [seedrTorrentNames, setSeedrTorrentNames] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem(seedrTorrentNamesKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });

  const rememberSeedrTorrentName = useCallback((folderId: string, torrentName: string) => {
    const id = String(folderId || '').trim();
    const name = String(torrentName || '').trim();
    if (!id || !name || name === 'Waiting for Seedr metadata…') return;

    setSeedrTorrentNames(prev => {
      const next = { ...prev, [id]: name };
      try {
        window.localStorage.setItem(seedrTorrentNamesKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const toSeedrStorageFile = useCallback((file: {
    id: string;
    streamId?: string;
    name: string;
    size: number;
    folderId: string;
    folderPath: string;
  }): StorageFile => {
    const lower = file.name.toLowerCase();
    const type: StorageFile['type'] =
      /\.(mkv|mp4|m4v|webm|mov|avi|m3u8|ts)$/i.test(lower) ? 'video' :
      /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(lower) ? 'audio' :
      /\.(zip|rar|7z|tar|gz|bz2)$/i.test(lower) ? 'archive' :
      /\.(pdf|txt|doc|docx|xls|xlsx|ppt|pptx|csv)$/i.test(lower) ? 'document' :
      'other';

    return {
      id: file.id,
      name: file.name,
      streamId: file.streamId || file.id,
      path: (file.folderPath || '/Torrent Studio').replace(/\/$/, '') + '/' + file.name,
      folder: file.folderPath || '/Torrent Studio',
      size: Number(file.size) || 0,
      type,
      mimeType: type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/mpeg' : 'application/octet-stream',
      createdAt: Date.now(),
      ownerId: 'seedr',
      ownerName: 'Seedr',
      isStreamable: type === 'video' || type === 'audio',
      downloadUrl: '/api/seedr/files/' + encodeURIComponent(file.id) + '/download',
      streamUrl: type === 'video' || type === 'audio'
        ? '/api/seedr/files/stream?file_id=' + encodeURIComponent(file.streamId || file.id) + '&name=' + encodeURIComponent(file.name) + '&type=' + encodeURIComponent(type)
        : '',
    };
  }, []);

  const seedrAllPrefetchedFiles = useMemo(
    () => Object.values(seedrFolderContentsCache).flat(),
    [seedrFolderContentsCache]
  );

  // Active Seedr transfers are shown only in the transfer card above.
  // The initial response contains folder metadata only; file rows are loaded
  // lazily after a folder is opened.
  const seedrFolderGroups = useMemo(() => {
    type SeedrFolderGroup = {
      folderId: string;
      name: string;
      path: string;
      files: Array<{ id: string; name: string; size: number; folderId: string; folderPath: string }>;
      totalSize: number;
      filesCount: number;
      active?: boolean;
      progress?: number;
    };

    const groups: SeedrFolderGroup[] = seedrLibraryFolders.map(folder => {
      const folderId = folder.folderId || folder.id;
      const savedTorrentName = seedrTorrentNames[folderId];
      const torrentName = String(folder.torrentName || savedTorrentName || '').trim();
      return {
      folderId,
      name: torrentName || folder.name,
      path: folder.path,
      files: [],
      totalSize: Number(folder.totalSize) || 0,
      filesCount: Number(folder.filesCount) || 0,
      active: false,
      progress: undefined,
      };
    });

    if (seedrNotice?.taskId != null && seedrNotice.status !== 'completed') {
      const normalizeSeedrText = (value: string) =>
        value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      const actualFolderId =
        seedrNotice.folderId?.trim() ||
        seedrNotice.files.find(file => file.folderId && !file.folderId.startsWith('__'))?.folderId ||
        '';

      const activeName =
        seedrNotice.name?.trim() ||
        'Seedr download';

      const activeNameKey = normalizeSeedrText(activeName);
      let matchingEntry = actualFolderId
        ? groups.find(group => group.folderId === actualFolderId)
        : undefined;

      if (!matchingEntry) {
        matchingEntry = groups.find(group =>
          normalizeSeedrText(group.name) === activeNameKey ||
          normalizeSeedrText(group.path.split('/').filter(Boolean).pop() || '') === activeNameKey
        );
      }

      const activeFileSize = (seedrNotice.files || []).reduce((sum, file) => sum + Number(file.size || 0), 0);
      const activeFileCount = seedrNotice.files?.length || 0;

      if (matchingEntry) {
        matchingEntry.active = true;
        matchingEntry.progress = Math.max(0, Math.min(100, Number(seedrNotice.progress) || 0));
        matchingEntry.name = activeName || matchingEntry.name;
        if (actualFolderId) matchingEntry.folderId = actualFolderId;
        if (activeFileCount > 0 && matchingEntry.filesCount === 0) matchingEntry.filesCount = activeFileCount;
        if (activeFileSize > 0 && matchingEntry.totalSize === 0) matchingEntry.totalSize = activeFileSize;
      } else {
        groups.unshift({
          folderId: actualFolderId || '__active_seedr__',
          name: activeName,
          path: '/Torrent Studio/' + activeName,
          files: [],
          totalSize: activeFileSize,
          filesCount: activeFileCount,
          active: true,
          progress: Math.max(0, Math.min(100, Number(seedrNotice.progress) || 0)),
        });
      }
    }

    return groups.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [seedrLibraryFolders, seedrNotice, seedrTorrentNames]);

  useEffect(() => {
    if (
      selectedSeedrFolderId !== null &&
      seedrLibraryFolders.length > 0 &&
      !seedrFolderGroups.some(folder => folder.folderId === selectedSeedrFolderId)
    ) {
      setSelectedSeedrFolderId(null);
      setSeedrFiles([]);
    }
  }, [selectedSeedrFolderId, seedrLibraryFolders.length, seedrFolderGroups]);
  // File Explorer State
  const [currentFolder, setCurrentFolder] = useState<string>('/');  const [fileSearch, setFileSearch] = useState<string>('');
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

  // The Files tab is reserved for completed/stored files and folders.
  // Active qBittorrent downloads belong only in the Transfers tab.
  const visibleFiles = useMemo(() => {
    const source = currentFolder === '/' && seedrAllPrefetchedFiles.length > 0
      ? seedrAllPrefetchedFiles.map(toSeedrStorageFile)
      : files;

    const search = fileSearch.trim().toLowerCase();
    const filtered = source.filter(file => {
      const matchesType = fileTypeFilter === 'all' || file.type === fileTypeFilter;
      const matchesSearch = !search || file.name.toLowerCase().includes(search);
      return matchesType && matchesSearch;
    });

    // Keep root/"outside folder" files deterministic and easy to scan.
    if (currentFolder !== '/' || seedrAllPrefetchedFiles.length === 0) return filtered;

    return [...filtered].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
  }, [currentFolder, seedrAllPrefetchedFiles, files, toSeedrStorageFile, fileTypeFilter, fileSearch]);
  // Modals & Drawers
  const [isAddMagnetOpen, setIsAddMagnetOpen] = useState(false);
  const [initialMagnet, setInitialMagnet] = useState('');
  const [prioTorrent, setPrioTorrent] = useState<TorrentItem | null>(null);
  const [isCleanupOpen, setIsCleanupOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isMobileMoreOpen, setIsMobileMoreOpen] = useState(false);
  const [shareFolder, setShareFolder] = useState<StorageFolder | null>(null);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [moveFile, setMoveFile] = useState<StorageFile | null>(null);
  const [renameItem, setRenameItem] = useState<{ id: string; name: string; isFolder: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'file' | 'torrent';
    id: string;
    name: string;
    details?: string;
  } | null>(null);

  // Media Player State
  const [activeMediaFile, setActiveMediaFile] = useState<StorageFile | null>(null);
  const [isPlayerMinimized, setIsPlayerMinimized] = useState(false);

  // Previous torrent hashes for completion tracking
  const prevTorrentStates = useRef<Record<string, string>>({});

  // qBittorrent applies stop/start asynchronously. Keep an optimistic transfer
  // state visible for a short reconciliation window so the 1.8s polling loop
  // cannot immediately overwrite a user's pause/resume click with stale state.
  const pendingTransferStates = useRef<Record<string, { state: 'pausedDL' | 'downloading'; expiresAt: number }>>({});

  // Persist navigation so a browser refresh returns to the same page.
  useEffect(() => {
    try {
      window.localStorage.setItem('seedflow_active_tab', activeTab);
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [activeTab]);

  useEffect(() => {
    try {
      if (selectedSeedrFolderId) {
        window.localStorage.setItem('seedflow_seedr_folder', selectedSeedrFolderId);
      } else {
        window.localStorage.removeItem('seedflow_seedr_folder');
      }
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [selectedSeedrFolderId]);

  // Theme synchronization
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('seedflow_theme', theme);
      }
    } catch {}
    try {
      const root = document.documentElement;
      root.classList.remove('dark', 'dim', 'light');
      if (theme === 'dark') {
        root.classList.add('dark');
        root.style.backgroundColor = '#020617';
      } else if (theme === 'dim') {
        root.classList.add('dark');
        root.style.backgroundColor = '#0f172a';
      } else {
        root.classList.add('light');
        root.style.backgroundColor = '#f8fafc';
      }
    } catch {}
  }, [theme]);

  const seedrDownloadActive = Boolean(
    seedrNotice?.taskId != null && seedrNotice.status !== 'completed'
  );

  const openMetadataSelector = useCallback((source: string) => {
    const value = String(source || '').trim();
    if (!value) return;
    setInitialMagnet(value);
    setInitialSourceUrl('');
    setInitialDescriptorUrl('');
    setBackgroundMetadataJob(null);
    setIsAddMagnetOpen(true);
  }, []);

  const openAddMagnet = useCallback((source = '', sourceUrl = '', descriptorUrl = '') => {
    if (seedrDownloadActive) {
      setSeedrAddBlockedNotice(
        'A Seedr download is already in progress. Free Seedr accounts allow one parallel download. Wait for it to finish before adding another magnet link.'
      );
      setActiveTab('files');
      window.setTimeout(() => setSeedrAddBlockedNotice(null), 5000);
      return;
    }

    setInitialMagnet(source);
    setInitialSourceUrl(sourceUrl);
    setInitialDescriptorUrl(descriptorUrl);
    setIsAddMagnetOpen(true);
  }, [seedrDownloadActive]);

  // Load lightweight application metadata first. The actual files for the
  // currently open folder are fetched separately, after folder metadata exists.
  const loadInitialData = useCallback(async () => {
    try {
      const [uData, sStats, foldData, logs, notifs, cleanup] = await Promise.all([
        api.getUsers(),
        api.getStorageStats(),
        api.getFolders(),
        api.getLogs(),
        api.getNotifications(),
        api.getCleanupSettings()
      ]);

      setUsers(uData.users);
      setActiveUser(uData.activeUser);
      setStorageStats(sStats);
      setFolders(foldData);
      try {
        const rawLocalLogs = window.localStorage.getItem(activityStorageKey);
        const localLogs = rawLocalLogs ? JSON.parse(rawLocalLogs) : [];
        setActivityLogs(Array.isArray(localLogs) && localLogs.length ? localLogs : logs);
      } catch {
        setActivityLogs(logs);
      }
      setNotifications(notifs);
      setCleanupSettings(cleanup);
    } catch (e) {
      console.error('Failed to load initial seedflow metadata:', e);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  const loadCurrentFiles = useCallback(async () => {
    try {
      const folderId = currentFolder === '/'
        ? ''
        : String(folders.find(folder => folder.path === currentFolder)?.id || '');
      const fData = await api.getFiles(currentFolder, fileSearch, fileTypeFilter, folderId);
      setFiles(fData);
    } catch (e) {
      console.error('Failed to load current folder files:', e);
      setFiles([]);
    }
  }, [currentFolder, fileSearch, fileTypeFilter, folders]);

  useEffect(() => {
    if (activeTab === 'files') {
      loadCurrentFiles();
    }
  }, [activeTab, loadCurrentFiles]);

  const loadSeedrLibrary = useCallback(async (forceRefresh = false) => {
    setSeedrLoading(true);
    setSeedrError(null);

    try {
      // Check authentication explicitly so the Library panel reports the
      // actual Seedr state instead of turning every failure into a generic
      // library error.
      try {
        const auth = await api.getSeedrAuthStatus();
        if (!auth.configured) {
          setSeedrError('SEEDR_TOKEN_MISSING: Seedr API token is not configured in Render.');
          setSeedrConfigured(false);
          setSeedrLoading(false);
          return null;
        }
        if (!auth.authenticated) {
          try {
            const diagnostic = await api.getSeedrTokenDiagnostic();
            const checks = diagnostic?.checks || {};
            const userCheck = checks.user || {};
            const tokenLabel = userCheck.ok
              ? 'TOKEN_PRESENT_AND_ACCEPTED_BY_SEEDR'
              : 'TOKEN_REJECTED_BY_SEEDR';
            const detail = userCheck.ok
              ? 'Seedr accepted the token through the account endpoint.'
              : 'Seedr rejected the token on the account endpoint.';
            setSeedrError(
              `${tokenLabel}: ${detail} [user=${userCheck.status ?? '?'}]`
            );
          } catch {
            setSeedrError(
              auth.code === 'SEEDR_TOKEN_REJECTED'
                ? 'SEEDR_TOKEN_REJECTED: Seedr rejected the configured API token.'
                : auth.code === 'SEEDR_LIBRARY_ACCESS_DENIED'
                  ? 'SEEDR_LIBRARY_ACCESS_DENIED: Seedr denied the library/auth operation.'
                  : `Seedr authentication check failed: ${auth.message || auth.code}`
            );
          }
          setSeedrConfigured(true);
          setSeedrLoading(false);
          return null;
        }
        setSeedrError(null);
      } catch (error: any) {
        const code = String(error?.code || '').trim();
        setSeedrError(
          code === 'SEEDR_TOKEN_REJECTED'
            ? 'SEEDR_TOKEN_REJECTED: Seedr rejected the configured API token.'
            : code === 'SEEDR_LIBRARY_ACCESS_DENIED'
              ? 'SEEDR_LIBRARY_ACCESS_DENIED: Seedr denied the library/auth operation.'
              : 'SEEDR_QUOTA_UNAVAILABLE: Seedr authentication status is temporarily unavailable.'
        );
        setSeedrLoading(false);
        return null;
      }

      // Keep the Seedr storage/quota cards populated independently of the
      // library metadata request. Quota is small and should never delay the
      // library UI or the download progress bar.
      void api.getSeedrQuota().then(quota => {
        if (!quota.configured) {
          setSeedrQuotaError('SEEDR_TOKEN_MISSING: Seedr API token is not configured in Render.');
          return;
        }        setSeedrQuotaError(null);
        setSeedrQuota({
          maxSpace: quota.maxSpace,          usedSpace: quota.usedSpace,
          remainingSpace: quota.remainingSpace,
        });
      }).catch((error: any) => {
        const code = String(error?.code || '').trim();
        const message =
          code === 'SEEDR_TOKEN_REJECTED'
            ? 'SEEDR_TOKEN_REJECTED: Seedr rejected the configured API token.'
            : code === 'SEEDR_LIBRARY_ACCESS_DENIED'
              ? 'SEEDR_LIBRARY_ACCESS_DENIED: Seedr denied access to account storage information.'
              : 'SEEDR_QUOTA_UNAVAILABLE: Seedr account storage information is unavailable right now.';
        setSeedrQuotaError(message);
      });

      // Refresh the active transfer progress independently of library
      // metadata. This request is intentionally tiny, so the progress bar can
      // move immediately instead of waiting for the library tree.
      const activeTaskId = seedrNotice?.taskId;
      if (activeTaskId && seedrNotice?.status !== 'completed') {
        void api.getSeedrTaskProgress(activeTaskId).then(progressResult => {
          if (progressResult.status === 'not_found') return;
          const progress = Math.max(0, Math.min(100, Number(progressResult.progress) || 0));
          const progressName = String(progressResult.name || '').trim();
          const progressFolderId = String(progressResult.folderId || '').trim();
          setSeedrNotice(prev => {
            if (!prev) return null;

            const canonicalName = String(prev.name || '').trim() || progressName;
            if (
              progressFolderId &&
              canonicalName &&
              canonicalName !== 'Waiting for torrent name…' &&
              canonicalName !== 'Waiting for Seedr metadata…'
            ) {
              rememberSeedrTorrentName(progressFolderId, canonicalName);
            }

            return {
              ...prev,
              name: canonicalName,
              folderId: progressFolderId || prev.folderId || '',
              status: progressResult.status,
              progress,
            };
          });
        }).catch(() => {
          // The normal task poll continues to provide progress updates.
        });
      }

      // Stage 1 — only the metadata required to paint the outer Seedr
      // Library immediately. Do not wait for quota or file rows.
      const result = await api.getSeedrLibrary(forceRefresh);

      setSeedrConfigured(result.configured);
      setSeedrLibraryRoot(result.root);
      setSeedrLibraryFolders(result.folders);
      setSeedrLoading(false);

      // Stage 2 — immediately load the file rows for every library folder.
      // The old implementation only set seedrPrefetchLoading=true here and
      // waited for a folder click to call getSeedrFolderContents(). That left
      // the root Files view showing a permanent spinner until the user opened
      // a folder and came back. Populate the same cache used by the folder
      // view so the root page is complete on first load.
      const validFolderKeys = new Set(
        result.folders.map(folder => String(folder.folderId || folder.id))
      );
      setSeedrFolderContentsCache(prev =>
        Object.fromEntries(
          Object.entries(prev).filter(([key]) => validFolderKeys.has(key))
        )
      );

      if (result.folders.length === 0) {
        setSeedrPrefetchLoading(false);
      } else {
        setSeedrPrefetchLoading(true);

        void (async () => {
          const foldersToLoad = result.folders.filter(folder =>
            String(folder.folderId || folder.id).trim()
          );

          const loadedEntries: Record<string, Array<{
            id: string;
            streamId?: string;
            name: string;
            size: number;
            folderId: string;
            folderPath: string;
          }>> = {};

          // Keep the initial page responsive when a Seedr account contains
          // many folders, while still loading all folder contents without
          // requiring user navigation.
          const concurrency = 4;
          for (let start = 0; start < foldersToLoad.length; start += concurrency) {
            const batch = foldersToLoad.slice(start, start + concurrency);

            await Promise.all(batch.map(async folder => {
              const folderId = String(folder.folderId || folder.id).trim();
              if (!folderId) return;

              try {
                const existingRequest = seedrFolderContentsRequests.current[folderId];
                const request = existingRequest || (async () => {
                  const contents = await api.getSeedrFolderContents(folderId);
                  const folderPath = folder.path || '/Torrent Studio';
                  return contents.files.map(file => ({
                    id: file.id,
                    streamId: file.streamId,
                    name: file.name,
                    size: Number(file.size) || 0,
                    folderId: file.folderId || folderId,
                    folderPath,
                  }));
                })();

                seedrFolderContentsRequests.current[folderId] = request;
                const mapped = await request;
                loadedEntries[folderId] = mapped;
                setSeedrFolderContentsCache(prev => ({
                  ...prev,
                  [folderId]: mapped,
                }));
              } catch (error) {
                // A single inaccessible/still-indexing folder must not leave
                // the whole Files page in a permanent loading state. The
                // folder can still be retried by clicking it.
                console.warn('Failed to prefetch Seedr folder contents:', folderId, error);
              } finally {
                delete seedrFolderContentsRequests.current[folderId];
              }
            }));
          }

          setSeedrPrefetchLoading(false);
        })();
      }

      // Do not clear the existing file rows during refresh. React keeps the
      // current visible component intact while fresh internal details arrive.
      // The cache effect above swaps them in as soon as they are available.
    } catch (error: any) {
      const code = String(error?.code || '').trim();
      const message =
        code === 'SEEDR_TOKEN_REJECTED'
          ? 'SEEDR_TOKEN_REJECTED: Seedr rejected the configured API token.'
          : code === 'SEEDR_LIBRARY_ACCESS_DENIED'
            ? 'SEEDR_LIBRARY_ACCESS_DENIED: Seedr denied access to the Seedr library.'
            : code === 'SEEDR_QUOTA_UNAVAILABLE'
              ? 'SEEDR_QUOTA_UNAVAILABLE: Seedr account storage information is unavailable right now.'
              : error?.message || 'Failed to refresh Seedr metadata';
      setSeedrError(message);
      setSeedrLoading(false);
      setSeedrPrefetchLoading(false);
      return null;
    }

    return result;
  }, [rememberSeedrTorrentName]);

  // Keep an opened folder synchronized with the background prefetch cache.
  // Changing the selected folder no longer reruns the entire library request.
  useEffect(() => {
    if (!selectedSeedrFolderId) return;

    const cached = seedrFolderContentsCache[selectedSeedrFolderId];
    if (!cached) return;

    setSeedrFiles(cached);
    setSeedrFolderContentsLoading(false);
  }, [selectedSeedrFolderId, seedrFolderContentsCache]);

  const handleOpenSeedrFolder = useCallback(async (folderId: string) => {
    if (!folderId || folderId === '__root__' || folderId === '__active_seedr__') return;
    const folder = seedrFolderGroups.find(item => item.folderId === folderId);
    const cached = seedrFolderContentsCache[folderId];

    setSelectedSeedrFolderId(folderId);
    setSeedrError(null);

    // Prefetch normally makes this path instant. Fall back to a request only
    // when the user clicks before that background request has completed.
    if (cached) {
      setSeedrFiles(cached);
      setSeedrFolderContentsLoading(false);
      return;
    }

    setSeedrFiles([]);
    setSeedrFolderContentsLoading(true);

    try {
      // If the automatic background prefetch is already running, await that
      // exact request instead of making a second network call.
      const pendingRequest = seedrFolderContentsRequests.current[folderId];
      if (pendingRequest) {
        const mapped = await pendingRequest;
        setSeedrFolderContentsCache(prev => ({ ...prev, [folderId]: mapped }));
        setSeedrFiles(mapped);
        return;
      }

      const result = await api.getSeedrFolderContents(folderId);
      const folderPath = folder?.path || '/Torrent Studio';
      const mapped = result.files.map(file => ({
        id: file.id,
        streamId: file.streamId,
        name: file.name,
        size: Number(file.size) || 0,
        folderId: file.folderId || folderId,
        folderPath,
      }));
      setSeedrFolderContentsCache(prev => ({ ...prev, [folderId]: mapped }));
      setSeedrFiles(mapped);
    } catch (error: any) {
      setSeedrError(error?.message || 'Failed to load Seedr folder contents');
    } finally {
      setSeedrFolderContentsLoading(false);
    }
  }, [seedrFolderGroups, seedrFolderContentsCache]);

  useEffect(() => {
    if (activeTab === 'files') loadSeedrLibrary();
  }, [activeTab, loadSeedrLibrary]);


  const hasActiveQbtTransfers = useMemo(
    () => torrents.some(t =>
      t.state === 'downloading' ||
      t.state === 'pausedDL' ||
      t.state === 'queuedDL' ||
      t.progress < 1
    ),
    [torrents]
  );

  // Poll qBittorrent compatibility data slowly when idle and faster only while
  // there is an active transfer. Seedr has its own lighter task polling loop.
  useEffect(() => {
    let isMounted = true;

    const pollTorrents = async () => {
      try {
        const torrentList = await api.getTorrents();        if (!isMounted) return;

        // Check for completions to fire push notifications
        torrentList.forEach(t => {          const prevState = prevTorrentStates.current[t.hash];
          if (prevState === 'downloading' && (t.state === 'completed' || t.progress >= 1)) {
            // Transfer finished! Trigger sound and push alert
            playNotificationSound();
            dispatchBrowserNotification(
              `Download Finished: ${t.name}`,
              `Direct streaming and direct download links are now ready in your cloud storage.`
            );
            // Refresh storage & files list
            api.getFiles(currentFolder).then(setFiles).catch(console.error);
            api.getStorageStats().then(setStorageStats).catch(console.error);
            api.getNotifications().then(setNotifications).catch(console.error);
          }
          prevTorrentStates.current[t.hash] = t.state;
        });

        const now = Date.now();
        const reconciledTorrentList = torrentList.map(t => {
          const pending = pendingTransferStates.current[t.hash];
          if (!pending) return t;

          if (pending.expiresAt <= now) {
            delete pendingTransferStates.current[t.hash];
            return t;
          }

          if (pending.state === 'pausedDL') {
            return { ...t, state: 'pausedDL', dlspeed: 0, eta: -1 };
          }

          return {
            ...t,
            state: 'downloading',
            eta: t.eta < 0 ? 0 : t.eta
          };
        });

        setTorrents(reconciledTorrentList);
      } catch (e) {
        console.error('Polling error:', e);
      }
    };

    pollTorrents();
    if (!hasActiveQbtTransfers) {
      return () => {
        isMounted = false;
      };
    }

    const interval = setInterval(pollTorrents, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [currentFolder, hasActiveQbtTransfers]);

  // Actions
  const appendActivityLog = useCallback((log: ActivityLog) => {
    setActivityLogs(prev => {
      const next = [log, ...prev].slice(0, 100);
      try {
        window.localStorage.setItem(activityStorageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const handleSearchAdd = async (
    source: string,
    size: number,
    title: string,
    infoHash?: string,
    sourceUrl?: string,
    descriptorUrl?: string,
    metadata?: {
      name: string;
      hash: string;
      files: { index: number; name: string; size: number; path: string; type: string; priority?: number }[];
      totalSize: number;
    }
  ) => {
    const trimmedSource = source.trim();
    const seedrSource =
      source.toLowerCase().startsWith('magnet:?')
        ? source
        : infoHash
          ? `magnet:?xt=urn:btih:${infoHash.trim()}`
          : trimmedSource;

    // Search-result Add is a direct Seedr action. Do not open the manual
    // magnet modal and do not ask the user to paste the magnet again.
    if (!seedrSource) {
      setSeedrAddBlockedNotice('This search result does not contain a usable magnet link.');
      setActiveTab('search');
      window.setTimeout(() => setSeedrAddBlockedNotice(null), 5000);
      return;
    }

    // Search results use metadata before starting Seedr. The search panel
    // may already have this cached from its background prefetch.
    let resolvedMetadata = metadata;
    if (!resolvedMetadata) {
      try {
        resolvedMetadata = await api.inspectMagnet(
          seedrSource,
          'Downloads',
          sourceUrl || '',
          descriptorUrl || ''
        );
      } catch (error: any) {
        setSeedrAddBlockedNotice(error?.message || 'Could not resolve torrent metadata.');
        setActiveTab('search');
        window.setTimeout(() => setSeedrAddBlockedNotice(null), 5000);
        return;
      }
    }

    // Seedr receives the original search magnet unchanged. Metadata is used
    // only to make the transfer name available immediately.
    const torrentName =
      String(resolvedMetadata?.name || '').trim() ||
      String(title || '').trim() ||
      'Torrent';

    await handleAddMagnet(
      seedrSource,
      'video',
      undefined,
      undefined,
      infoHash || resolvedMetadata?.hash || undefined,
      'seedr',
      undefined,
      undefined,
      torrentName,
      Number(resolvedMetadata?.totalSize || size || 0)
    );
  };

  const handleAddMagnet = async (
    magnet: string,
    category: string,
    selectedFiles?: number[],
    manifest?: { index?: number; name: string; size: number; priority: number }[],
    existingHash?: string,
    forceBackend?: 'seedr' | 'qbittorrent',
    selectedNames?: string[],
    seedrTaskId?: number | string,
    torrentName?: string,
    requiredBytes?: number
  ) => {
    try {
      if (seedrDownloadActive && forceBackend !== 'qbittorrent') {
        const error = new Error(
          'A Seedr download is already in progress. Free Seedr accounts allow one parallel download. Wait for it to finish before adding another magnet link.'
        );
        (error as any).code = 'SEEDR_PARALLEL_DOWNLOAD_LIMIT';
        throw error;
      }

      // Pre-check Seedr quota before creating the task. Seedr can reject an
      // over-quota torrent with a provider-specific 413 reason, so relying
      // only on the provider response made the warning inconsistent.
      if (forceBackend !== 'qbittorrent') {
        let required = Number(requiredBytes || 0);
        if (!required && Array.isArray(manifest)) {
          required = manifest
            .filter(file => Number(file.priority || 0) > 0)
            .reduce((sum, file) => sum + Math.max(0, Number(file.size || 0)), 0);
        }

        if (required > 0) {
          try {
            const quota = await api.getSeedrQuota();
            setSeedrQuota({
              maxSpace: quota.maxSpace,
              usedSpace: quota.usedSpace,
              remainingSpace: quota.remainingSpace,
            });

            if (quota.remainingSpace < required) {
              setActiveTab('search');
              setSeedrInsufficientSpacePrompt({
                requiredBytes: required,
                remainingBytes: quota.remainingSpace,
                magnet,
                category,
                selectedFiles,
                manifest,
                existingHash,
              });
              return;
            }
          } catch {
            // If quota lookup is temporarily unavailable, let Seedr make the
            // authoritative decision below rather than blocking the add.
          }
        }
      }

      const result = await api.addMagnet(
        magnet,
        category,
        selectedFiles,
        manifest,
        existingHash,
        forceBackend,
        selectedNames,
        seedrTaskId,
        torrentName
      );
      if (result.backend === 'seedr') {
        const initialTorrentName = String(torrentName || '').trim();
        const returnedFolderId = String((result as any).seedrFolderId || (result as any).seedrResponse?.folder_id || '').trim();
        if (returnedFolderId && initialTorrentName) {
          rememberSeedrTorrentName(returnedFolderId, initialTorrentName);
        }

        setSeedrNotice({
          taskId: result.seedrTaskId ?? null,
          name: String(torrentName || '').trim() || (() => {
            const response: any = result.seedrResponse;
            const responseName = String(
              response?.name ??
              response?.task?.name ??
              response?.title ??
              ''
            ).trim();
            if (responseName) return responseName;

            const selectedManifest = (manifest || []).filter(file => Number(file.priority || 0) > 0);
            if (selectedManifest.length === 1) return selectedManifest[0].name;
            if (selectedManifest.length > 1) {
              return selectedManifest[0].name + ` + ${selectedManifest.length - 1} more`;
            }

            return 'Waiting for torrent name…';
          })(),
          folderName: '',
          status: 'waiting',
          progress: 0,
          downloadUrl: null,
          // Only the files selected in the manifest are represented in the
          // pending UI. The backend applies the Seedr unwanted-file bitmap
          // immediately after creating the task; no pause/resume is used.
          files: (manifest || [])            .map((file, index) => ({ file, index }))
            .filter(({ file }) => Number(file.priority || 0) > 0)
            .map(({ file, index }) => ({
              id: `pending-${result.seedrTaskId ?? 'task'}-${index}`,
              name: file.name,              size: Number(file.size || 0),
              folderId: '__pending__',
              folderPath: '/Currently Downloading',
              url: null,
              available: false,
            })),
          seedrReply: (() => {
            const response: any = result.seedrResponse;
            const state = response?.state ?? response?.task?.state ?? response?.status ?? response?.task?.status;
            return state ? `Seedr replied: ${String(state)}` : 'Seedr replied: task accepted';
          })(),
          selectionApplied: Boolean((result as any).selectionApplied),
          selectionError: (result as any).selectionError || null,
        });;
      } else {
        setSeedrNotice(null);
      }
      if (result.backend === 'seedr') {
        const loggedName =
          String(torrentName || '').trim() ||
          String(result.seedrResponse?.name || result.seedrResponse?.task?.name || '').trim() ||
          'Torrent';

        const taskId = result.seedrTaskId ?? result.seedrResponse?.task_id ?? result.seedrResponse?.id ?? '';
        const folderId = result.seedrFolderId ?? result.seedrResponse?.folder_id ?? result.seedrResponse?.task?.folder_id ?? '';

        appendActivityLog({
          id: `seedr-add-${taskId || Date.now()}-${Date.now()}`,
          timestamp: Date.now(),
          type: 'torrent',
          userName: activeUser?.name || 'Seedr User',
          userId: activeUser?.id || 'seedr-user',
          action: 'Torrent added to Seedr',
          details: `${loggedName}${taskId ? ` • Task ${taskId}` : ''}${folderId ? ` • Folder ${folderId}` : ''} • Auto-delete in 2 hours`,
          status: 'success'
        });
      }

      // The add response is the important operation. Refresh secondary UI
      // state in the background so the Add button does not stay blocked on
      // extra qBittorrent/Seedr requests.
      void api.getTorrents()
        .then(setTorrents)
        .catch((refreshError) =>
          console.warn('Torrent added, but transfers could not be refreshed yet:', refreshError)
        );

      void api.getStorageStats()
        .then(setStorageStats)
        .catch((refreshError) =>
          console.warn('Torrent added, but storage stats could not be refreshed yet:', refreshError)
        );

      setActiveTab(result.backend === 'seedr' ? 'files' : 'transfers');
    } catch (error: any) {
      if (error?.code === 'SEEDR_INSUFFICIENT_SPACE') {
        let required = Number(error.requiredBytes || requiredBytes || 0);
        if (!required && Array.isArray(manifest)) {
          required = manifest
            .filter(file => Number(file.priority || 0) > 0)
            .reduce((sum, file) => sum + Math.max(0, Number(file.size || 0)), 0);
        }

        let remaining = Number(error.remainingSpace || 0);
        if (!remaining) {
          try {
            const quota = await api.getSeedrQuota();
            remaining = Number(quota.remainingSpace || 0);
            setSeedrQuota({
              maxSpace: Number(quota.maxSpace || 0),
              usedSpace: Number(quota.usedSpace || 0),
              remainingSpace: remaining,
            });
          } catch {
            // Keep the provider error visible even if quota refresh fails.
          }
        }

        setActiveTab('search');
        setSeedrInsufficientSpacePrompt({
          requiredBytes: required,
          remainingBytes: remaining,
          magnet,
          category,
          selectedFiles,
          manifest,
          existingHash,
        });
        return;
      }
      throw error;
    }
  };

  useEffect(() => {
    try {
      if (seedrNotice?.taskId != null && seedrNotice.status !== 'completed') {
        window.localStorage.setItem(seedrNoticeStorageKey, JSON.stringify(seedrNotice));
      } else {
        window.localStorage.removeItem(seedrNoticeStorageKey);
      }
    } catch {
      // Local storage may be unavailable in restricted browser contexts.
    }
  }, [seedrNotice]);

  // Completed Seedr notices are only a short-lived confirmation. Keep the
  // transfer screen clean by removing the card automatically after 3 seconds.
  useEffect(() => {
    if (!seedrNotice?.taskId || seedrNotice.status !== 'completed') return;

    const timeoutId = window.setTimeout(() => {
      setSeedrNotice(null);
    }, 8000);

    return () => window.clearTimeout(timeoutId);
  }, [seedrNotice?.taskId, seedrNotice?.status]);

  useEffect(() => {
    if (!seedrNotice?.taskId || seedrNotice.status === 'completed') return;

    let active = true;
    let timeoutId: number | null = null;

    const scheduleNextPoll = (delayMs: number) => {
      if (!active) return;
      timeoutId = window.setTimeout(poll, delayMs);
    };

    const applyProgress = (result: {
      status: 'waiting' | 'downloading' | 'completed' | 'not_found';
      progress: number;
      name?: string;
      folderId?: string;
    }) => {
      const progress = Math.max(0, Math.min(100, Number(result.progress) || 0));
      const completed = result.status === 'completed';

      setSeedrNotice(prev => {
        if (!prev) return null;

        const canonicalName = String(prev.name || '').trim() || String(result.name || '').trim();
        const resolvedFolderId = String(result.folderId || prev.folderId || '').trim();

        if (
          resolvedFolderId &&
          canonicalName &&
          canonicalName !== 'Waiting for torrent name…' &&
          canonicalName !== 'Waiting for Seedr metadata…'
        ) {
          rememberSeedrTorrentName(resolvedFolderId, canonicalName);
        }

        return {
          ...prev,
          name: canonicalName,
          folderId: resolvedFolderId,
          // Keep the polling effect alive long enough to fetch the completed
          // task details and promote the folder into the library. Marking the
          // notice "completed" here causes React to tear down this effect
          // immediately, which can abort the rest of the completion flow.
          status: completed ? 'downloading' : result.status,
          progress: completed ? 100 : progress,
        };
      });

      return completed;
    };

    const poll = async () => {
      if (!active) return;

      try {
        // This endpoint only asks Seedr for task state/progress, so it is much
        // faster than loading task contents, folder names, and file URLs.
        const progressResult = await api.getSeedrTaskProgress(seedrNotice.taskId!);
        if (!active) return;

        if (progressResult.status === 'not_found') {
          setSeedrNotice(null);
          setSeedrAddBlockedNotice(null);
          try {
            window.localStorage.removeItem(seedrNoticeStorageKey);
          } catch {}
          return;
        }

        const completed = applyProgress(progressResult);

        if (!completed) {
          // Poll frequently so the visible progress bar moves as soon as Seedr
          // reports a newer value.
          scheduleNextPoll(progressResult.status === 'waiting' ? 10000 : 4000);
          return;
        }

        // Only when complete do we make the heavier request for the final
        // files/download URLs before promoting the task into the library.
        const result = await api.getSeedrTask(seedrNotice.taskId!);
        if (!active) return;

        setSeedrNotice(prev => {
          if (!prev) return null;

          const resolvedFolderId = String(
            (result as any).folderId ||
            progressResult.folderId ||
            prev.folderId ||
            ''
          ).trim();
          const canonicalName = String(
            prev.name ||
            (result as any).name ||
            progressResult.name ||
            ''
          ).trim();

          if (
            resolvedFolderId &&
            canonicalName &&
            canonicalName !== 'Waiting for torrent name…' &&
            canonicalName !== 'Waiting for Seedr metadata…'
          ) {
            rememberSeedrTorrentName(resolvedFolderId, canonicalName);
          }

          return {
            ...prev,
            name: canonicalName,
            folderName: '',
            folderId: resolvedFolderId,
            // Keep the active library card mounted until the completed folder
            // has been inserted into seedrLibraryFolders below. Otherwise the
            // card can disappear for a render while Seedr's library catches up.
            status: 'downloading',
            progress: 100,
            downloadUrl: result.downloadUrl,
            files: Array.isArray(result.files) && result.files.length > 0 ? result.files : prev.files,
          };
        });

        const completedFolderId = String(
          (result as any).folderId ||
          (Array.isArray((result as any).files)
            ? (result as any).files.find((file: any) => String(file?.folderId || '').trim())?.folderId            : '') ||
          progressResult.folderId ||
          seedrNotice.folderId ||
          ''
        ).trim();
        const completedTorrentName = String(
          seedrNotice.name ||
          (result as any).name ||
          progressResult.name ||
          ''
        ).trim();

        const refreshCompletedLibrary = async () => {
          // Seedr can report a task as complete before the new folder appears
          // in the library tree. Add the completed folder to the UI immediately
          // from the completed task/folder response, then keep reconciling with
          // the real Seedr library until it becomes visible there too.
          let eagerFiles: Array<{
            id: string;
            streamId?: string;
            name: string;
            size: number;
            folderId: string;
            folderPath: string;
          }> = [];

          let eagerFolderId = completedFolderId;

          if (completedFolderId) {
            try {
              const contents = await api.getSeedrFolderContents(completedFolderId);
              eagerFiles = contents.files.map(file => ({
                id: file.id,
                streamId: file.streamId,
                name: file.name,
                size: Number(file.size) || 0,
                folderId: file.folderId || completedFolderId,
                folderPath: '/Torrent Studio/' + (completedTorrentName || 'Downloads'),
              }));

              if (eagerFiles.length > 0) {
                setSeedrFolderContentsCache(prev => ({
                  ...prev,
                  [completedFolderId]: eagerFiles,
                }));
                if (selectedSeedrFolderId === completedFolderId) {
                  setSeedrFiles(eagerFiles);
                  setSeedrFolderContentsLoading(false);
                }
              }
            } catch (error) {
              console.warn('Completed Seedr folder is not visible yet:', error);
            }

            // Show the completed folder immediately even when the Seedr library
            // index is still lagging behind the task completion.
            const eagerSize = eagerFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
            const eagerName = completedTorrentName || 'Completed Seedr download';
            setSeedrLibraryFolders(prev => {
              const exists = prev.some(folder => String(folder.folderId || folder.id) === completedFolderId);
              if (exists) return prev;

              return [
                {
                  id: completedFolderId,
                  folderId: completedFolderId,
                  name: eagerName,
                  path: '/Torrent Studio/' + eagerName,
                  filesCount: eagerFiles.length || 1,
                  totalSize: eagerSize || Number((result as any)?.size || 0),
                  folderCount: 0,
                  active: false,
                  progress: 100,
                },
                ...prev,
              ];
            });

            // The completed folder is now present in the UI state. Only now
            // mark the transfer notice completed, so React cannot remove the
            // active card before the new folder has been mounted.
            setSeedrNotice(prev => (
              prev ? { ...prev, status: 'completed', progress: 100 } : null
            ));
          }

          for (let attempt = 0; attempt < 12; attempt += 1) {
            const refreshed = await loadSeedrLibrary(true);

            // loadSeedrLibrary replaces the folder array with the latest API
            // response. Preserve our eager completed folder if Seedr's index is
            // still catching up.
            if (eagerFolderId) {
              const folderIdForMerge = eagerFolderId;
              const mergeName = completedTorrentName || 'Completed Seedr download';
              setSeedrLibraryFolders(prev => {
                const exists = prev.some(folder => String(folder.folderId || folder.id) === folderIdForMerge);
                if (exists) return prev;

                const mergeSize = eagerFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
                return [
                  {
                    id: folderIdForMerge,
                    folderId: folderIdForMerge,
                    name: mergeName,
                    path: '/Torrent Studio/' + mergeName,
                    filesCount: eagerFiles.length || 1,
                    totalSize: mergeSize,
                    folderCount: 0,
                    active: false,
                    progress: 100,
                  },
                  ...prev,
                ];
              });
            }

            const completedFolder = refreshed?.folders?.find(folder => {
              const folderId = String(folder.folderId || folder.id || '').trim();
              const folderName = String(folder.name || '').trim();
              return (
                (completedFolderId && folderId === completedFolderId) ||
                (!completedFolderId &&
                  completedTorrentName &&
                  folderName.toLowerCase() === completedTorrentName.toLowerCase())
              );
            });

            if (completedFolder) {
              const resolvedFolderId = String(
                completedFolder.folderId || completedFolder.id || completedFolderId || ''
              ).trim();

              // Once the real library index catches up, refresh its file rows too.
              if (resolvedFolderId) {
                try {
                  const contents = await api.getSeedrFolderContents(resolvedFolderId);
                  const mapped = contents.files.map(file => ({
                    id: file.id,
                    streamId: file.streamId,
                    name: file.name,
                    size: Number(file.size) || 0,
                    folderId: file.folderId || resolvedFolderId,
                    folderPath: completedFolder.path,
                  }));

                  setSeedrFolderContentsCache(prev => ({
                    ...prev,
                    [resolvedFolderId]: mapped,
                  }));

                  if (selectedSeedrFolderId === resolvedFolderId) {
                    setSeedrFiles(mapped);
                    setSeedrFolderContentsLoading(false);
                  }
                } catch (error) {
                  console.warn('Failed to load completed Seedr file details:', error);
                }
              }

              break;
            }

            if (attempt < 11) {
              await new Promise(resolve => window.setTimeout(resolve, 1500));
            }
          }
        };

        void refreshCompletedLibrary();
        setActiveSeedrFolderOpen(false);
      } catch {
        scheduleNextPoll(2500);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [seedrNotice?.taskId, seedrNotice?.status, loadSeedrLibrary, rememberSeedrTorrentName]);

  const handleCancelSeedrDownload = async () => {
    const taskId = seedrNotice?.taskId;
    if (taskId == null || isCancellingSeedr) return;

    const currentNotice = seedrNotice;
    try {
      setIsCancellingSeedr(true);
      await api.deleteSeedrTask(taskId);
      setSeedrNotice(null);
    } catch (error: any) {
      console.error('Failed to cancel Seedr download:', error);
      setSeedrNotice(currentNotice);
      setSeedrAddBlockedNotice(
        error?.message || 'Failed to cancel the Seedr download. Please try again.'
      );
      window.setTimeout(() => setSeedrAddBlockedNotice(null), 5000);
    } finally {
      setIsCancellingSeedr(false);
    }
  };

  const handleStreamTorrent = (torrent: TorrentItem) => {
    const streamableFile = torrent.files?.find(file => {
      if (file.priority <= 0 || file.progress < 0.999) return false;
      return /\.(mkv|mp4|m4v|webm|mov|avi|mp3|wav|flac|aac|ogg|m4a)$/i.test(file.name);
    });

    if (!streamableFile) return;

    const lower = streamableFile.name.toLowerCase();
    const type: StorageFile['type'] =
      /\.(mkv|mp4|m4v|webm|mov|avi)$/i.test(lower) ? 'video' : 'audio';

    const syntheticFile: StorageFile = {
      id: `torrent-${torrent.hash}-${streamableFile.index}`,
      name: streamableFile.name.split('/').pop() || streamableFile.name,
      path: streamableFile.path || streamableFile.name,
      folder: torrent.category || '/',
      size: streamableFile.size,
      type,
      mimeType: type === 'video' ? 'video/mp4' : 'audio/mpeg',
      createdAt: torrent.completion_on ? torrent.completion_on * 1000 : Date.now(),
      torrentHash: torrent.hash,
      isStreamable: true,
      ownerId: activeUser?.id || 'user_admin',
      ownerName: activeUser?.name || 'Admin',
      downloadUrl: `/api/torrents/download/${encodeURIComponent(torrent.hash)}/${streamableFile.index}`,
      streamUrl: `/api/torrents/stream/${encodeURIComponent(torrent.hash)}/${streamableFile.index}`
    };

    setActiveMediaFile(syntheticFile);
    setIsPlayerMinimized(false);
  };

  const handlePauseTorrent = async (hash: string) => {
    // Update immediately and hold that state through the next few polling
    // cycles while qBittorrent finishes applying stop().
    const previous = torrents;
    pendingTransferStates.current[hash] = {
      state: 'pausedDL',
      expiresAt: Date.now() + 5000
    };

    setTorrents(prev =>
      prev.map(t =>        t.hash === hash
          ? { ...t, state: 'pausedDL', dlspeed: 0, eta: -1 }
          : t
      )
    );

    try {      await api.pauseTorrent(hash);
    } catch (error) {
      delete pendingTransferStates.current[hash];
      console.error('Failed to pause torrent:', error);
      setTorrents(previous);
      throw error;
    }
  };

  const handleResumeTorrent = async (hash: string) => {
    const previous = torrents;
    pendingTransferStates.current[hash] = {
      state: 'downloading',
      expiresAt: Date.now() + 5000
    };

    setTorrents(prev =>
      prev.map(t =>
        t.hash === hash
          ? { ...t, state: 'downloading', eta: t.eta < 0 ? 0 : t.eta }
          : t
      )
    );

    try {
      await api.resumeTorrent(hash);
    } catch (error) {
      delete pendingTransferStates.current[hash];
      console.error('Failed to resume torrent:', error);
      setTorrents(previous);
      throw error;
    }
  };

  const handleDeleteTorrent = (hash: string) => {
    const torrent = torrents.find(t => t.hash === hash);
    if (!torrent) return;
    setDeleteTarget({
      type: 'torrent',
      id: torrent.hash,
      name: torrent.name,
      details: `${formatBytes(torrent.total_size)} • Progress: ${Math.round(torrent.progress * 100)}%`
    });
  };

  const handleUpdateFilePriority = async (hash: string, fileId: string, priority: number) => {
    const ids = fileId.split('|').map(Number).filter(Number.isFinite);
    const previous = torrents;

    // Reflect checkbox/priority changes immediately in the main torrent card.
    setTorrents(prev =>
      prev.map(t => {
        if (t.hash !== hash) return t;

        const nextFiles = (t.files || []).map(file =>
          ids.includes(file.index)
            ? {
                ...file,
                priority,
                progress: priority === 0 ? 0 : file.progress
              }
            : file
        );

        const selectedSize = nextFiles
          .filter(file => file.priority > 0)
          .reduce((sum, file) => sum + file.size, 0);

        return {
          ...t,
          files: nextFiles,
          selected_size: selectedSize
        };
      })
    );

    try {
      await api.setFilePriority(hash, fileId, priority);
    } catch (error) {
      console.error('Failed to update file priority:', error);
      setTorrents(previous);
      throw error;
    }

    api.getTorrents()
      .then(setTorrents)
      .catch(error => console.error('Failed to refresh torrents after priority update:', error));
  };


  const handleDownloadSeedrFolder = async (folderId: string, folderName = '') => {
    try {
      // Open the navigation synchronously from the click so the browser never
      // treats it as an async popup. The backend supplies Content-Disposition
      // with the requested filename.
      const zipName = folderName && !folderName.toLowerCase().endsWith('.zip')
        ? folderName + '.zip'
        : folderName;
      api.openSeedrFolderDownload(folderId, zipName);
    } catch (error) {
      console.error('Failed to start Seedr folder download:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to start Seedr folder download');
    }
  };

  const handleCopySeedrFileUrl = async (fileId: string) => {
    try {
      const result = await api.getSeedrFileDownload(fileId);
      await navigator.clipboard.writeText(result.url);
      setCopiedSeedrFileId(fileId);
      window.setTimeout(() => {
        setCopiedSeedrFileId(current => current === fileId ? null : current);
      }, 1800);
    } catch (error) {
      console.error('Failed to copy Seedr download link:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to copy Seedr download link');
    }
  };

  const handleDownloadSeedrFile = async (fileId: string, fileName = '') => {
    const popup = window.open('', '_blank', 'noopener,noreferrer');
    try {
      // Resolve the temporary Seedr URL only because the user clicked Download.
      // The final transfer then goes directly from Seedr to the browser.
      const result = await api.getSeedrFileDownload(fileId);
      const target = result.url;
      if (popup) {
        popup.location.href = target;
      } else {
        window.location.href = target;
      }
    } catch (error) {
      if (popup) popup.close();
      console.error('Failed to start Seedr download:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to start Seedr download');
    }
  };

  const findSeedrSubtitleTracks = useCallback((
    file: { id: string; name: string; folderId: string; folderPath: string },
    apiOrigin: string
  ): StorageFile['subtitleTracks'] => {
    const extension = (name: string) => name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || '';
    const videoExt = extension(file.name);
    if (!/^(mkv|mp4|m4v|webm|mov|avi|ts)$/.test(videoExt)) return [];

    const videoBase = file.name.slice(0, -(videoExt.length + 1)).trim().toLowerCase();
    const cachedSiblings = file.folderId
      ? (seedrFolderContentsCache[file.folderId] || [])
      : seedrAllPrefetchedFiles.filter(item =>
          item.folderPath === file.folderPath || item.folderId === file.folderId
        );

    const languageNames: Record<string, string> = {
      en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi',
      ar: 'Arabic', ara: 'Arabic', bn: 'Bengali', ben: 'Bengali',
      es: 'Spanish', spa: 'Spanish', fr: 'French', fra: 'French',
      de: 'German', deu: 'German', it: 'Italian', ita: 'Italian',
      pt: 'Portuguese', por: 'Portuguese', ru: 'Russian', rus: 'Russian',
      ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
      zh: 'Chinese', zho: 'Chinese'
    };

    return cachedSiblings
      .filter(item => item.id !== file.id && /\.(srt|vtt)$/i.test(item.name))
      .filter(item => {
        const subtitleExt = extension(item.name);
        const subtitleBase = item.name.slice(0, -(subtitleExt.length + 1)).trim().toLowerCase();
        return subtitleBase === videoBase ||
          subtitleBase.startsWith(videoBase + '.') ||
          subtitleBase.startsWith(videoBase + ' ');
      })
      .map((item, index) => {
        const subtitleExt = extension(item.name);
        const subtitleBase = item.name.slice(0, -(subtitleExt.length + 1)).trim();
        const suffix = subtitleBase.slice(videoBase.length).replace(/^[. _-]+/, '').trim();
        const languageKey = suffix.split(/[. _-]+/)[0]?.toLowerCase() || '';
        const language = languageNames[languageKey] ? languageKey : 'en';
        return {
          index,
          language,
          title: languageNames[languageKey] || suffix || 'Subtitles',
          codec: subtitleExt.toUpperCase(),
          url: apiOrigin + '/api/seedr/files/' + encodeURIComponent(item.id) +
            '/subtitle?filename=' + encodeURIComponent(item.name)
        };
      });
  }, [seedrAllPrefetchedFiles, seedrFolderContentsCache]);

  const handleStreamSeedrFile = async (file: { id: string; streamId?: string; name: string; size: number; folderId: string; folderPath: string }) => {
    // Stage 1: the clicked button immediately enters a loading state while
    // Render resolves the Seedr presentation/proxy URL. The player is opened
    // only after this step succeeds, so the user never sees an unresponsive
    // button followed by a blank modal.
    setSeedrStreamLoadingId(file.id);
    try {
      const type: StorageFile['type'] =
        /\.(mkv|mp4|m4v|webm|mov|avi|m3u8|ts)$/i.test(file.name) ? 'video' :
        /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(file.name) ? 'audio' :
        'document';

      if (type !== 'video' && type !== 'audio') {
        setSeedrError('This Seedr file is not a supported video or audio file.');
        return;
      }

      setSeedrError(null);
      const result = await api.getSeedrFileStream(file.streamId || file.id, file.name, type);
      const apiOrigin = (() => {
        try {
          return new URL(result.url, window.location.origin).origin;
        } catch {
          return window.location.origin;
        }
      })();
      const seedrResolvedStreamUrl =
        result.protocol === 'direct' && result.externalUrl
          ? result.externalUrl
          : result.url;
      const subtitleTracks = type === 'video'
        ? findSeedrSubtitleTracks(file, apiOrigin)
        : [];
      const syntheticFile: StorageFile = {
        id: `seedr-${file.id}`,
        name: result.name || file.name,
        path: file.folderPath === '/' ? `/${file.name}` : `${file.folderPath}/${file.name}`,
        folder: file.folderPath,
        size: file.size,
        type,
        mimeType: type === 'video' ? 'video/mp4' : 'audio/mpeg',
        createdAt: Date.now(),
        ownerId: activeUser?.id || 'user_admin',
        ownerName: activeUser?.name || 'Admin',
        isStreamable: true,
        streamUrl: seedrResolvedStreamUrl,
        externalStreamUrl: result.externalUrl,
        subtitleTracks,
        downloadUrl: '/api/seedr/files/' + encodeURIComponent(file.id) + '/download',
      };

      setActiveMediaFile(syntheticFile);
      setIsPlayerMinimized(false);
    } catch (error) {      console.error('Failed to create Seedr stream URL:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to create Seedr stream URL');
    } finally {
      setSeedrStreamLoadingId(current => current === file.id ? null : current);
    }
  };

  const handleDeleteSeedrFile = async (file: { id: string; name: string; size: number; folderId: string; folderPath: string }) => {    setSeedrDeleteNotice('Deleting…');
    try {
      // A single-file Seedr folder is represented directly in My Cloud Files.
      // In that special case, delete the whole Seedr folder rather than only
      // the file. Files inside multi-file folders still use file deletion.
      const group = seedrFolderGroups.find(item => item.folderId === file.folderId);
      const isSingleFileFolder =
        file.folderId !== '__root__' &&
        group?.filesCount === 1;

      if (isSingleFileFolder) {
        await api.deleteSeedrFolder(file.folderId);
        setSeedrFiles(prev => prev.filter(item => item.folderId !== file.folderId));
        // The Files tab also renders the lazily-prefetched Seedr files cache.
        // Remove the deleted folder from that cache as well, otherwise the
        // deleted file remains visible at the root after returning from the
        // Seedr folder view.
        setSeedrFolderContentsCache(prev => {
          if (!(file.folderId in prev)) return prev;
          const next = { ...prev };
          delete next[file.folderId];
          return next;
        });
      } else {
        await api.deleteSeedrFile(file.id);
        setSeedrFiles(prev => prev.filter(item => item.id !== file.id));
        setSeedrFolderContentsCache(prev => {
          const cached = prev[file.folderId];
          if (!cached) return prev;
          const remaining = cached.filter(item => item.id !== file.id);
          const next = { ...prev };
          if (remaining.length > 0) {
            next[file.folderId] = remaining;
          } else {
            delete next[file.folderId];
          }
          return next;
        });
        setSeedrLibraryFolders(prev => prev.map(item =>
          (item.folderId === file.folderId || item.id === file.folderId)
            ? {
                ...item,
                filesCount: Math.max(0, Number(item.filesCount || 0) - 1),
                totalSize: Math.max(0, Number(item.totalSize || 0) - Number(file.size || 0)),
              }
            : item
        ));
      }

      setSeedrError(null);
      setSeedrDeleteNotice('Deleted successfully');
      window.setTimeout(() => setSeedrDeleteNotice(null), 1800);
      const quota = await api.getSeedrQuota().catch(() => null);
      if (quota?.configured) {
        setSeedrQuota({
          maxSpace: quota.maxSpace,
          usedSpace: quota.usedSpace,
          remainingSpace: quota.remainingSpace
        });
      }
    } catch (error) {
      setSeedrDeleteNotice(null);
      console.error('Failed to delete Seedr item:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to delete Seedr item');
    }
  };

  const handleDeleteSeedrFolder = async (folderId: string) => {
    setSeedrDeleteNotice('Deleting…');
    try {
      await api.deleteSeedrFolder(folderId);
      setSeedrFiles(prev => prev.filter(item => item.folderId !== folderId));
      setSeedrFolderContentsCache(prev => {
        if (!(folderId in prev)) return prev;
        const next = { ...prev };
        delete next[folderId];
        return next;
      });
      setSeedrLibraryFolders(prev => prev.filter(item => item.folderId !== folderId && item.id !== folderId));
      setSelectedSeedrFolderId(prev => prev === folderId ? null : prev);
      setSeedrError(null);
      setSeedrDeleteNotice('Deleted successfully');
      window.setTimeout(() => setSeedrDeleteNotice(null), 1800);
      const quota = await api.getSeedrQuota().catch(() => null);
      if (quota?.configured) {
        setSeedrQuota({
          maxSpace: quota.maxSpace,
          usedSpace: quota.usedSpace,
          remainingSpace: quota.remainingSpace
        });
      }
    } catch (error) {
      setSeedrDeleteNotice(null);
      console.error('Failed to delete Seedr folder:', error);
      setSeedrError(error instanceof Error ? error.message : 'Failed to delete Seedr folder');
    }
  };

  const handleDeleteFile = (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    setDeleteTarget({
      type: 'file',
      id: file.id,
      name: file.name,
      details: `${formatBytes(file.size)} • Folder: ${file.folder}`
    });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'file') {
        await api.deleteFile(deleteTarget.id);
        setFiles(prev => prev.filter(f => f.id !== deleteTarget.id));
        const stats = await api.getStorageStats();
        setStorageStats(stats);
      } else if (deleteTarget.type === 'torrent') {
        await api.deleteTorrent(deleteTarget.id, true);
        setTorrents(prev => prev.filter(t => t.hash !== deleteTarget.id));
        const stats = await api.getStorageStats();
        setStorageStats(stats);
        const f = await api.getFiles(currentFolder);
        setFiles(f);
      }
    } catch (err) {
      console.error('Failed to execute delete:', err);
    }
  };

  const handleCreateFolder = async (name: string, isShared: boolean) => {
    const newFolder = await api.createFolder(name, currentFolder, isShared);
    setFolders(prev => [...prev, newFolder]);
  };

  const handleMoveFile = async (fileId: string, targetFolder: string) => {
    await api.moveFile(fileId, targetFolder);
    const updated = await api.getFiles(currentFolder);
    setFiles(updated);
  };

  const handleRename = async (id: string, newName: string, isFolder: boolean) => {
    await api.renameItem(id, newName, isFolder);
    if (isFolder) {
      const f = await api.getFolders();
      setFolders(f);
    }
    const updated = await api.getFiles(currentFolder);
    setFiles(updated);
  };

  const handleFolderShareSave = async (folderId: string, isShared: boolean, permissions: Record<string, UserPermission>) => {
    await api.updateFolderShare(folderId, isShared, permissions);
    const f = await api.getFolders();
    setFolders(f);
  };

  const handleSwitchUser = async (userId: string) => {
    const { activeUser: newUser } = await api.switchUser(userId);
    setActiveUser(newUser);
  };

  const handleRunCleanup = async () => {
    const res = await api.runCleanup();
    const stats = await api.getStorageStats();
    setStorageStats(stats);
    const f = await api.getFiles(currentFolder);
    setFiles(f);
    const logs = await api.getLogs();
    try {
      const rawLocalLogs = window.localStorage.getItem(activityStorageKey);
      const localLogs = rawLocalLogs ? JSON.parse(rawLocalLogs) : [];
      setActivityLogs(Array.isArray(localLogs) && localLogs.length ? localLogs : logs);
    } catch {
      setActivityLogs(logs);
    }
    return res;
  };

  // Download batch zip
  // Global telemetry speeds
  const totalDlSpeed = torrents
    .filter(t => t.state === 'downloading')
    .reduce((acc, t) => acc + t.dlspeed, 0);
  const totalUpSpeed = torrents.reduce((acc, t) => acc + t.upspeed, 0);
  const activeDownloadsCount = torrents.filter(t => t.state === 'downloading').length;
  const unreadNotifsCount = notifications.filter(n => !n.read).length;

  const currentFolderPrefix = currentFolder === '/' ? '/' : currentFolder + '/';
  const visibleFolders = folders
    .filter(folder => folder.path !== '/' && folder.path.startsWith(currentFolderPrefix))
    .filter(folder => {
      const remainder = folder.path.slice(currentFolderPrefix.length);
      return remainder.length > 0 && !remainder.includes('/');
    });

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'bg-slate-950 text-slate-100' : theme === 'dim' ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'} transition-colors duration-200`}>
      {/* Top Main Navigation Header */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-2.5 sm:px-6 py-1.5 sm:py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 sm:gap-3">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25">
              <Cloud className="w-4 h-4 sm:w-5 sm:h-5 text-slate-950 font-black fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h1 className="text-sm sm:text-lg font-black tracking-tight text-white">Torrent Studio</h1>
                <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-300 uppercase tracking-widest border border-cyan-500/30">
                  qBt WebAPI
                </span>
              </div>
              <p className="text-[10px] text-slate-400 hidden sm:block">
                Unlimited Cloud Seedbox & Media Streamer
              </p>
            </div>
          </div>

          {/* Center: Live speeds & Storage Indicator */}
          <div className="hidden md:flex items-center gap-4">
            {/* Speed Pointers */}
            <div className="flex items-center gap-3 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono">
              <div className="flex items-center gap-1 text-cyan-400">
                <Download className="w-3.5 h-3.5" />
                <span>{formatSpeed(totalDlSpeed)}</span>
              </div>
              <span className="text-slate-700">|</span>
              <div className="flex items-center gap-1 text-indigo-400">
                <Upload className="w-3.5 h-3.5" />
                <span>{formatSpeed(totalUpSpeed)}</span>
              </div>
            </div>


          </div>

          {/* Right: Quick actions & User Switcher */}
          <div className="flex items-center gap-2">
            {/* "+ Add Magnet" Primary CTA */}
            <button
              onClick={() => openAddMagnet()}
              className="px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-lg sm:rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 text-xs sm:text-sm font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition tap-target"
            >
              <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[3]" />
              <span className="hidden sm:inline">Add Magnet</span>
              <span className="sm:hidden">Add</span>
            </button>

            {/* Notification Bell */}
            <button
              onClick={() => setIsNotificationsOpen(true)}
              className="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 relative transition tap-target flex items-center justify-center border border-slate-800"
              title="Notifications & Push Alerts"
            >
              <Bell className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              {unreadNotifsCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500 text-slate-950 font-bold text-[9px] flex items-center justify-center">
                  {unreadNotifsCount}
                </span>
              )}
            </button>

            {/* Theme Toggle */}
            <button
              onClick={() => setTheme(theme === 'dark' ? 'dim' : theme === 'dim' ? 'light' : 'dark')}
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 transition tap-target hidden sm:flex items-center justify-center border border-slate-800"
              title={`Theme: ${theme}`}
            >
              {theme === 'light' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-cyan-400" />}            </button>

          </div>
        </div>
      </header>

      {/* Desktop Subheader Navigation Tabs */}
      <div className="hidden md:block bg-slate-900/60 border-b border-slate-800/80 px-6">
        <div className="max-w-7xl mx-auto flex items-center gap-2 py-2">          <button
            onClick={() => setActiveTab('search')}
            className={activeTab === 'search'
              ? 'px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
              : 'px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'}
          >
            <Search className="w-4 h-4" />
            <span>Search</span>
          </button>

          <button
            onClick={() => setActiveTab('files')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'files'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Folder className="w-4 h-4" />
            <span>My Cloud Files</span>
            <span className="text-[10px] opacity-70">({files.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('activity')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'activity'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Activity Log</span>
          </button>

          <button
            onClick={() => setActiveTab('storage')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'storage'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Auto-Cleanup & Disk</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-2.5 sm:p-6 pb-20 md:pb-12">
        {seedrAddBlockedNotice && (
          <div className="mb-2.5 sm:mb-4 p-2.5 sm:p-3.5 rounded-xl sm:rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5 shadow-lg">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-bold text-amber-300">Cannot add another Seedr download</div>
              <div className="mt-0.5 text-amber-200/80">{seedrAddBlockedNotice}</div>
            </div>
          </div>
        )}

        {/* TAB 0: TORRENT SEARCH
            Keep this component mounted when switching tabs so an in-flight
            search continues in the background and its results remain available
            when the user returns to Search. */}
        <div className={activeTab === 'search' ? 'block' : 'hidden'}>
          <TorrentSearchPanel onAdd={handleSearchAdd} />

          {seedrInsufficientSpacePrompt && (
            <div className="fixed inset-x-3 top-20 z-[100] flex justify-center pointer-events-none">
              <div className="w-full max-w-md rounded-2xl border border-rose-400/40 bg-slate-950/95 backdrop-blur-xl shadow-[0_0_30px_rgba(244,63,94,0.22)] p-4 pointer-events-auto">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 rounded-xl bg-rose-500/10 border border-rose-500/20 p-2">
                    <AlertTriangle className="w-5 h-5 text-rose-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-rose-300 text-sm">Seedr storage is full</div>
                    <div className="mt-1 text-xs leading-5 text-slate-300">
                      This torrent needs <span className="font-semibold text-slate-100">{formatBytes(seedrInsufficientSpacePrompt.requiredBytes)}</span>,
                      but only <span className="font-semibold text-rose-300">{formatBytes(seedrInsufficientSpacePrompt.remainingBytes)}</span> is available.
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const prompt = seedrInsufficientSpacePrompt;
                          setSeedrInsufficientSpacePrompt(null);
                          void handleAddMagnet(
                            prompt.magnet,
                            prompt.category,
                            prompt.selectedFiles,
                            prompt.manifest,
                            prompt.existingHash,
                            'qbittorrent'
                          );
                        }}
                        className="flex-1 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 px-3 py-2 text-xs font-bold transition"
                      >
                        Use qBittorrent
                      </button>
                      <button
                        type="button"
                        onClick={() => setSeedrInsufficientSpacePrompt(null)}
                        className="rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-2 text-xs font-semibold transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* TAB 2: MY CLOUD FILES */}
        {activeTab === 'files' && (
          <div className="space-y-2.5 sm:space-y-4">
            {/* Persistent Seedr Library */}
            <div className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
              {seedrDeleteNotice && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{seedrDeleteNotice}</span>
                </div>
              )}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                    <Cloud className="w-5 h-5 text-emerald-400" />
                    <span>Seedr Library</span>
                    {seedrConfigured && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                        {seedrLibraryRoot?.filesCount || 0} files
                      </span>
                    )}
                  </h2>
                  <p className="hidden sm:block text-xs text-slate-400 mt-0.5">
                    Files already downloaded to your Seedr account stay visible here, even after refreshing Torrent Studio.
                  </p>
                  {seedrConfigured && (
                    seedrQuota ? (
                      <>                      <div className="grid mt-3 grid-cols-3 gap-2 max-w-xl">
                        <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Consumed</div>
                          <div className="text-sm font-bold text-slate-100 mt-0.5">{formatBytes(seedrQuota.usedSpace)}</div>
                        </div>
                        <div
                          className={`rounded-lg px-3 py-2 border transition-all duration-300 ${
                            seedrQuota.remainingSpace > 0 && seedrQuota.remainingSpace < 500 * 1024 * 1024
                              ? 'border-rose-400/70 bg-rose-400/10 ring-1 ring-rose-400/30 shadow-[0_0_18px_rgba(244,63,94,0.24)]'
                              : seedrQuota.maxSpace > 0 && seedrQuota.remainingSpace / seedrQuota.maxSpace <= 0.3
                                ? 'border-amber-400/60 bg-amber-400/10 ring-1 ring-amber-400/25 shadow-[0_0_18px_rgba(251,191,36,0.18)]'
                                : 'bg-slate-900/80 border-slate-800'
                          }`}
                        >
                          <div className={`text-[10px] uppercase tracking-wide ${
                            seedrQuota.remainingSpace > 0 && seedrQuota.remainingSpace < 500 * 1024 * 1024
                              ? 'text-rose-300'
                              : seedrQuota.maxSpace > 0 && seedrQuota.remainingSpace / seedrQuota.maxSpace <= 0.3
                                ? 'text-amber-300'
                                : 'text-slate-500'
                          }`}>Remaining</div>
                          <div className={`text-sm font-bold mt-0.5 ${
                            seedrQuota.remainingSpace <= 0
                              ? 'text-rose-300'
                              : seedrQuota.remainingSpace < 500 * 1024 * 1024
                                ? 'text-rose-300'
                                : seedrQuota.maxSpace > 0 && seedrQuota.remainingSpace / seedrQuota.maxSpace <= 0.3
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                          }`}>
                            {formatQuotaBytes(seedrQuota.remainingSpace)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Total</div>
                          <div className="text-sm font-bold text-slate-100 mt-0.5">{formatBytes(seedrQuota.maxSpace)}</div>
                        </div>
                      </div>


                    </>
                    ) : null
                  )}
                </div>
                <button
                  type="button"
                  onClick={loadSeedrLibrary}
                  disabled={seedrLoading}
                  className="shrink-0 px-2 sm:px-3 py-1.5 rounded-lg sm:rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${seedrLoading ? 'animate-spin' : ''}`} />
                  <span>{seedrLoading ? 'Refreshing...' : 'Refresh'}</span>
                </button>
              </div>

              {seedrConfigured && seedrQuota && seedrQuota.remainingSpace <= 0 && (
                <div className="mt-3 rounded-xl bg-rose-500/10 border border-rose-500/20 px-3 py-2.5 text-xs text-rose-200">
                  <strong>Seedr is full.</strong> New torrents that fit the Seedr size limit will be offered to qBittorrent instead, or you can free space in Seedr and try again.
                </div>
              )}

              {seedrError && (
                <div className="mt-3 rounded-xl bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-300">
                  {seedrError}
                </div>
              )}

              {seedrQuotaError && !seedrError && (
                <div className="mt-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-200">
                  {seedrQuotaError}
                </div>
              )}

              {!seedrLoading && !seedrError && !seedrConfigured && (
                <div className="mt-3 rounded-xl bg-slate-900/70 border border-slate-800 px-3 py-3 text-xs text-slate-400">
                  Seedr is not configured on the server.
                </div>
              )}

              {!seedrLoading && !seedrError && seedrConfigured && (seedrLibraryRoot?.filesCount || 0) === 0 && seedrLibraryFolders.length === 0 && !(seedrNotice?.taskId != null && seedrNotice.status !== 'completed') && (
                <div className="mt-3 rounded-xl bg-slate-900/70 border border-slate-800 px-3 py-3 text-xs text-slate-400">
                  No completed files are currently visible in your Seedr library.                </div>
              )}

              {seedrConfigured && (
                <div className="mt-3">
                  {selectedSeedrFolderId === null ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2">
                      {seedrFolderGroups.map(folder => {
                        // Seedr always stores a torrent as a folder. Keep the                        // top-level library consistent even when the folder has
                        // only one file; open it to access file actions.
                        return (
                          <div
                            key={folder.folderId}
                            className="h-full rounded-lg sm:rounded-xl bg-slate-900/80 border border-slate-800 px-2.5 sm:px-3 py-2 sm:py-3 hover:border-cyan-500/30 transition"
                          >
                            <div className="flex items-center gap-2.5">
                              <button
                                type="button"
                                onClick={() => void handleOpenSeedrFolder(folder.folderId)}
                                className="min-w-0 flex-1 text-left flex items-center gap-3"
                                disabled={folder.folderId === '__root__'}
                              >
                                <div className="p-1.5 sm:p-2 rounded-lg bg-cyan-500/10 text-cyan-400 shrink-0">
                                  <Folder className="w-4 h-4 sm:w-5 sm:h-5" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] sm:text-sm font-semibold text-slate-100">{folder.name}</div>
                                  <div className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5">
                                    {folder.filesCount} files • {formatBytes(folder.totalSize)}
                                    {folder.active && <span className="text-emerald-300"> • Downloading</span>}
                                  </div>
                                  {folder.active && (
                                    <div className="mt-1.5 flex items-center gap-2">
                                      <div className="h-1.5 flex-1 rounded-full bg-slate-800 overflow-hidden">
                                        <div
                                          className="h-full rounded-full bg-emerald-400 transition-all duration-500"
                                          style={{ width: (folder.progress ?? 0) + '%' }}
                                        />
                                      </div>
                                      <span className="shrink-0 text-[10px] font-mono font-semibold text-emerald-300">
                                        {Number(folder.progress ?? 0).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '')}%
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
                              </button>

                              {folder.active && (
                                <div className="shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => void handleCancelSeedrDownload()}
                                    disabled={isCancellingSeedr || seedrNotice?.taskId == null}
                                    className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40 disabled:cursor-not-allowed text-[10px] font-bold transition"
                                    title="Cancel Seedr download"
                                  >
                                    {isCancellingSeedr ? 'Cancelling…' : 'Cancel'}
                                  </button>
                                </div>
                              )}

                              {!folder.active && folder.folderId !== '__root__' && (
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => handleDownloadSeedrFolder(folder.folderId, folder.name)}
                                    className="px-2 py-1.5 sm:px-2.5 rounded-lg bg-emerald-400 text-slate-950 font-bold text-xs hover:bg-emerald-300 transition flex items-center gap-1"
                                    title="Download folder"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline">Download</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteSeedrFolder(folder.folderId)}
                                    className="p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 transition"
                                    title="Delete Seedr folder"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}                    </div>
                  ) : (
                    (() => {
                      const folder = seedrFolderGroups.find(item => item.folderId === selectedSeedrFolderId);
                      if (!folder) return null;

                      return (
                        <div>
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSeedrFolderId(null);
                                setSeedrFiles([]);
                                setSeedrFolderContentsLoading(false);
                                setSeedrError(null);
                              }}
                              className="shrink-0 px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                            >
                              ← Back to folders
                            </button>
                            <div className="text-right min-w-0">
                              <div className="text-sm font-semibold text-slate-100 truncate">{folder.name}</div>
                              <div className="text-[10px] text-slate-500">{folder.filesCount} files • {formatBytes(folder.totalSize)}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleDownloadSeedrFolder(folder.folderId)}
                              className="shrink-0 px-2 py-1.5 rounded-lg bg-emerald-400 text-slate-950 font-bold text-xs hover:bg-emerald-300 transition whitespace-nowrap"
                            >
                              Download ZIP
                            </button>
                          </div>

                          {seedrFolderContentsLoading ? (
                            <div className="py-10 text-center text-xs text-slate-400">
                              <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-emerald-400" />
                              Loading folder contents…
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 gap-2">
                              {seedrFiles.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })).map(file => (
                              <div
                                key={file.id}
                                className="flex items-center justify-between gap-3 rounded-xl bg-slate-900/80 border border-slate-800 px-3 py-2.5"
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-slate-200">{file.name}</div>
                                  <div className="text-[10px] text-slate-500 mt-0.5">
                                    {formatBytes(file.size)}
                                    {file.downloading ? ' • Downloading' : ''}
                                  </div>
                                  {file.downloadProgress != null && (
                                    <div className="mt-1.5 flex items-center gap-2 max-w-sm">
                                      <div className="h-1.5 flex-1 rounded-full bg-slate-800 overflow-hidden">
                                        <div
                                          className="h-full rounded-full bg-emerald-400 transition-all duration-500"
                                          style={{ width: Math.max(0, Math.min(100, file.downloadProgress)) + '%' }}
                                        />
                                      </div>
                                      <span className="shrink-0 text-[10px] font-mono font-semibold text-emerald-300">
                                        {Number(file.downloadProgress).toFixed(0)}%
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div className="shrink-0 flex items-center gap-1.5">
                                  {/\.(mkv|mp4|m4v|webm|mov|avi|m3u8|ts|mp3|wav|flac|aac|ogg|m4a)$/i.test(file.name) && (
                                    <button
                                      type="button"
                                      onClick={() => void handleStreamSeedrFile(file)}
                                      disabled={seedrStreamLoadingId === file.id}
                                      className="p-2 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 transition disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5 tap-target"
                                    >
                                      {seedrStreamLoadingId === file.id ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <Play className="w-4 h-4 fill-current translate-x-px" />
                                      )}
                                      <span className="hidden sm:inline">{seedrStreamLoadingId === file.id ? 'Preparing…' : 'Stream'}</span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleDownloadSeedrFile(file.id, file.name)}
                                    className="p-2 rounded-xl bg-emerald-400 text-slate-950 font-bold text-xs hover:bg-emerald-300 transition flex items-center justify-center tap-target"
                                  >
                                    <Download className="w-4 h-4 sm:hidden" />
                                    <span className="hidden sm:inline">Download</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopySeedrFileUrl(file.id)}
                                    className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition tap-target"
                                    title="Copy direct download URL"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline">{copiedSeedrFileId === file.id ? 'Copied' : 'Copy URL'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteSeedrFile(file)}
                                    className="p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 transition"
                                    title="Delete this file"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            ))}
                            </div>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              )}            </div>

            {/* Header & Breadcrumb & Search */}
            <div className="flex flex-col gap-2 p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-slate-900 border border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                {/* Folder Breadcrumb */}
                <div className="flex items-center gap-2 overflow-x-auto text-xs font-semibold">
                  <button
                    onClick={() => setCurrentFolder('/')}
                    className={`px-2.5 py-1.5 rounded-lg transition ${
                      currentFolder === '/'
                        ? 'bg-cyan-500/20 text-cyan-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Root
                  </button>

                </div>


              </div>

              {/* Search & Category Filter */}
              <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-2 border-t border-slate-800/80">
                <div className="relative flex-1 w-full">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Search files by name..."
                    value={fileSearch}
                    onChange={(e) => setFileSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 sm:py-1.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto text-xs">
                  {['all', 'video', 'audio', 'document', 'archive'].map((t) => (
                    <button
                      key={t}
                      onClick={() => setFileTypeFilter(t)}
                      className={`px-2.5 py-1 rounded-lg capitalize font-medium transition ${
                        fileTypeFilter === t
                          ? 'bg-cyan-500 text-slate-950 font-bold'
                          : 'bg-slate-850 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>              </div>
            </div>

            {/* Folders and Files */}
                {visibleFolders.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2.5">
                    {visibleFolders
                      .map((folder) => (
                        <button
                          key={folder.id}                          type="button"
                          onClick={() => setCurrentFolder(folder.path)}
                          className="w-full p-3.5 rounded-2xl bg-slate-900 border border-slate-800 hover:border-cyan-500/40 hover:bg-slate-900/80 transition shadow-sm flex items-center gap-3 text-left group"
                        >
                          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 shrink-0">
                            <Folder className="w-5 h-5 text-cyan-400" />
                          </div>
                          <div className="truncate flex-1">
                            <h4 className="text-sm font-semibold text-slate-200 truncate group-hover:text-cyan-400 transition">
                              {folder.name}
                            </h4>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {folder.filesCount || 0} files • {formatBytes(folder.totalSize || 0)}
                            </p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                        </button>
                      ))}
                  </div>
                ) : null}

                {visibleFiles.length > 0 && (
                  <div className="grid grid-cols-1 gap-2.5">
                    {visibleFiles.map((file) => (
                      <FileCard
                        key={file.id}
                        file={file}
                        onPlay={(f) => {
                          // Root "My Cloud Files" rows are Seedr files too, but
                          // they must use the same resolver as the working folder
                          // view so Vercel + Render always targets the backend.
                          if (
                            f.ownerId === 'seedr' &&
                            (f.type === 'video' || f.type === 'audio')
                          ) {
                            void handleStreamSeedrFile({
                              id: f.id,
                              streamId: f.streamId || f.id,
                              name: f.name,
                              size: f.size,
                              folderId: '',
                              folderPath: f.folder || '/'
                            });
                            return;
                          }

                          setActiveMediaFile(f);
                          setIsPlayerMinimized(false);
                        }}
                        streamLoading={file.ownerId === 'seedr' && seedrStreamLoadingId === file.id}
                        onRename={(f) => setRenameItem({ id: f.id, name: f.name, isFolder: false })}
                        onMove={(f) => setMoveFile(f)}
                        canEdit={activeUser?.role !== 'viewer'}
                        canDelete={activeUser?.role === 'admin'}
                      />
                    ))}
                  </div>
                )}

                {seedrPrefetchLoading && currentFolder === '/' && seedrAllPrefetchedFiles.length === 0 ? (
                  <div className="py-10 text-center rounded-2xl bg-slate-900 border border-slate-800 p-8">
                    <RefreshCw className="w-8 h-8 text-emerald-400 mx-auto mb-3 animate-spin" />
                    <h3 className="text-sm font-bold text-slate-300">Loading Seedr files…</h3>
                    <p className="text-xs text-slate-500 mt-1">Folder metadata is ready. Loading file details in the background.</p>
                  </div>
                ) : visibleFolders.length === 0 && visibleFiles.length === 0 && (
                  <div className="py-16 text-center rounded-2xl bg-slate-900 border border-slate-800 p-8">
                    <Folder className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <h3 className="text-sm font-bold text-slate-300">No files found in this folder</h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Completed torrent downloads and uploaded media appear here instantly.
                    </p>
                  </div>
                )}

                {backgroundMetadataJob && (
                  <div className={`mt-3 rounded-xl border px-3 py-3 ${backgroundMetadataJob.error ? 'border-rose-500/30 bg-rose-500/10' : backgroundMetadataJob.ready ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-cyan-500/30 bg-cyan-500/10'}`}>
                    <div className="flex items-center gap-3">
                      <Loader2 className={`w-5 h-5 shrink-0 ${backgroundMetadataJob.ready ? 'text-emerald-400' : backgroundMetadataJob.error ? 'text-rose-400' : 'text-cyan-400 animate-spin'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100">{backgroundMetadataJob.title}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{backgroundMetadataJob.message}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const source = backgroundMetadataJob.hash
                            ? 'magnet:?xt=urn:btih:' + backgroundMetadataJob.hash
                            : '';
                          openMetadataSelector(source);
                          setActiveTab('files');
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => setBackgroundMetadataJob(null)}
                        className="p-1 rounded-lg text-slate-500 hover:text-slate-200"
                        aria-label="Dismiss metadata status"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}

                {(backgroundMetadataJobs.length > 0 || backgroundMetadataLoading) && (
                  <div className="mt-3 rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-100">Background metadata</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Slow metadata lookups keep retrying for up to 6 hours. Jobs are independent of Seedr downloads.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void refreshBackgroundMetadataJobs(); }}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold"
                      >
                        Refresh
                      </button>
                    </div>

                    <div className="divide-y divide-slate-800">
                      {backgroundMetadataJobs.map((job) => {
                        const active = job.status === 'queued' || job.status === 'resolving';
                        const terminalReady = job.status === 'ready';
                        const elapsedSeconds = Math.max(0, Number(job.elapsedSeconds || 0));
                        const remainingSeconds = Math.max(0, Number(job.remainingSeconds || 0));
                        const elapsedMinutes = Math.floor(elapsedSeconds / 60);
                        const elapsedHours = Math.floor(elapsedMinutes / 60);
                        const elapsedLabel = elapsedHours > 0
                          ? `${elapsedHours}h ${elapsedMinutes % 60}m`
                          : `${elapsedMinutes}m`;
                        const remainingHours = Math.floor(remainingSeconds / 3600);
                        const remainingMinutes = Math.floor((remainingSeconds % 3600) / 60);
                        const remainingLabel = remainingHours > 0
                          ? `${remainingHours}h ${remainingMinutes}m remaining`
                          : `${Math.max(1, remainingMinutes)}m remaining`;
                        const displayName = job.name || (job.hash ? `Torrent ${job.hash.slice(0, 12)}…` : 'Torrent metadata job');

                        return (
                          <div key={job.jobId} className="px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
                            <div className="shrink-0">
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${terminalReady ? 'bg-emerald-500/10 text-emerald-400' : job.status === 'error' ? 'bg-rose-500/10 text-rose-400' : 'bg-cyan-500/10 text-cyan-400'}`}>
                                {terminalReady ? '✓' : job.status === 'error' ? '✗' : <Loader2 className="w-4 h-4 animate-spin" />}
                              </div>
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-slate-100 truncate" title={displayName}>{displayName}</div>
                              <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">{job.hash}</div>
                              <div className="text-[11px] text-slate-400 mt-1">
                                {terminalReady
                                  ? `Completed • ${job.fileCount || 0} files • ${formatBytes(Number(job.totalSize || 0))}`
                                  : job.status === 'error'
                                    ? (job.error || 'Metadata resolution failed.')
                                    : `Resolving • round ${job.rounds || 0} • ${elapsedLabel} elapsed • ${remainingLabel}`}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className={`px-2 py-1 rounded-lg text-[10px] font-semibold ${terminalReady ? 'bg-emerald-500/10 text-emerald-300' : job.status === 'error' ? 'bg-rose-500/10 text-rose-300' : 'bg-cyan-500/10 text-cyan-300'}`}>
                                {terminalReady ? 'Completed' : job.status === 'error' ? 'Failed' : active ? 'Resolving' : job.status}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const magnet = job.hash ? `magnet:?xt=urn:btih:${job.hash}` : '';
                                  openAddMagnet(magnet);
                                  setActiveTab('files');
                                }}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
                              >
                                Open
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

          </div>
        )}

        {/* TAB 3: SHARED STORAGE & MULTI-USER */}
        {activeTab === 'shared' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Users className="w-5 h-5 text-cyan-400" />
                  <span>Shared Team Folders & Access Controls</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Multi-user folder permissions with customizable Viewer, Editor, and Admin roles.
                </p>
              </div>

              <button
                onClick={() => setIsCreateFolderOpen(true)}
                className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
              >
                <FolderPlus className="w-4 h-4" />
                <span>New Shared Folder</span>
              </button>
            </div>

            {/* Folders List */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {folders.filter(f => f.path !== '/').map((folder) => {
                const isOwner = folder.ownerId === activeUser?.id;
                const userPerm = isOwner ? 'admin' : folder.permissions[activeUser?.id || ''] || 'viewer';

                  return (
                  <div
                    key={folder.id}
                    className="p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between gap-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400 shrink-0">
                          <Folder className="w-[18px] h-[18px]" />
                        </div>
                        <div className="truncate">
                          <h4 className="text-sm font-semibold text-slate-100 truncate">{folder.name}</h4>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Created by {folder.ownerName}
                          </p>
                        </div>
                      </div>

                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                          folder.isShared                            ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {folder.isShared ? 'Shared' : 'Private'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800/60">
                      <span>{folder.filesCount || 0} files ({formatBytes(folder.totalSize || 0)})</span>
                      <span className="text-cyan-400 font-medium capitalize">Role: {userPerm}</span>                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => {
                          setCurrentFolder(folder.path);
                          setActiveTab('files');
                        }}
                        className="flex-1 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                      >
                        Open Folder
                      </button>

                      <button
                        onClick={() => setShareFolder(folder)}
                        className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 transition"
                        title="Manage Permissions"
                      >
                        <Share2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 4: ACTIVITY LOG */}
        {activeTab === 'activity' && (
          <ActivityLogView
            logs={activityLogs}
            onClearLogs={async () => {
              await api.clearLogs();
              try { window.localStorage.removeItem(activityStorageKey); } catch {}
              setActivityLogs([]);
            }}
            onRefresh={async () => {
              const logs = await api.getLogs();
              setActivityLogs(logs);
            }}
          />
        )}

        {/* TAB 5: STORAGE & AUTO-CLEANUP */}
        {activeTab === 'storage' && storageStats && cleanupSettings && (
          <div className="space-y-4">
            <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
              {/* Storage Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Used Storage</p>
                <p className="text-xl font-bold font-mono text-cyan-400 mt-1">{formatBytes(storageStats.usedBytes)}</p>
                <p className="text-[11px] text-slate-500 mt-1">{Number(storageStats.usedPercentage || 0).toFixed(2)}% of total server capacity</p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Available Free Space</p>
                <p className="text-xl font-bold font-mono text-emerald-400 mt-1">{formatBytes(storageStats.freeBytes)}</p>
                <p className="text-[11px] text-slate-500 mt-1">Ready for high-bandwidth downloads</p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Total Server Disk</p>
                <p className="text-xl font-bold font-mono text-slate-100 mt-1">{formatBytes(storageStats.totalBytes)}</p>
                
              </div>
            </div>
          </div>
          </div>
        )}
      </main>

      {/* Floating Bottom Media Player (when minimized or active) */}
      <MediaPlayerModal
        file={activeMediaFile}
        onClose={() => {
          setActiveMediaFile(null);
          setSeedrStreamLoadingId(null);
        }}
        onPlaybackStarted={() => {
          // Stage 1 and stage 2 both end only when the browser actually
          // starts playback. A fast stream therefore removes the spinner
          // immediately, while a slow stream keeps it visible.
          setSeedrStreamLoadingId(null);
        }}
        isMinimized={isPlayerMinimized}
        onToggleMinimize={() => setIsPlayerMinimized(!isPlayerMinimized)}
      />

      {/* Mobile More actions sheet */}
      {isMobileMoreOpen && (
        <>
          <button
            type="button"
            aria-label="Close more menu"
            onClick={() => setIsMobileMoreOpen(false)}
            className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
          />
          <div className="md:hidden fixed left-3 right-3 bottom-20 z-50 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setActiveTab('activity'); setIsMobileMoreOpen(false); }}
                className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2"
              >
                <History className="w-4 h-4 text-cyan-400" />
                Activity Log
              </button>

              <button
                type="button"
                onClick={() => { setActiveTab('storage'); setIsMobileMoreOpen(false); }}
                className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4 text-cyan-400" />
                Storage
              </button>

              <button
                type="button"
                onClick={() => {
                  setTheme(theme === 'dark' ? 'dim' : theme === 'dim' ? 'light' : 'dark');
                }}
                className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2"
              >
                {theme === 'light'
                  ? <Sun className="w-4 h-4 text-amber-400" />
                  : <Moon className="w-4 h-4 text-cyan-400" />}
                Theme: {theme}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-slate-950/95 backdrop-blur-xl border-t border-slate-800 px-1 pb-[calc(env(safe-area-inset-bottom)+2px)] pt-1">
        <div className="grid grid-cols-4 items-center">
          <button
            onClick={() => { setActiveTab('search'); setIsMobileMoreOpen(false); }}
            className={`flex flex-col items-center justify-center gap-0.5 min-h-11 px-1 rounded-lg transition ${activeTab === 'search' ? 'text-cyan-400' : 'text-slate-400'}`}
          >
            <Search className="w-[18px] h-[18px]" />
            <span className="text-[9px] font-semibold">Search</span>
          </button>

          <button
            onClick={() => { setActiveTab('files'); setIsMobileMoreOpen(false); }}
            className={`flex flex-col items-center justify-center gap-0.5 min-h-12 px-1 rounded-xl transition ${activeTab === 'files' ? 'text-cyan-400' : 'text-slate-400'}`}
          >
            <Folder className="w-5 h-5" />
            <span className="text-[9px] font-semibold">Files</span>
          </button>

          <button
            onClick={() => setIsMobileMoreOpen(prev => !prev)}
            className={`flex flex-col items-center justify-center gap-0.5 min-h-12 px-1 rounded-xl transition ${isMobileMoreOpen || activeTab === 'activity' || activeTab === 'storage' ? 'text-cyan-400' : 'text-slate-400'}`}
          >
            <Layers className="w-5 h-5" />
            <span className="text-[9px] font-semibold">More</span>
          </button>
        </div>
      </nav>

      {/* Modals */}
      <AddMagnetModal
        isOpen={isAddMagnetOpen}
        onClose={() => {
          setIsAddMagnetOpen(false);
          setInitialMagnet('');
          setInitialSourceUrl('');
          setInitialDescriptorUrl('');
        }}
        onOpen={() => {
          openAddMagnet(initialMagnet);
        }}
        onAdd={handleAddMagnet}
        onBackgroundChange={(state) => {
          setBackgroundMetadataJob(state);
          if (state.active) {
            setActiveTab('files');
            setIsAddMagnetOpen(false);
          }
        }}
        defaultFolder={currentFolder === '/' ? 'Downloads' : currentFolder.replace('/', '')}
        initialMagnet={initialMagnet}
        initialSourceUrl={initialSourceUrl}
        initialDescriptorUrl={initialDescriptorUrl}
      />

      <FilePrioModal
        torrent={prioTorrent}
        onClose={() => setPrioTorrent(null)}
        onUpdatePriority={handleUpdateFilePriority}
      />

      <StorageCleanupModal
        isOpen={isCleanupOpen}
        onClose={() => setIsCleanupOpen(false)}
        stats={storageStats}
        settings={cleanupSettings}
        onUpdateSettings={async (settings) => {
          const updated = await api.updateCleanupSettings(settings);
          setCleanupSettings(updated);
        }}
        onRunCleanup={handleRunCleanup}
      />

      <FolderShareModal
        folder={shareFolder}
        users={users}
        onClose={() => setShareFolder(null)}
        onSave={handleFolderShareSave}
      />

      <NotificationCenter
        notifications={notifications}
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
        onMarkRead={async () => {
          await api.markNotificationsRead();
          setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        }}
        onTestPush={async () => {
          await api.testNotification();
          dispatchBrowserNotification('Torrent Studio Push Notification Test', 'Push alert successfully triggered! Everything is running smoothly.');
          const notifs = await api.getNotifications();
          setNotifications(notifs);
        }}      />

      <CreateFolderModal
        isOpen={isCreateFolderOpen}
        onClose={() => setIsCreateFolderOpen(false)}
        onCreate={handleCreateFolder}
        currentPath={currentFolder}
      />

      <MoveFileModal
        file={moveFile}
        folders={folders}        onClose={() => setMoveFile(null)}
        onMove={handleMoveFile}
      />

      <RenameModal
        item={renameItem}
        onClose={() => setRenameItem(null)}
        onRename={handleRename}
      />

      {deleteTarget && (
        <ConfirmDeleteModal
          isOpen={Boolean(deleteTarget)}
          title={deleteTarget.type === 'file' ? 'Delete File' : 'Remove Torrent Task'}
          itemName={deleteTarget.name}
          itemDetails={deleteTarget.details}
          itemType={deleteTarget.type}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}