import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  ExternalLink,
  Download,
  Copy,
  Check,
  Captions,
  Languages,
  Music,
  Video,
  X,
  Minimize2,
  Maximize2,
  Search,
  Loader2,
  Gauge
} from 'lucide-react';
import Hls from 'hls.js';
import { StorageFile } from '../types/index.ts';
import { formatBytes, formatDuration } from '../utils/formatters.ts';

interface MediaPlayerModalProps {
  file: StorageFile | null;
  onClose: () => void;
  onPlaybackStarted?: () => void;
  isMinimized: boolean;
  onToggleMinimize: () => void;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  file,
  onClose,
  onPlaybackStarted,
  isMinimized,
  onToggleMinimize
}) => {
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [isSeeking, setIsSeeking] = useState(false);
  const [audioTracks, setAudioTracks] = useState<Array<{
    index: number; language: string; title: string; codec: string; channels: number; default: boolean;
  }>>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<Array<{
    index: number; language: string; title: string; codec: string; url: string;
  }>>([]);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | undefined>(undefined);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | undefined>(undefined);
  const [trackNotice, setTrackNotice] = useState('');
  const [subtitleSearchOpen, setSubtitleSearchOpen] = useState(false);
  const [subtitleSearchLanguage, setSubtitleSearchLanguage] = useState('en');
  const [subtitleSearchQuery, setSubtitleSearchQuery] = useState('');
  const [subtitleSearchResults, setSubtitleSearchResults] = useState<Array<{
    fileId: string; language: string; release: string; downloads: number; format: string; hearingImpaired: boolean;
  }>>([]);
  const [subtitleSearchLoading, setSubtitleSearchLoading] = useState(false);
  const [subtitleDownloadId, setSubtitleDownloadId] = useState<string | null>(null);
  const [subtitleSearchError, setSubtitleSearchError] = useState('');
  const [showDownloadSpeed, setShowDownloadSpeed] = useState(() => {
    try {
      const saved = localStorage.getItem('torrentStudio.showDownloadSpeed');
      return saved !== 'false';
    } catch {
      return true;
    }
  });
  const [downloadSpeedBytes, setDownloadSpeedBytes] = useState(0);


  const resumeTimeRef = useRef(0);
  const resumePlayingRef = useRef(false);
  const subtitleTrackRef = useRef<HTMLTrackElement>(null);
  const [usingDirectFallback, setUsingDirectFallback] = useState(false);
  const hlsActiveRef = useRef(false);
  const observedDownloadBytesRef = useRef(0);
  const observedResourceNamesRef = useRef(new Set<string>());
  const downloadSpeedTimerRef = useRef<number | null>(null);


  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isVideo = file?.type === 'video';
  const mediaRef = isVideo ? videoRef : audioRef;

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(true);
    setMediaError('');
    setIsSeeking(false);
    setUsingDirectFallback(false);
    hlsActiveRef.current = false;
    const initialSubtitles = file?.subtitleTracks || [];
    setSubtitleTracks(initialSubtitles);
    setSelectedSubtitleIndex(initialSubtitles[0]?.index);
  }, [file?.id]);

  useEffect(() => {
    if (!file) return;

    // Resource Timing is not reliable for long-lived media responses:
    // browsers can keep transferSize at 0 until a response completes. The
    // backend therefore reports bytes it is actively proxying and we poll
    // that tiny stats endpoint once per second.
    const source = file.streamUrl || file.externalStreamUrl || '';
    const match = source.match(/\/api\/seedr\/(?:media\/video|hls)\/([^/?#]+)/i);
    if (!match) {
      setDownloadSpeedBytes(0);
      return;
    }

    const fileId = match[1];
    let statsUrl = `/api/seedr/media/video/${encodeURIComponent(fileId)}/stats`;
    try {
      const parsed = new URL(source, window.location.origin);
      parsed.pathname = `/api/seedr/media/video/${encodeURIComponent(fileId)}/stats`;
      parsed.search = '';
      statsUrl = parsed.toString();
    } catch {}

    let cancelled = false;
    const updateSpeed = async () => {
      try {
        const response = await fetch(statsUrl, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          const speed = Number(data?.bytesPerSecond);
          setDownloadSpeedBytes(Number.isFinite(speed) ? Math.max(0, speed) : 0);
        }
      } catch {
        // Keep the last displayed value during a transient stats request.
      }
    };

    setDownloadSpeedBytes(0);
    updateSpeed();
    downloadSpeedTimerRef.current = window.setInterval(updateSpeed, 1000);

    return () => {
      cancelled = true;
      if (downloadSpeedTimerRef.current !== null) {
        window.clearInterval(downloadSpeedTimerRef.current);
        downloadSpeedTimerRef.current = null;
      }
      setDownloadSpeedBytes(0);
    };
  }, [file?.id, file?.streamUrl, file?.externalStreamUrl]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !file) return;

    setMediaError('');
    setTrackNotice('Preparing browser stream…');

    const directBaseUrl = file.streamUrl.includes('/api/torrents/stream/')
      ? file.streamUrl.replace('/api/torrents/stream/', '/api/torrents/direct-stream/')
      : file.streamUrl;

    // Seedr supplies the exact HLS URL that external players use (e.g. MX
    // Player). Try that URL first in Hls.js; if browser CORS blocks it, fall
    // back automatically to our Render same-origin proxy.
    // Browser playback must use the backend URL. The backend decides whether the
    // Seedr presentation is HLS or a direct video stream and provides the proper
    // same-origin endpoint. Keep externalStreamUrl only for VLC/MX Player.
    const preferredSeedrUrl = file.streamUrl || file.externalStreamUrl || directBaseUrl;
    const streamUrl = selectedAudioIndex !== undefined
      ? `${preferredSeedrUrl}${preferredSeedrUrl.includes('?') ? '&' : '?'}audio=${encodeURIComponent(String(selectedAudioIndex))}`
      : preferredSeedrUrl;
    const fallbackStreamUrl = file.externalStreamUrl && file.streamUrl !== file.externalStreamUrl
      ? file.streamUrl
      : '';

    const restoreTime = resumeTimeRef.current;
    const restorePlaying = resumePlayingRef.current || (!media.paused && duration > 0);

    const handleLoaded = () => {
      if (Number.isFinite(restoreTime) && restoreTime > 0 && Number.isFinite(media.duration)) {
        const safeTime = Math.min(restoreTime, Math.max(0, media.duration - 0.25));
        try {
          media.currentTime = safeTime;
          setCurrentTime(safeTime);
        } catch {}
      }

      // A transient native MEDIA_ERR_SRC_NOT_SUPPORTED can be emitted while
      // Hls.js is attaching MediaSource. Clear any stale overlay once metadata
      // has successfully arrived.
      setMediaError('');

      // Stream buttons are an explicit user action, so always attempt to
      // start playback as soon as the browser has media metadata. The
      // <video>/<audio> elements also have autoPlay enabled below. If the
      // browser's autoplay policy blocks playback, the controls remain
      // available for a manual click.
      media.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    };

    media.addEventListener('loadedmetadata', handleLoaded, { once: true });

    const handlePlaying = () => {
      // Stage 2 ends only when the browser is actually rendering playback.
      // This prevents the spinner from disappearing merely because metadata
      // or the first buffer arrived.
      setTrackNotice('');
      setMediaError('');
      setIsSeeking(false);
      setIsPlaying(true);
      onPlaybackStarted?.();
    };

    media.addEventListener('playing', handlePlaying);

    let hls: Hls | null = null;
    // Seedr's browser endpoint intentionally uses a clean same-origin
    // path instead of exposing the upstream .m3u8 filename. Treat that
    // endpoint as HLS explicitly.
    const isHlsStream =
      /\.m3u8(?:$|\?)/i.test(streamUrl) ||
      streamUrl.includes('/api/seedr/hls/') ||
      streamUrl.includes('/api/media/hls/');

    if (isHlsStream && isVideo && Hls.isSupported()) {
      hlsActiveRef.current = true;
      let triedFallback = false;

      const startHls = (sourceUrl: string) => {
        hls?.destroy();
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
        });
        setMediaError('');
        hls.loadSource(sourceUrl);
        hls.attachMedia(media as HTMLMediaElement);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Manifest parsing is only stage 2 progress. Keep the loader visible
          // until the browser emits "playing".
          setMediaError('');
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) return;

          console.warn('[MEDIA][HLS] fatal error', {
            details: data?.details,
            type: data?.type,
            response: data?.response?.code,
            url: sourceUrl,
          });

          if (!triedFallback && fallbackStreamUrl && sourceUrl !== fallbackStreamUrl) {
            triedFallback = true;
            setTrackNotice('Trying browser-compatible stream…');
            startHls(fallbackStreamUrl);
            return;
          }

          setMediaError(data?.details || 'Unable to play the HLS stream.');
          setTrackNotice('');
          hls?.destroy();
          hls = null;
        });
      };

      startHls(streamUrl);
    } else if (isHlsStream && isVideo && media.canPlayType('application/vnd.apple.mpegurl')) {
      media.src = streamUrl;
      media.load();
    } else {
      media.src = streamUrl;
      media.load();
    }

    if (!isVideo) {
      media.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }

    return () => {
      media.removeEventListener('loadedmetadata', handleLoaded);
      media.removeEventListener('playing', handlePlaying);
      hls?.destroy();
      media.pause();
      media.removeAttribute('src');
      media.load();
      hlsActiveRef.current = false;
    };
  }, [file?.id, file?.streamUrl, file?.externalStreamUrl, isVideo, selectedAudioIndex]);

  useEffect(() => {
    if (!file || !isVideo) return;

    const mediaInfoUrl = file.streamUrl.includes('/api/torrents/')
      ? (() => {
          const match = file.streamUrl.match(/\/api\/torrents\/(?:stream|direct-stream)\/([^/]+)\/(\d+)/);
          return match ? `/api/torrents/media-info/${match[1]}/${match[2]}` : '';
        })()
      : `/api/files/media-info/${encodeURIComponent(file.id)}`;

    if (!mediaInfoUrl) return;

    let cancelled = false;
    fetch(mediaInfoUrl)
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (cancelled || !data) return;
        setAudioTracks(Array.isArray(data.audioTracks) ? data.audioTracks : []);
        setSubtitleTracks(Array.isArray(data.subtitleTracks) ? data.subtitleTracks : []);
      })
      .catch(error => console.warn('[MEDIA] track metadata unavailable:', error));

    return () => { cancelled = true; };
  }, [file?.id, file?.streamUrl, isVideo]);

  useEffect(() => {
    const track = subtitleTrackRef.current?.track;
    if (track) track.mode = selectedSubtitleIndex === undefined ? 'disabled' : 'showing';
  }, [selectedSubtitleIndex, subtitleTracks]);

  const formatTransferRate = (bytesPerSecond: number) => {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024) return '0 KB/s';
    const units = ['KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return value >= 100 ? value.toFixed(0) + ' ' + units[unit] :
      value >= 10 ? value.toFixed(1) + ' ' + units[unit] :
      value.toFixed(2) + ' ' + units[unit];
  };

  const openSubtitleSearch = () => {
    if (!file) return;
    const query = file.name.replace(/\.(mkv|mp4|m4v|webm|mov|avi|ts)$/i, '').replace(/[._-]+/g, ' ').trim();
    setSubtitleSearchQuery(query);
    setSubtitleSearchResults([]);
    setSubtitleSearchError('');
    setSubtitleSearchOpen(true);
  };

  const runSubtitleSearch = async () => {
    if (!subtitleSearchQuery.trim()) return;
    setSubtitleSearchLoading(true);
    setSubtitleSearchError('');
    try {
      const { api } = await import('../api/client.ts');
      const results = await api.searchSubtitles(subtitleSearchQuery.trim(), subtitleSearchLanguage);
      setSubtitleSearchResults(results);
      if (!results.length) setSubtitleSearchError('No subtitles found for this title and language.');
    } catch (error) {
      setSubtitleSearchError(error instanceof Error ? error.message : 'Subtitle search failed.');
    } finally {
      setSubtitleSearchLoading(false);
    }
  };

  const downloadSelectedSubtitle = async (result: {
    fileId: string; language: string; release: string; downloads: number; format: string; hearingImpaired: boolean;
  }) => {
    setSubtitleDownloadId(result.fileId);
    setSubtitleSearchError('');
    try {
      const { api } = await import('../api/client.ts');
      const downloaded = await api.downloadSubtitle(result.fileId);
      const nextIndex = subtitleTracks.length ? Math.max(...subtitleTracks.map(track => track.index)) + 1 : 1000;
      const track = {
        index: nextIndex,
        language: downloaded.language || result.language || 'en',
        title: result.release || downloaded.title || 'Downloaded subtitles',
        codec: 'VTT',
        url: downloaded.url
      };
      setSubtitleTracks(prev => [...prev, track]);
      setSelectedSubtitleIndex(nextIndex);
      setSubtitleSearchOpen(false);
      setTrackNotice('Subtitle loaded');
      window.setTimeout(() => setTrackNotice(current => current === 'Subtitle loaded' ? '' : current), 1800);
    } catch (error) {
      setSubtitleSearchError(error instanceof Error ? error.message : 'Subtitle download failed.');
    } finally {
      setSubtitleDownloadId(null);
    }
  };

  // Keep React state synchronized with the browser's actual fullscreen state.
  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === containerRef.current;
      setIsFullscreen(active);
      if (active) {
        void lockLandscape();
      } else {
        unlockOrientation();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [isVideo]);

  if (!file) return null;

  const handleMediaError = () => {
    // When Hls.js owns the video element, Chrome can briefly report
    // MEDIA_ERR_SRC_NOT_SUPPORTED while MediaSource is being attached.
    // Hls.js is the authoritative error source in that mode.
    if (hlsActiveRef.current) return;

    const media = mediaRef.current;
    if (
      media &&
      file?.externalStreamUrl &&
      file.externalStreamUrl !== file.streamUrl &&
      !usingDirectFallback
    ) {
      // The backend proxy is the preferred browser path, but Seedr's
      // presentation URL is known to be directly playable by Chrome for
      // some files. If the proxy response is rejected by the browser,
      // immediately retry the exact Seedr presentation URL rather than
      // showing a fatal error.
      setUsingDirectFallback(true);
      setMediaError('');
      setTrackNotice('Trying direct Seedr stream…');
      media.src = file.externalStreamUrl;
      media.load();
      return;
    }

    const code = media && 'error' in media ? media.error?.code : undefined;
    setMediaError(
      code ? `Browser could not play this stream (media error ${code}).` : 'Unable to play this video stream.'
    );
    setTrackNotice('');
    setIsSeeking(false);
    setIsPlaying(false);
    onPlaybackStarted?.();
  };

  // Toggle play/pause
  const togglePlay = () => {
    if (!mediaRef.current) return;
    if (isPlaying) {
      mediaRef.current.pause();
    } else {
      mediaRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Seek
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    const media = mediaRef.current;

    setCurrentTime(time);
    setIsSeeking(true);
    setTrackNotice('Seeking…');

    if (media) {
      media.currentTime = time;

      // If the video is paused, there will be no "playing" event to dismiss
      // the loader. The seeked event below handles that case.
      if (media.paused) {
        const clearPausedSeek = () => {
          setIsSeeking(false);
          setTrackNotice('');
          media.removeEventListener('seeked', clearPausedSeek);
        };
        media.addEventListener('seeked', clearPausedSeek, { once: true });
      }
    }
  };

  // Skip
  const skip = (seconds: number) => {
    if (!mediaRef.current) return;
    setIsSeeking(true);
    setTrackNotice('Seeking…');
    mediaRef.current.currentTime = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
  };

  // Volume
  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (mediaRef.current) {
      mediaRef.current.volume = val;
    }
  };

  const toggleMute = () => {
    if (!mediaRef.current) return;
    if (isMuted) {
      mediaRef.current.volume = volume || 0.8;
      setIsMuted(false);
    } else {
      mediaRef.current.volume = 0;
      setIsMuted(true);
    }
  };

  const handleAudioTrackChange = (value: string) => {
    const next = Number(value);
    if (!Number.isInteger(next)) return;

    const media = mediaRef.current;
    resumeTimeRef.current = media?.currentTime || currentTime || 0;
    resumePlayingRef.current = Boolean(media && !media.paused);
    setTrackNotice('Preparing selected audio…');
    setSelectedAudioIndex(next);
  };

  const handleSubtitleTrackChange = (value: string) => {
    if (value === 'off') {
      setSelectedSubtitleIndex(undefined);
      return;
    }
    const next = Number(value);
    if (Number.isInteger(next)) setSelectedSubtitleIndex(next);
  };

  // Speed
  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = speed;
    }
  };

  // Fullscreen
  const lockLandscape = async () => {
    if (!isVideo) return;
    try {
      if (typeof screen !== 'undefined' && screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch {
      // Some Android browsers expose fullscreen but do not allow orientation
      // locking. The fullscreen layout below still uses the real viewport.
    }
  };

  const unlockOrientation = () => {
    try {
      if (typeof screen !== 'undefined' && screen.orientation?.unlock) {
        screen.orientation.unlock();
      }
    } catch {
      // Orientation unlock is not supported by every browser.
    }
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      try {
        await containerRef.current.requestFullscreen?.();
        setIsFullscreen(true);
        await lockLandscape();
      } catch {
        setIsFullscreen(Boolean(document.fullscreenElement));
      }
    } else {
      try {
        await document.exitFullscreen?.();
      } finally {
        setIsFullscreen(false);
        unlockOrientation();
      }
    }
  };

  // Copy Direct Stream URL
  const copyStreamUrl = () => {
    // For Seedr files, prefer the exact external-player HLS URL generated by
    // the backend. Otherwise copy the app's same-origin stream URL.
    const fullUrl = file.externalStreamUrl || (
      file.streamUrl.startsWith('http://') || file.streamUrl.startsWith('https://')
        ? file.streamUrl
        : window.location.origin + file.streamUrl
    );
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Picture in Picture
  const togglePip = async () => {
    if (videoRef.current && document.pictureInPictureEnabled) {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    }
  };

  // Timeline seeking/buffering
  const onSeeking = () => {
    setIsSeeking(true);
    setTrackNotice('Seeking…');
  };

  const onSeeked = () => {
    const media = mediaRef.current;
    // If playback was paused, "playing" will never arrive to clear the
    // loader. For active playback, keep it visible until "playing" resumes.
    if (media?.paused) {
      setIsSeeking(false);
      setTrackNotice('');
    }
  };

  // Time update
  const onTimeUpdate = () => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
  };

  const onLoadedMetadata = () => {
    if (mediaRef.current) {
      setDuration(mediaRef.current.duration || file.duration || 600);

      if (resumePlayingRef.current) {
        mediaRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      } else {
        setIsPlaying(false);
      }
    }
  };

  // Minimized floating player (for multitasking while downloading or browsing folders)
  if (isMinimized) {
    return (
      <div className="fixed bottom-16 md:bottom-6 right-4 z-50 w-80 md:w-96 bg-slate-900/95 backdrop-blur-xl border border-slate-700 shadow-2xl rounded-2xl p-3.5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
              {isVideo ? <Video className="w-4 h-4" /> : <Music className="w-4 h-4" />}
            </div>
            <div className="truncate">
              <p className="text-xs font-semibold text-slate-200 truncate">{file.name}</p>
              <p className="text-[10px] text-slate-400">{formatDuration(currentTime)} / {formatDuration(duration || file.duration || 0)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleMinimize}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
              title="Expand"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
              title="Close Player"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Hidden or small video preview */}
        {isVideo ? (
          <video
            ref={videoRef}
            src={file.streamUrl || file.externalStreamUrl}
            className="w-full h-32 object-contain bg-black rounded-lg"
            onTimeUpdate={onTimeUpdate}
            onSeeking={onSeeking}
            onSeeked={onSeeked}
            onPlaying={() => {
              setIsSeeking(false);
              setTrackNotice('');
              setIsPlaying(true);
            }}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
          />
        ) : (
          <audio
            ref={audioRef}
            autoPlay
            src={file.streamUrl}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
          />
        )}

        {/* Mini Controls */}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => skip(-10)}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={togglePlay}
            className="p-2 rounded-full bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition"
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <button
            onClick={() => skip(10)}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <button onClick={toggleMute} className="text-slate-400 hover:text-slate-200">
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={duration || file.duration || 100}
          value={currentTime}
          onChange={handleSeek}
          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
      </div>
    );
  }

  // Full Player Modal
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/80 backdrop-blur-md">
      <div
        ref={containerRef}
        className={`relative bg-slate-900 overflow-hidden flex flex-col ${
          isFullscreen
            ? 'w-screen h-screen max-w-none max-h-none rounded-none border-0'
            : 'w-full max-w-4xl border border-slate-700/80 rounded-2xl shadow-2xl max-h-[95vh]'
        }`}
      >
        {/* Top Header */}
        <div className={`${isFullscreen ? 'hidden' : 'flex'} items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/90 z-10`}>
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400">
              {isVideo ? <Video className="w-5 h-5" /> : <Music className="w-5 h-5" />}
            </div>
            <div className="truncate">
              <h3 className="text-sm md:text-base font-semibold text-slate-100 truncate">{file.name}</h3>
              <p className="text-xs text-slate-400 flex items-center gap-2">
                <span>{formatBytes(file.size)}</span>
                <span>•</span>
                <span className="text-emerald-400 font-medium">
                  Direct Browser Streaming
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={copyStreamUrl}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition"
              title="Copy Direct Streaming Link"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Stream URL'}</span>
            </button>

            <a
              href={file.downloadUrl}
              download={file.name}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition"
              title="Direct Download File"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Download</span>
            </a>

            <button
              onClick={onToggleMinimize}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Minimize to Floating Player"
            >
              <Minimize2 className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Close Player"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Media Viewport */}
        <div className={`relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden ${
          isFullscreen ? 'h-full min-h-0' : 'min-h-[260px] md:min-h-[420px]'
        }`}>
          {mediaError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center">
              <div className="max-w-md rounded-xl bg-slate-900/95 border border-rose-500/30 p-5">
                <p className="text-sm font-semibold text-rose-300">{mediaError}</p>
                <p className="text-xs text-slate-400 mt-2">
                  The Seedr stream could not be played. We tried the direct Seedr presentation URL and the server proxy.
                </p>
              </div>
            </div>
          )}

          {/* Stage 2: the stream URL is ready and the player is now opening it.
              Keep this lightweight overlay visible until browser media
              metadata arrives so the player never looks frozen/empty. */}
          {!mediaError && trackNotice && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center pointer-events-none">
              <div className="rounded-xl bg-slate-900/90 border border-cyan-500/20 px-5 py-4 shadow-xl">
                <div className="flex items-center justify-center gap-2 text-cyan-300">
                  <span className="inline-flex w-5 h-5 rounded-full border-2 border-cyan-300/30 border-t-cyan-300 animate-spin" />
                  <span className="text-sm font-semibold">{trackNotice}</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Connecting to the browser stream…
                </p>
              </div>
            </div>
          )}

          {isVideo ? (
            <video
              ref={videoRef}
              autoPlay
              className={`w-full h-full object-contain cursor-pointer ${
                isFullscreen ? 'max-h-none' : 'max-h-[60vh]'
              }`}
              onClick={togglePlay}
              onTimeUpdate={onTimeUpdate}
              onSeeking={onSeeking}
              onSeeked={onSeeked}
              onPlaying={() => {
                setIsSeeking(false);
                setTrackNotice('');
                setIsPlaying(true);
              }}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={() => setIsPlaying(false)}
              onError={handleMediaError}>
              {selectedSubtitleIndex !== undefined && (
                <track
                  ref={subtitleTrackRef}
                  key={selectedSubtitleIndex}
                  kind="subtitles"
                  src={subtitleTracks.find(track => track.index === selectedSubtitleIndex)?.url}
                  srcLang={subtitleTracks.find(track => track.index === selectedSubtitleIndex)?.language || 'en'}
                  label={subtitleTracks.find(track => track.index === selectedSubtitleIndex)?.title || subtitleTracks.find(track => track.index === selectedSubtitleIndex)?.language?.toUpperCase() || 'Subtitles'}
                  default
                />
              )}
            </video>
          ) : (
            <div className="flex flex-col items-center justify-center p-8 text-center gap-4">
              <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 animate-pulse-subtle">
                <Music className="w-12 h-12 text-white" />
              </div>
              <div>
                <h4 className="text-lg font-bold text-slate-100">{file.name}</h4>
                <p className="text-sm text-slate-400 mt-1">Lossless Cloud Audio Playback</p>
              </div>

              {/* Dynamic waveform simulation */}
              <div className="flex items-center gap-1 h-12 mt-2">
                {[40, 65, 30, 85, 95, 45, 75, 55, 90, 60, 35, 70, 80, 50, 65, 85, 40, 70].map((h, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-gradient-to-t from-cyan-500 to-indigo-400 rounded-full transition-all duration-300"
                    style={{
                      height: isPlaying ? `${Math.max(12, (h * (0.4 + (i % 3) * 0.3)))}px` : '8px',
                      opacity: isPlaying ? 1 : 0.4
                    }}
                  />
                ))}
              </div>

              <audio
                ref={audioRef}
                src={file.streamUrl}
                onTimeUpdate={onTimeUpdate}
                onLoadedMetadata={onLoadedMetadata}
                onEnded={() => setIsPlaying(false)}
              />
            </div>
          )}
        </div>

        {/* Player Controls Bar */}
        <div className={`p-4 bg-slate-900/95 border-t border-slate-800 flex flex-col gap-3 ${
          isFullscreen ? 'absolute bottom-0 left-0 right-0 z-20 backdrop-blur-md' : ''
        }`}>
          {/* Scrubber and Time */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-slate-400 w-12 text-right">
              {formatDuration(currentTime)}
            </span>
            <div className="relative flex-1 group">
              <input
                type="range"
                min={0}
                max={duration || file.duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 hover:h-2.5 transition-all"
              />
            </div>
            <span className="text-xs font-mono text-slate-400 w-12">
              {formatDuration(duration || file.duration || 0)}
            </span>
          </div>

          {/* Main Controls row */}
          <div className="flex items-center justify-between gap-3 overflow-hidden">
            {/* Left: Playback buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => skip(-10)}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Rewind 10 seconds"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <button
                onClick={togglePlay}
                className="p-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition shadow-lg shadow-cyan-500/20"
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
              </button>

              <button
                onClick={() => skip(10)}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Forward 10 seconds"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-slate-800">
                <button
                  onClick={toggleMute}
                  className="p-2 rounded-lg text-slate-400 hover:text-slate-200"
                >
                  {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolume}
                  className="w-16 sm:w-24 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            </div>

            {/* Right: Speed, PiP, Fullscreen */}
            <div className="flex items-center gap-2 flex-nowrap justify-end min-w-0 overflow-x-auto scrollbar-hide">
              {audioTracks.length > 1 && (
                <label className="flex items-center gap-1.5 bg-slate-800/80 rounded-lg px-2 py-1.5">
                  <Languages className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <select
                    value={selectedAudioIndex !== undefined ? selectedAudioIndex : (audioTracks[0]?.index ?? '')}
                    onChange={(e) => handleAudioTrackChange(e.target.value)}
                    className="bg-transparent text-[11px] text-slate-200 outline-none max-w-[130px]"
                    title="Audio track"
                  >
                    {audioTracks.map((track, index) => (
                      <option key={track.index} value={track.index}>
                        {track.title || track.language?.toUpperCase() || `Audio ${index + 1}`}{track.default ? ' · Default' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {subtitleTracks.length > 0 && (
                <label className="flex items-center gap-1.5 bg-slate-800/80 rounded-lg px-2 py-1.5">
                  <Captions className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <select
                    value={selectedSubtitleIndex !== undefined ? selectedSubtitleIndex : 'off'}
                    onChange={(e) => handleSubtitleTrackChange(e.target.value)}
                    className="bg-transparent text-[11px] text-slate-200 outline-none max-w-[130px]"
                    title="Subtitles"
                  >
                    <option value="off">Subtitles Off</option>
                    {subtitleTracks.map((track, index) => (
                      <option key={track.index} value={track.index}>
                        {track.title || track.language?.toUpperCase() || `Subtitle ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {showDownloadSpeed && (
                <div
                  className="flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-2 py-1.5 text-[11px] text-slate-300"
                  title="Approximate browser download rate for this stream"
                >
                  <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                  <span>↓ {formatTransferRate(downloadSpeedBytes)}</span>
                </div>
              )}

              <button
                onClick={() => {
                  setShowDownloadSpeed(current => {
                    const next = !current;
                    try {
                      localStorage.setItem('torrentStudio.showDownloadSpeed', String(next));
                    } catch {}
                    return next;
                  });
                }}
                className={`p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 transition ${showDownloadSpeed ? 'text-cyan-400' : 'text-slate-500'}`}
                title={showDownloadSpeed ? 'Hide download speed' : 'Show download speed'}
                aria-label={showDownloadSpeed ? 'Hide download speed' : 'Show download speed'}
              >
                <Gauge className="w-4 h-4" />
              </button>

              {/* Playback Speed selector */}
              <div className="flex items-center bg-slate-800/80 rounded-lg p-0.5 text-xs font-medium text-slate-300">
                {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSpeedChange(s)}
                    className={`px-2 py-1 rounded-md transition ${
                      playbackSpeed === s
                        ? 'bg-cyan-500 text-slate-950 font-bold'
                        : 'hover:text-white'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              {/* PiP (video only) */}
              {isVideo && (
                <button
                  onClick={togglePip}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                  title="Picture in Picture"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Fullscreen"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {subtitleSearchOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <h3 className="font-semibold text-slate-100">Download subtitles</h3>
                <p className="mt-1 text-xs text-slate-400">Search OpenSubtitles and attach a subtitle without interrupting playback.</p>
              </div>
              <button onClick={() => setSubtitleSearchOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    value={subtitleSearchQuery}
                    onChange={e => setSubtitleSearchQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void runSubtitleSearch(); }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-cyan-500"
                    placeholder="Movie or episode name"
                  />
                </div>
                <select
                  value={subtitleSearchLanguage}
                  onChange={e => setSubtitleSearchLanguage(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 outline-none"
                >
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                  <option value="ur">Urdu</option>
                  <option value="ta">Tamil</option>
                  <option value="te">Telugu</option>
                  <option value="bn">Bengali</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                </select>
                <button
                  onClick={() => void runSubtitleSearch()}
                  disabled={subtitleSearchLoading || !subtitleSearchQuery.trim()}
                  className="rounded-lg bg-cyan-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50"
                >
                  {subtitleSearchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
                </button>
              </div>

              {subtitleSearchError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {subtitleSearchError}
                </div>
              )}

              <div className="max-h-72 overflow-y-auto space-y-2">
                {subtitleSearchResults.map(result => (
                  <div key={result.fileId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-slate-100">{result.release}</div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {result.language.toUpperCase()} · {result.format.toUpperCase()} · {result.downloads.toLocaleString()} downloads
                        {result.hearingImpaired ? ' · HI' : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => void downloadSelectedSubtitle(result)}
                      disabled={subtitleDownloadId !== null}
                      className="shrink-0 rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                    >
                      {subtitleDownloadId === result.fileId ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Use'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
