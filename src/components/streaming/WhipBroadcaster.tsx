'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { WHIPClient } from '@/lib/streaming/whip-client';
import './video.css';

type Phase = 'idle' | 'connecting' | 'sending' | 'retrying' | 'stopped';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 3000;

/** The error text key for a failure: the route's HTTP status (WHIPClient puts it in the message) or the camera's DOMException name. */
export function errorKey(e: unknown): 'denied' | 'nocam' | 'signin' | 'forbidden' | 'state' | 'rate' | 'unavailable' | 'generic' {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'nocam';
  const status = /^whip (\d{3})/.exec((e as Error)?.message ?? '')?.[1];
  if (status === '401') return 'signin';
  if (status === '403') return 'forbidden';
  if (status === '409') return 'state';
  if (status === '429') return 'rate';
  if (status && Number(status) >= 500) return 'unavailable';
  return 'generic';
}

/**
 * Camera preview and "Go live" for one show. The camera is opened only when the seller presses the preview button; sending starts only on
 * "Go live" and posts the offer to OUR route, which holds the publish credential. This component has no credential and no media-server address.
 * No username and password props, no console output, a fresh client per attempt, three reconnects.
 */
export default function WhipBroadcaster({ showId }: { showId: string }) {
  const t = useTranslations('video.broadcast');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const clientRef = useRef<WHIPClient | null>(null);
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [hasStream, setHasStream] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ReturnType<typeof errorKey> | null>(null);

  const openCamera = useCallback(async (id: string) => {
    streamRef.current?.getTracks().forEach((x) => x.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30, ...(id ? { deviceId: { exact: id } } : {}) },
      audio: true,
    });
    stream.getAudioTracks().forEach((x) => { x.enabled = micOn; });
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
    setHasStream(true);
    setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
    return stream;
  }, [micOn]);

  const preview = async () => {
    setError(null);
    try { await openCamera(deviceId); } catch (e) { setError(errorKey(e)); }
  };

  const publishRef = useRef<() => Promise<void>>(async () => {});

  const scheduleRetry = useCallback(async (k: ReturnType<typeof errorKey> = 'unavailable') => {
    await clientRef.current?.stop();
    clientRef.current = null;
    if (!alive.current) return;
    if (retries.current >= MAX_RETRIES) { setError(k); setPhase('idle'); return; }
    retries.current += 1;
    setPhase('retrying');
    timer.current = setTimeout(() => void publishRef.current(), RETRY_BASE_MS * 1.5 ** (retries.current - 1));
  }, []);

  const publish = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream || !alive.current) return;
    const client = new WHIPClient(`/api/streams/${showId}/whip`, {
      onConnectionStateChange: (s) => {
        if (!alive.current || clientRef.current !== client) return;
        if (s === 'connected') { retries.current = 0; setPhase('sending'); }
        else if (s === 'failed') void scheduleRetry();
      },
    });
    clientRef.current = client;
    try { await client.publish(stream); } catch (e) {
      if (clientRef.current === client) { await client.stop(); clientRef.current = null; }
      const k = errorKey(e);
      if (k === 'unavailable' || k === 'generic') await scheduleRetry(k); else { setError(k); setPhase('idle'); }
    }
  }, [showId, scheduleRetry]);
  publishRef.current = publish;

  const goLive = async () => {
    setError(null);
    retries.current = 0;
    setPhase('connecting');
    if (!streamRef.current) {
      try { await openCamera(deviceId); } catch (e) { setError(errorKey(e)); setPhase('idle'); return; }
    }
    await publish();
  };

  const stop = async () => {
    if (timer.current) clearTimeout(timer.current);
    await clientRef.current?.stop();
    clientRef.current = null;
    setPhase('stopped');
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      void clientRef.current?.stop();
      streamRef.current?.getTracks().forEach((x) => x.stop());
    };
  }, []);

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    streamRef.current?.getAudioTracks().forEach((x) => { x.enabled = next; });
  };

  const changeDevice = async (id: string) => {
    setDeviceId(id);
    if (!streamRef.current) return;
    try {
      const stream = await openCamera(id);
      const track = stream.getVideoTracks()[0];
      if (track) await clientRef.current?.replaceTrack(track);
    } catch (e) { setError(errorKey(e)); }
  };

  const busy = phase === 'connecting' || phase === 'sending' || phase === 'retrying';
  return (
    <div className="vd-grid" data-testid="broadcaster" data-phase={phase}>
      <video ref={videoRef} className="vd-preview" autoPlay muted playsInline aria-label={t('previewAlt')} data-testid="camera-preview" />
      <div className="vd-row">
        {!hasStream && <button type="button" className="sl-btn" data-testid="camera-start" onClick={preview}>{t('preview')}</button>}
        {devices.length > 1 && (
          <label className="sl-field sl-field--inline">
            <span>{t('camera')}</span>
            <select value={deviceId} data-testid="camera-select" onChange={(e) => void changeDevice(e.target.value)}>
              <option value="">{t('cameraDefault')}</option>
              {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t('camera')} ${i + 1}`}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="sl-btn" data-testid="mic-toggle" aria-pressed={micOn} onClick={toggleMic}>{micOn ? t('micOn') : t('micOff')}</button>
      </div>
      <div className="vd-row">
        <button type="button" className="sl-btn sl-btn--primary" data-testid="go-live" disabled={busy} onClick={goLive}>{t('goLive')}</button>
        <button type="button" className="sl-btn" data-testid="stop-live" disabled={!busy} onClick={stop}>{t('stop')}</button>
      </div>
      <p className="vd-status" role="status" data-testid="broadcast-status">{t(`status.${phase}`)}</p>
      {error && <p className="vd-warn" role="alert" data-testid="broadcast-error" data-error={error}>{t(`errors.${error}`)}</p>}
    </div>
  );
}
