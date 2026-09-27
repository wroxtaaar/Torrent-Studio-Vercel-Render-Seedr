export interface TorrentSearchResult {
  guid?: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer?: string;
  protocol?: string;
  publishDate?: string;
  infoHash?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  infoUrl?: string;
  sourceUrl?: string;
}

import {
  TorrentItem,
  TorrentFileItem,
  StorageFile,
  StorageFolder,
  UserProfile,
  StorageStats,
  ActivityLog,
  AppNotification,
  CleanupSettings,
  QbtSettings
} from '../types/index.ts';

const API_BASE = String(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const value = String(input);
  return fetch(value.startsWith('/') ? API_BASE + value : value, init);
};

export const api = {
  // Torrents (qBittorrent WebAPI)
  async searchTorrents(query: string, limit = 50): Promise<TorrentSearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.min(Math.max(limit, 1), 50))
    });

    const res = await apiFetch('/api/search?' + params.toString());
    const body = await res.text();

    let data: any = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      // Keep raw response for the error below.
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || body || ('Torrent search failed (HTTP ' + res.status + ')'));
    }

    return Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []);
  },

  async addSearchTorrent(source: string, size: number, infoHash?: string): Promise<any> {
    const magnet = source.trim();
    const resolvedMagnet =
      magnet.toLowerCase().startsWith('magnet:?')
        ? magnet
        : infoHash
          ? 'magnet:?xt=urn:btih:' + infoHash.trim()
          : magnet;

    const res = await apiFetch('/api/search/torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: resolvedMagnet, size, infoHash })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || body || 'Failed to add search result');
    return data;
  },

  async getTorrents(filter?: string): Promise<TorrentItem[]> {
    const url = filter ? `/api/v2/torrents/info?filter=${filter}` : '/api/v2/torrents/info';
    const res = await apiFetch(url);
    if (!res.ok) throw new Error('Failed to fetch torrents');
    return res.json();
  },

  async getTorrentFiles(hash: string): Promise<TorrentFileItem[]> {
    const res = await apiFetch(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`);
    if (!res.ok) throw new Error('Failed to fetch files');
    return res.json();
  },

  async exportTorrent(hash: string): Promise<Blob> {
    const res = await apiFetch(`/api/v2/torrents/export?hash=${encodeURIComponent(hash)}`);
    if (!res.ok) {
      const message = await res.text().catch(() => '');
      throw new Error(message || 'Failed to export torrent file');
    }
    return res.blob();
  },

  async setFilePriority(hash: string, fileIds: string, priority: number): Promise<void> {
    const res = await apiFetch('/api/v2/torrents/filePrio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, id: fileIds, priority })
    });
    if (!res.ok) throw new Error('Failed to set file priority');
  },

  async inspectMagnet(magnet: string, category = 'Downloads'): Promise<{
    name: string;
    hash: string;
    files: { index: number; name: string; size: number; path: string; type: string; priority?: number }[];
    totalSize: number;
    source: string;
    pending?: boolean;
    createdPreview?: boolean;
    message?: string;
  }> {
    const res = await apiFetch('/api/v2/torrents/inspect-magnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet, category })
    });
    const body = await res.text();
    let data: any = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      // Keep the raw qBittorrent response below.
    }

    if (!res.ok && res.status !== 202) {
      const message =
        data?.error ||
        data?.message ||
        body ||
        `qBittorrent metadata inspection failed (HTTP ${res.status})`;
      throw new Error(message);
    }

    return data || {
      name: 'Torrent',
      hash: '',
      files: [],
      totalSize: 0,
      source: 'qbt_metadata_pending',
      message: `qBittorrent is still resolving the torrent metadata (HTTP ${res.status}).`
    };
  },

  async uploadTorrentFile(file: File): Promise<{
    name: string;
    hash: string;
    files: { index: number; name: string; size: number; path: string; type: string }[];
    totalSize: number;
    magnetUri: string;
  }> {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const res = await apiFetch('/api/v2/torrents/upload-torrent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, filename: file.name })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to parse torrent file' }));
      throw new Error(err.error || 'Failed to parse torrent file');
    }
    return res.json();
  },

  async prepareSeedrMagnet(magnet: string): Promise<{
    taskId: number | string;
    name: string;
    files: Array<{ id: string; name: string; size: number }>;
    created?: boolean;
    paused?: boolean;
  }> {
    const res = await apiFetch('/api/seedr/tasks/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || body || 'Failed to prepare Seedr task');
    return data;
  },

  async addMagnet(
    urls: string,
    category = 'Downloads',
    selectedFiles?: number[],
    manifest?: { name: string; size: number; priority: number }[],
    existingHash?: string,
    forceBackend?: 'seedr' | 'qbittorrent',
    selectedNames?: string[],
    seedrTaskId?: number | string,
    torrentName?: string
  ): Promise<any> {
    const magnet = urls.trim();
    if (!magnet.toLowerCase().startsWith('magnet:?')) {
      throw new Error('A valid magnet URL is required');
    }

    const size = (manifest || []).reduce((sum, file) => sum + Number(file.size || 0), 0) || undefined;
    const res = await apiFetch(API_BASE + '/api/seedr/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet, size, folder_id: undefined })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || body || `Seedr add failed (HTTP ${res.status})`);
      if (res.status === 413) (error as any).code = 'SEEDR_INSUFFICIENT_SPACE';
      throw error;
    }

    let taskId = data?.task_id ?? data?.id ?? data?.task?.id ?? data?.task?.task_id ?? null;
    if (taskId == null) {
      try {
        const taskRes = await apiFetch('/api/seedr/tasks');
        const taskBody = await taskRes.json().catch(() => null);
        const tasks = Array.isArray(taskBody) ? taskBody : (Array.isArray(taskBody?.tasks) ? taskBody.tasks : []);
        const latest = tasks[0];
        taskId = latest?.id ?? latest?.task_id ?? latest?.taskId ?? null;
      } catch {}
    }
    return {
      backend: 'seedr',
      seedrTaskId: taskId,
      seedrResponse: data,
      seedrFolderName: torrentName || data?.name || data?.task?.name || null,
      seedrFolderId: data?.folder_id ?? data?.task?.folder_id ?? null,
      selectionApplied: false
    };
  },


  async getSeedrQuota(): Promise<{
    configured: boolean;
    maxSpace: number;
    usedSpace: number;
    remainingSpace: number;
  }> {
    const res = await apiFetch('/api/seedr/quota');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to fetch Seedr quota');
    return {
      configured: Boolean(data?.configured),
      maxSpace: Number(data?.maxSpace || 0),
      usedSpace: Number(data?.usedSpace || 0),
      remainingSpace: Number(data?.remainingSpace || 0),
    };
  },

  async getSeedrLibrary(): Promise<{
    configured: boolean;
    root: {
      id: string;
      folderId: string;
      name: string;
      path: string;
      filesCount: number;
      totalSize: number;
      folderCount: number;
    } | null;
    folders: Array<{
      id: string;
      folderId: string;
      name: string;
      path: string;
      filesCount: number;
      totalSize: number;
      folderCount: number;
    }>;
  }> {
    const res = await apiFetch('/api/seedr/library');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to fetch Seedr library metadata');
    return {
      configured: Boolean(data?.configured),
      root: data?.root || null,
      folders: Array.isArray(data?.folders) ? data.folders : [],
    };
  },

  async getSeedrFolderContents(folderId: string): Promise<{
    configured: boolean;
    folderId: string;
    files: Array<{ id: string; streamId?: string; name: string; size: number; folderId: string; url?: string | null }>;
    folders: Array<{ id: string; folderId: string; name: string }>;
  }> {
    const res = await apiFetch('/api/seedr/folders/' + encodeURIComponent(folderId) + '/contents');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to load Seedr folder contents');
    return {
      configured: Boolean(data?.configured),
      folderId: String(data?.folderId || folderId),
      files: Array.isArray(data?.files) ? data.files : [],
      folders: Array.isArray(data?.folders) ? data.folders : [],
    };
  },

  async getSeedrFiles(): Promise<{
    configured: boolean;
    files: Array<{ id: string; name: string; size: number; folderId: string; folderPath: string }>;
  }> {
    const res = await apiFetch('/api/seedr/files');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to fetch Seedr files');
    return {
      configured: Boolean(data?.configured),
      files: Array.isArray(data?.files) ? data.files : [],
    };
  },

  async getSeedrFileDownload(fileId: string): Promise<{ url: string; name: string }> {
    const res = await apiFetch('/api/seedr/files/' + encodeURIComponent(fileId) + '/download');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to create Seedr download link');
    return data;
  },

  async getSeedrFileStream(fileId: string, fileName: string, type: 'video' | 'audio'): Promise<{ url: string; externalUrl?: string; name: string }> {
    const params = new URLSearchParams({
      type,
      file_id: fileId,
      name: fileName
    });
    const res = await apiFetch('/api/seedr/files/stream?' + params.toString());
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to create Seedr stream URL');
    return data;
  },

  async getSeedrFolderDownload(folderId: string): Promise<{ url: string }> {
    const res = await apiFetch('/api/seedr/folders/' + encodeURIComponent(folderId) + '/download');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to create Seedr folder download');
    return data;
  },

  async deleteSeedrFolder(folderId: string): Promise<void> {
    const res = await apiFetch('/api/seedr/folders/' + encodeURIComponent(folderId), { method: 'DELETE' });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to delete Seedr folder');
  },

  async deleteSeedrTask(taskId: number | string): Promise<void> {
    const res = await apiFetch('/api/seedr/tasks/' + encodeURIComponent(String(taskId)), { method: 'DELETE' });
    const body = await res.text();
    if (!res.ok) {
      let data: any = null;
      try { data = body ? JSON.parse(body) : null; } catch {}
      throw new Error(data?.error || body || 'Failed to delete Seedr task');
    }
  },

  async deleteSeedrFile(fileId: string): Promise<void> {
    const res = await apiFetch('/api/seedr/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to delete Seedr file');
  },

  async getSeedrTask(taskId: number | string): Promise<{
    taskId: number | string;
    name?: string;
    folderName?: string;
    folderId?: string;
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
  }> {
    const res = await apiFetch('/api/seedr/tasks/' + encodeURIComponent(String(taskId)));
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to check Seedr task');
    return data;
  },
  async pauseTorrent(hash: string): Promise<void> {
    const res = await apiFetch('/api/v2/torrents/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: hash })
    });
    if (!res.ok) throw new Error('Failed to pause torrent');
  },

  async resumeTorrent(hash: string): Promise<void> {
    const res = await apiFetch('/api/v2/torrents/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: hash })
    });
    if (!res.ok) throw new Error('Failed to resume torrent');
  },

  async deleteTorrent(hash: string, deleteFiles = false): Promise<void> {
    const res = await apiFetch('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: hash, deleteFiles })
    });
    if (!res.ok) throw new Error('Failed to delete torrent');
  },

  // Storage Files
  async getFiles(folder = '/', search = '', type = 'all', folderId = ''): Promise<StorageFile[]> {
    const params = new URLSearchParams({ folder, search, type });
    if (folderId) params.set('folder_id', folderId);
    const res = await apiFetch(`/api/files?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to fetch files');
    return res.json();
  },

  async deleteFile(id: string): Promise<{ success: boolean; cleanup: any }> {
    const res = await apiFetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error('Failed to delete file');
    return res.json();
  },

  async renameItem(id: string, newName: string, isFolder: boolean) {
    const res = await apiFetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, newName, isFolder })
    });
    if (!res.ok) throw new Error('Failed to rename item');
    return res.json();
  },

  async moveFile(fileId: string, targetFolder: string) {
    const res = await apiFetch('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, targetFolder })
    });
    if (!res.ok) throw new Error('Failed to move file');
    return res.json();
  },

  async createFolder(name: string, parentPath = '/', isShared = false): Promise<StorageFolder> {
    const res = await apiFetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentPath, isShared })
    });
    if (!res.ok) throw new Error('Failed to create folder');
    return res.json();
  },

  async getFolders(): Promise<StorageFolder[]> {
    const res = await apiFetch('/api/folders');
    if (!res.ok) throw new Error('Failed to fetch folders');
    return res.json();
  },

  async updateFolderShare(folderId: string, isShared: boolean, permissions: Record<string, string>) {
    const res = await apiFetch('/api/folders/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, isShared, permissions })
    });
    if (!res.ok) throw new Error('Failed to update share permissions');
    return res.json();
  },

  // Users
  async getUsers(): Promise<{ users: UserProfile[]; activeUserId: string; activeUser: UserProfile }> {
    const res = await apiFetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json();
  },

  async switchUser(userId: string): Promise<{ activeUser: UserProfile }> {
    const res = await apiFetch('/api/users/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    if (!res.ok) throw new Error('Failed to switch user');
    return res.json();
  },

  async createUser(name: string, email: string, role: string): Promise<UserProfile> {
    const res = await apiFetch('/api/users/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role })
    });
    if (!res.ok) throw new Error('Failed to create user');
    return res.json();
  },

  // Storage & Cleanup
  async getStorageStats(): Promise<StorageStats> {
    const res = await apiFetch('/api/storage/stats');
    if (!res.ok) throw new Error('Failed to fetch storage stats');
    return res.json();
  },

  async getCleanupSettings(): Promise<CleanupSettings> {
    const res = await apiFetch('/api/cleanup/settings');
    if (!res.ok) throw new Error('Failed to fetch cleanup settings');
    return res.json();
  },

  async updateCleanupSettings(settings: Partial<CleanupSettings>): Promise<CleanupSettings> {
    const res = await apiFetch('/api/cleanup/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update cleanup settings');
    return res.json();
  },

  async runCleanup(): Promise<{ bytesFreed: number; filesRemoved: number; tempRemoved: number; orphansRemoved: number }> {
    const res = await apiFetch('/api/cleanup/run', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run cleanup');
    return res.json();
  },

  // Logs & Notifications
  async getLogs(): Promise<ActivityLog[]> {
    const res = await apiFetch('/api/logs');
    if (!res.ok) throw new Error('Failed to fetch logs');
    return res.json();
  },

  async clearLogs(): Promise<void> {
    await apiFetch('/api/logs/clear', { method: 'POST' });
  },

  async getNotifications(): Promise<AppNotification[]> {
    const res = await apiFetch('/api/notifications');
    if (!res.ok) throw new Error('Failed to fetch notifications');
    return res.json();
  },

  async markNotificationsRead(): Promise<void> {
    await apiFetch('/api/notifications/read', { method: 'POST' });
  },

  async testNotification(): Promise<void> {
    await apiFetch('/api/notifications/test', { method: 'POST' });
  },

  // qBittorrent Configuration
  async getQbtSettings(): Promise<QbtSettings> {
    const res = await apiFetch('/api/qbt/settings');
    if (!res.ok) throw new Error('Failed to fetch qbt settings');
    return res.json();
  },

  async updateQbtSettings(settings: Partial<QbtSettings>): Promise<QbtSettings> {
    const res = await apiFetch('/api/qbt/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update qbt settings');
    return res.json();
  }
};
