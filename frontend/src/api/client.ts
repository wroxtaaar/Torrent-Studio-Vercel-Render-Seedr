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
  descriptorUrl?: string;
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

// The frontend and API are served by the same Render service in the
// all-in-one deployment. Keep an optional VITE_API_URL override for local
// development or an external API, but default to the current browser origin.
// Prefer an explicit API URL when one is configured. If the frontend is
// served from the all-in-one Render service, same-origin is correct. If the
// frontend is hosted separately (for example an older Vercel deployment),
// never accidentally point API/media requests at the static frontend host.
const configuredApiBase = String(import.meta.env.VITE_API_URL || '').trim();
const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
const isRenderFullStackHost = currentHost.endsWith('.onrender.com');
const API_BASE = (
  configuredApiBase ||
  (isRenderFullStackHost
    ? window.location.origin
    : 'https://torrent-studio-vercel-render-seedr-26fd.onrender.com')
).replace(/\/+$/, '');
const makeSeedrError = (data: any, body: string, status: number, fallback: string) => {
  const error = new Error(
    data?.error ||
    data?.message ||
    data?.detail ||
    body ||
    fallback
  ) as Error & { code?: string; status?: number };
  error.code = typeof data?.code === 'string' ? data.code : undefined;
  error.status = status;
  return error;
};

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

    // Search is served by the Render backend alongside the Seedr API.
    // Use the same API base in development and production so the frontend
    // can be hosted independently as a Render Static Site.
    const searchBase = API_BASE;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 4000);
    let res: Response;
    try {
      res = await fetch(searchBase + '/api/search?' + params.toString(), {
        signal: controller.signal
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('Search timed out. Please try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
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

  async addSearchTorrent(source: string, size: number, infoHash?: string, torrentName?: string): Promise<any> {
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
      body: JSON.stringify({ source: resolvedMagnet, size, infoHash, torrent_name: torrentName || undefined })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || body || 'Failed to add search result');
    return data;
  },

  async searchSubtitles(query: string, language = 'en'): Promise<Array<{
    fileId: string;
    language: string;
    release: string;
    downloads: number;
    format: string;
    hearingImpaired: boolean;
  }>> {
    const params = new URLSearchParams({ query, languages: language });
    const res = await apiFetch('/api/subtitles/search?' + params.toString());
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || body || 'Subtitle search failed');
    return Array.isArray(data?.results) ? data.results : [];
  },

  async downloadSubtitle(fileId: string): Promise<{
    url: string;
    language: string;
    title: string;
    format: string;
  }> {
    const res = await apiFetch('/api/subtitles/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || body || 'Subtitle download failed');
    return { ...data, url: data?.url?.startsWith('/') ? API_BASE + data.url : data.url };
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

  async inspectMagnet(magnet: string, category = 'Downloads', sourceUrl = '', descriptorUrl = ''): Promise<{
    name: string;
    hash: string;
    files: { index: number; name: string; size: number; path: string; type: string; priority?: number }[];
    totalSize: number;
    source: string;
    pending?: boolean;
    createdPreview?: boolean;
    message?: string;
    jobId?: string;
  }> {
    const request = async () => {
      const res = await apiFetch('/api/v2/torrents/inspect-magnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet,
          category,
          sourceUrl: sourceUrl || undefined,
          descriptorUrl: descriptorUrl || undefined
        })
      });
      const body = await res.text();
      let data: any = null;
      try { data = body ? JSON.parse(body) : null; } catch {}
      return { res, data, body };
    };

    const first = await request();
    if (first.res.ok && first.res.status !== 202 && Array.isArray(first.data?.files)) {
      return first.data;
    }

    if (first.res.status !== 202) {
      throw new Error(
        first.data?.error ||
        first.data?.message ||
        first.body ||
        `Torrent metadata inspection failed (HTTP ${first.res.status})`
      );
    }

    const jobId = String(first.data?.jobId || '').trim();
    if (!jobId) {
      throw new Error(first.data?.message || 'Torrent metadata is still resolving.');
    }

    // Keep the UI responsive while the backend resolver stays alive and
    // benefits from its warm libtorrent session/cache.
    // Do not keep the modal blocked for a full minute. Return a pending
    // result after a short foreground wait so the UI can move the resolver
    // into My Cloud Files and the user can continue working.
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const res = await apiFetch(
        '/api/v2/torrents/inspect-magnet/status?jobId=' + encodeURIComponent(jobId)
      );
      const body = await res.text();
      let data: any = null;
      try { data = body ? JSON.parse(body) : null; } catch {}

      if (res.ok && Array.isArray(data?.files) && data.files.length > 0) {
        return data;
      }

      if (!res.ok) {
        throw new Error(
          data?.error ||
          data?.message ||
          body ||
          `Torrent metadata inspection failed (HTTP ${res.status})`
        );
      }
    }

    return {
      name: '',
      hash: jobId,
      files: [],
      totalSize: 0,
      source: 'libtorrent_metadata',
      pending: true,
      jobId,
      message: 'Torrent metadata is still resolving in the background. Seedr has not been started.'
    };
  },

  async getTorrentMetadataJobs(): Promise<{
    jobs: Array<{
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
    }>;
    backgroundTtlSeconds: number;
    retentionSeconds: number;
  }> {
    const res = await apiFetch('/api/v2/torrents/metadata-jobs');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      throw new Error(data?.error || data?.message || body || 'Torrent metadata jobs request failed');
    }
    return {
      jobs: Array.isArray(data?.jobs) ? data.jobs : [],
      backgroundTtlSeconds: Number(data?.backgroundTtlSeconds || 0),
      retentionSeconds: Number(data?.retentionSeconds || 0),
    };
  },

  async getTorrentMetadataStatus(jobId: string): Promise<any> {
    const res = await apiFetch(
      '/api/v2/torrents/inspect-magnet/status?jobId=' + encodeURIComponent(jobId)
    );
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      throw new Error(data?.error || data?.message || body || 'Torrent metadata status failed');
    }
    return data;
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

  async inspectSeedrSelection(magnet: string, torrentName?: string): Promise<{
    taskId: number | string;
    created: boolean;
    torrentName: string;
    folderId: string | null;
    unwanted: unknown;
    writeTested: false;
  }> {
    const res = await apiFetch('/api/seedr/tasks/inspect-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet, torrent_name: torrentName || undefined })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      throw new Error(data?.error || body || 'Seedr selective-download probe failed');
    }
    return data;
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

  async addSelectedSeedrFiles(
    magnet: string,
    files: Array<{ index: number; name: string; size: number }>,
    selectedIndexes: number[],
    torrentName?: string
  ): Promise<any> {
    const res = await apiFetch('/api/seedr/tasks/add-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet, files, selectedIndexes, torrentName: torrentName || undefined })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || data?.detail || body || `Seedr selected-file add failed (HTTP ${res.status})`);
      if (res.status === 413) (error as any).code = 'SEEDR_INSUFFICIENT_SPACE';
      throw error;
    }
    return data;
  },

  async addMagnet(
    urls: string,
    category = 'Downloads',
    selectedFiles?: number[],
    manifest?: { index?: number; name: string; size: number; priority: number }[],
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

    // For the file-selector flow, always use the experimental selected-file
    // endpoint so the exact indexes chosen in the UI are sent to Seedr. The
    // previous /api/seedr/add call ignored selectedFiles and therefore started
    // a full torrent, defeating the purpose of selective transfer.
    if (forceBackend === 'seedr' && selectedFiles && selectedFiles.length > 0 && manifest && manifest.length > 0) {
      const files = manifest.map((file, index) => ({
        index: Number.isInteger(Number(file.index)) ? Number(file.index) : index,
        name: file.name,
        size: Number(file.size || 0)
      }));
      const selected = selectedFiles.map(Number).filter(Number.isInteger);
      const data = await api.addSelectedSeedrFiles(
        magnet,
        files,
        selected,
        torrentName || undefined
      );
      return {
        backend: 'seedr',
        seedrTaskId: data?.taskId ?? null,
        seedrResponse: data,
        seedrFolderName: torrentName || data?.torrentName || null,
        seedrFolderId: data?.folderId ?? null,
        selectionApplied: Boolean(data?.writeAccepted),
        selectionError: data?.writeError || null
      };
    }

    const size = (manifest || []).reduce((sum, file) => sum + Number(file.size || 0), 0) || undefined;
    const res = await apiFetch(API_BASE + '/api/seedr/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet,
        size,
        folder_id: undefined,
        torrent_name: torrentName || undefined
      })
    });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || data?.detail || body || `Seedr add failed (HTTP ${res.status})`);
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


  async getSeedrTokenDiagnostic(): Promise<any> {
    const res = await apiFetch('/api/seedr/token-diagnostic');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to diagnose Seedr token');
    return data;
  },

  async getSeedrAuthStatus(): Promise<{
    configured: boolean;
    authenticated: boolean;
    code: string;
    message?: string;
  }> {
    const res = await apiFetch('/api/seedr/auth-status');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to check Seedr authentication');
    return {
      configured: Boolean(data?.configured),
      authenticated: Boolean(data?.authenticated),
      code: String(data?.code || ''),
      message: typeof data?.message === 'string' ? data.message : undefined,
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
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to fetch Seedr quota');
    return {
      configured: Boolean(data?.configured),
      maxSpace: Number(data?.maxSpace || 0),
      usedSpace: Number(data?.usedSpace || 0),
      remainingSpace: Number(data?.remainingSpace || 0),
    };
  },

  async getSeedrLibrary(fresh = false): Promise<{
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
      torrentName?: string;
      path: string;
      filesCount: number;
      totalSize: number;
      folderCount: number;
    }>;
  }> {
    const res = await apiFetch('/api/seedr/library' + (fresh ? '?fresh=1' : ''));
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to fetch Seedr library metadata');
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
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to load Seedr folder contents');
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
    if (!res.ok) throw makeSeedrError(data, body, res.status, 'Failed to fetch Seedr files');
    return {
      configured: Boolean(data?.configured),
      files: Array.isArray(data?.files) ? data.files : [],
    };
  },

  openSeedrFileDownload(fileId: string, filename = ''): void {
    const query = filename ? '?filename=' + encodeURIComponent(filename) : '';
    const url = '/api/seedr/files/' + encodeURIComponent(fileId) + '/download' + query;
    window.open(API_BASE + url, '_blank', 'noopener,noreferrer');
  },

  async getSeedrFileDownload(fileId: string): Promise<{ url: string; name: string }> {
    const res = await apiFetch('/api/seedr/files/' + encodeURIComponent(fileId) + '/download/url');
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
    const streamUrl = typeof data?.url === 'string' && data.url.startsWith('/')
      ? API_BASE + data.url
      : data?.url;
    return {
      ...data,
      url: streamUrl,
      externalUrl: data?.externalUrl
    };
  },

  openSeedrFolderDownload(folderId: string, filename = ''): void {
    const query = filename ? '?filename=' + encodeURIComponent(filename) : '';
    const url = '/api/seedr/folders/' + encodeURIComponent(folderId) + '/download' + query;
    window.open(API_BASE + url, '_blank', 'noopener,noreferrer');
  },

  async getSeedrFolderDownload(folderId: string): Promise<{ url: string }> {
    const res = await apiFetch('/api/seedr/folders/' + encodeURIComponent(folderId) + '/download/url');
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

  async getSeedrTaskProgress(taskId: number | string): Promise<{
    taskId: number | string;
    name?: string;
    folderId?: string;
    status: 'waiting' | 'downloading' | 'completed' | 'not_found';
    progress: number;
  }> {
    const res = await apiFetch('/api/seedr/tasks/' + encodeURIComponent(String(taskId)) + '/progress');
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || body || 'Failed to check Seedr task progress');
    return {
      taskId: data?.taskId ?? taskId,
      name: typeof data?.name === 'string' ? data.name : '',
      folderId: typeof data?.folderId === 'string' ? data.folderId : '',
      status: data?.status || 'downloading',
      progress: Math.max(0, Math.min(100, Number(data?.progress) || 0)),
    };
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