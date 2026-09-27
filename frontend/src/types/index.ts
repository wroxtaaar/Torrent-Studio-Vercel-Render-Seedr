export type TorrentState =
  | 'downloading'
  | 'stalledDL'
  | 'uploading'
  | 'pausedDL'
  | 'completed'
  | 'error'
  | 'checkingDL';

export interface TorrentFileItem {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number; // 0 = do not download, 1 = normal, 6 = high, 7 = max
  is_seed?: boolean;
  path: string;
}

export interface TorrentItem {
  hash: string;
  name: string;
  size: number;
  progress: number; // 0 to 1
  dlspeed: number; // bytes/sec
  upspeed: number; // bytes/sec
  priority: number;
  num_seeds: number;
  num_leechs: number;
  ratio: number;
  eta: number; // seconds (-1 if unknown)
  state: TorrentState;
  category: string;
  added_on: number;
  completion_on: number;
  total_size: number;
  selected_size?: number;
  files: TorrentFileItem[];
  magnetUri?: string;
  save_path?: string;
  content_path?: string;
}

export type FileCategory = 'video' | 'audio' | 'image' | 'archive' | 'document' | 'other';

export interface StorageFile {
  id: string;
  name: string;
  path: string;
  folder: string;
  size: number;
  type: FileCategory;
  mimeType: string;
  createdAt: number;
  torrentHash?: string;
  isStreamable: boolean;
  ownerId: string;
  ownerName: string;
  downloadUrl: string;
  streamUrl: string;
  duration?: number;
}

export type UserPermission = 'viewer' | 'editor' | 'admin';

export interface StorageFolder {
  id: string;
  name: string;
  path: string;
  ownerId: string;
  ownerName: string;
  isShared: boolean;
  permissions: Record<string, UserPermission>; // userId -> permission
  createdAt: number;
  filesCount?: number;
  totalSize?: number;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  avatar: string;
}

export interface StorageStats {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercentage: number;
  filesCount: number;
  torrentsCount: number;
  isUnlimited: boolean;
  serverCapacityLabel: string;
  alertLevel: 'normal' | 'warning' | 'critical'; // >80% warning, >90% critical
}

export interface ActivityLog {
  id: string;
  timestamp: number;
  type: 'download' | 'stream' | 'cleanup' | 'share' | 'delete' | 'system' | 'torrent';
  userName: string;
  userId: string;
  action: string;
  details: string;
  status: 'success' | 'warning' | 'info' | 'error';
}

export interface AppNotification {
  id: string;
  timestamp: number;
  title: string;
  message: string;
  type: 'transfer_complete' | 'storage_warning' | 'cleanup' | 'system';
  read: boolean;
  link?: string;
}

export interface QbtSettings {
  isExternal: boolean;
  host: string;
  username: string;
  connected: boolean;
  version: string;
}

export interface CleanupSettings {
  autoCleanCompletedDays: number;
  autoPurgeOrphans: boolean;
  autoCleanTempFiles: boolean;
  storageThresholdPercent: number;
  lastCleanedAt?: number;
}
