'use client';

import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { PlayCircle, PauseCircle, Volume2, VolumeX, Maximize } from 'lucide-react';

interface HlsPlayerProps {
  src: string;
  title: string;
  autoPlay?: boolean;
  controls?: boolean;
  aspectRatio?: number;
  isLive?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onError?: (error: Error) => void;
  onCanPlay?: () => void;
  onVideoRef?: (el: HTMLVideoElement | null) => void;
  /** Words for the control buttons (screen readers). The player itself shows no text: errors go to `onError`, the parent decides what to say. */
  labels?: { play: string; pause: string; mute: string; unmute: string; fullscreen: string };
}

export interface HlsPlayerRef {
  retry: () => void;
}

const MAX_AUTO_RETRIES = 5;
const AUTO_RETRY_DELAY_MS = 3000;

export const HlsPlayer = forwardRef<HlsPlayerRef, HlsPlayerProps>(function HlsPlayer({
  src, title, autoPlay = true, controls = true, aspectRatio = 16 / 9,
  isLive = false, labels, onPlay, onPause, onError, onCanPlay, onVideoRef,
}, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true); // Autoplay requires muted
  const [hasError, setHasError] = useState(false);
  const autoRetryCountRef = useRef(0);
  const autoRetryTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track whether hls.js is handling recovery - suppress <video> onError during that window
  const hlsRecoveringRef = useRef(false);

  const loadHls = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Cleanup previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setHasError(false);
    hlsRecoveringRef.current = false;

    // Native HLS support (Safari)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      if (autoPlay) {
        video.muted = true;
        video.play().catch(() => {});
      }
      return;
    }

    // Use hls.js for other browsers
    const Hls = (await import('hls.js')).default;
    if (!Hls.isSupported()) {
      onError?.(new Error('HLS not supported'));
      setHasError(true);
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: isLive,
      backBufferLength: isLive ? 5 : 30,
      liveSyncDurationCount: isLive ? 3 : undefined,
      liveMaxLatencyDurationCount: isLive ? 6 : undefined,
      // Be more tolerant of missing alternate audio tracks
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });

    let networkRecoveryAttempts = 0;
    const MAX_NETWORK_RECOVERIES = 3;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
      // Non-fatal errors: log but don't crash the player
      if (!data.fatal) {
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Mark as recovering so <video> onError doesn't fire a duplicate crash
        hlsRecoveringRef.current = true;
        networkRecoveryAttempts++;

        if (networkRecoveryAttempts <= MAX_NETWORK_RECOVERIES) {
          hls.startLoad();
          // Clear recovery flag after a window for hls.js to settle
          setTimeout(() => { hlsRecoveringRef.current = false; }, 5000);
        } else {
          hlsRecoveringRef.current = false;
          scheduleAutoRetry();
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hlsRecoveringRef.current = true;
        hls.recoverMediaError();
        setTimeout(() => { hlsRecoveringRef.current = false; }, 5000);
      } else {
        setHasError(true);
        onError?.(new Error(data.details || 'HLS error'));
      }
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Reset recovery counters on successful manifest parse
      networkRecoveryAttempts = 0;
      autoRetryCountRef.current = 0;
      if (autoPlay) {
        video.muted = true;
        video.play().catch(() => {});
      }
    });

    hlsRef.current = hls;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, autoPlay, isLive, onError]);
  // scheduleAutoRetry is defined below and used in loadHls - this is intentional

  // Auto-retry: reload the entire HLS stream after a delay (for live streams)
  const scheduleAutoRetry = useCallback(() => {
    if (!isLive) {
      // For VOD, don't auto-retry - show error
      setHasError(true);
      onError?.(new Error('Playback failed'));
      return;
    }

    if (autoRetryCountRef.current >= MAX_AUTO_RETRIES) {
      setHasError(true);
      onError?.(new Error('Stream playback failed after multiple retries'));
      return;
    }

    autoRetryCountRef.current++;

    autoRetryTimerRef.current = setTimeout(() => {
      loadHls();
    }, AUTO_RETRY_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, onError]);
  // loadHls is defined above and used in scheduleAutoRetry - this is intentional

  useEffect(() => {
    loadHls();
    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [loadHls]);

  useEffect(() => {
    onVideoRef?.(videoRef.current);
  }, [onVideoRef]);

  useImperativeHandle(ref, () => ({
    retry: () => loadHls(),
  }));

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play(); } else { video.pause(); }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const toggleFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      video.requestFullscreen();
    }
  };

  return (
    <div className={`relative w-full ${aspectRatio === 9 / 16 ? 'aspect-[9/16]' : 'aspect-video'} bg-black`}>
      <video
        ref={videoRef}
        title={title}
        className="h-full w-full object-cover"
        playsInline
        muted={isMuted}
        onPlay={() => { setIsPlaying(true); onPlay?.(); }}
        onPause={() => { setIsPlaying(false); onPause?.(); }}
        onCanPlay={() => onCanPlay?.()}
        onError={() => {
          // If hls.js is currently recovering (network retry / media error recovery),
          // the <video> element may fire its own error event - ignore it.
          if (hlsRecoveringRef.current) {
            return;
          }

          // For live streams, try auto-recovery before showing error overlay
          if (isLive) {
            scheduleAutoRetry();
            return;
          }

          setHasError(true);
          onError?.(new Error('Video playback error'));
        }}
      />

      {controls && !hasError && (
        <div className="flex items-center justify-between p-3 absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent">
          <div className="flex items-center space-x-4">
            <button type="button" aria-label={labels ? (isPlaying ? labels.pause : labels.play) : undefined} onClick={togglePlay} className="text-white hover:text-[#FFD700] transition">
              {isPlaying ? <PauseCircle size={24} /> : <PlayCircle size={24} />}
            </button>
            <button type="button" aria-label={labels ? (isMuted ? labels.unmute : labels.mute) : undefined} onClick={toggleMute} className="text-white hover:text-[#FFD700] transition">
              {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
          </div>
          <div className="flex items-center space-x-4">
            <button type="button" aria-label={labels?.fullscreen} onClick={toggleFullscreen} className="text-white hover:text-[#FFD700] transition">
              <Maximize size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
