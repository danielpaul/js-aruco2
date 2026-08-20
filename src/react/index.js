'use client';

/**
 * React bindings for Next.js apps.
 *
 * `useArucoDetector` owns a Web Worker and pumps frames into it; `useCamera`
 * owns a getUserMedia stream. Both are StrictMode-safe (the double mount does
 * not leak a worker or leave the camera light on), and both surface permission
 * failures as state rather than swallowing them into console.log — which is what
 * the pre-3.0 samples did, leaving a permanently blank canvas with no message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * @typedef {object} Marker
 * @property {number} id
 * @property {{x:number,y:number}[]} corners
 * @property {number} hammingDistance
 * @property {number} rotation
 */

/**
 * Run marker detection in a Web Worker.
 *
 * @param {object} [opts]
 * @param {string|object} [opts.dictionary]  dictionary name, or a definition object
 * @param {object}  [opts.options]           Detector options
 * @param {boolean} [opts.enabled=true]
 * @param {URL}     [opts.workerUrl]         override the worker module URL
 * @returns {{
 *   ready: boolean,
 *   error: Error|null,
 *   markers: Marker[],
 *   stats: {contours:number, candidates:number, decoded:number},
 *   detect: (source: HTMLVideoElement|HTMLCanvasElement|ImageData) => void,
 *   busy: boolean,
 * }}
 */
export function useArucoDetector({ dictionary, options, enabled = true, workerUrl } = {}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [markers, setMarkers] = useState([]);
  const [stats, setStats] = useState({ contours: 0, candidates: 0, decoded: 0 });

  const workerRef = useRef(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef(null);
  const poolRef = useRef(null);
  const seqRef = useRef(0);

  // Serialise the options so a fresh object literal each render does not
  // tear the worker down and rebuild it every frame.
  const optionsKey = useMemo(() => JSON.stringify(options ?? {}), [options]);
  const dictKey = useMemo(
    () => (typeof dictionary === 'string' ? dictionary : JSON.stringify(dictionary ?? null)),
    [dictionary]
  );

  useEffect(() => {
    if (!enabled || !dictionary) return undefined;
    if (typeof Worker === 'undefined') {
      setError(new Error('Web Workers are unavailable in this environment.'));
      return undefined;
    }

    let disposed = false;
    const url = workerUrl || new URL('../worker/detector.worker.js', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event) => {
      if (disposed) return;
      const msg = event.data;
      if (msg.type === 'ready') {
        setReady(true);
        setError(null);
      } else if (msg.type === 'markers') {
        // reclaim the transferred buffer for the next frame
        poolRef.current = new Uint8ClampedArray(msg.data);
        setMarkers(msg.markers);
        setStats(msg.stats);
        busyRef.current = false;
        setBusy(false);
      } else if (msg.type === 'error') {
        const err = new Error(msg.message);
        err.name = msg.name;
        Object.assign(err, msg.details);
        setError(err);
        busyRef.current = false;
        setBusy(false);
      }
    };
    worker.onerror = (event) => {
      if (disposed) return;
      setError(new Error(event.message || 'detector worker failed to start'));
    };

    worker.postMessage({
      type: 'init',
      id: ++seqRef.current,
      dictionary,
      options: JSON.parse(optionsKey),
    });

    return () => {
      disposed = true;
      setReady(false);
      busyRef.current = false;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      workerRef.current = null;
      poolRef.current = null;
    };
    // dictKey/optionsKey are the stable identity of `dictionary`/`options`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dictKey, optionsKey, workerUrl]);

  /**
   * Push one frame. Frames arriving while the worker is busy are dropped, which
   * is the right behaviour for a live preview: showing the newest result matters
   * more than processing every frame.
   */
  const detect = useCallback((source) => {
    const worker = workerRef.current;
    if (!worker || busyRef.current) return;

    const imageData = toImageData(source, canvasRef, poolRef);
    if (!imageData) return;

    busyRef.current = true;
    setBusy(true);
    const buffer = imageData.data.buffer;
    worker.postMessage(
      {
        type: 'detect',
        id: ++seqRef.current,
        width: imageData.width,
        height: imageData.height,
        data: buffer,
      },
      [buffer]
    );
  }, []);

  return { ready, error, markers, stats, detect, busy };
}

/**
 * Read pixels from a video/canvas/ImageData into a transferable buffer.
 * Uses `willReadFrequently` so repeated getImageData does not fall off the
 * GPU-backed path.
 */
function toImageData(source, canvasRef, poolRef) {
  if (!source) return null;
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    // copy so the caller's buffer is not detached by the transfer
    return { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data) };
  }

  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  if (!width || !height) return null;

  let canvas = canvasRef.current;
  if (!canvas) {
    canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
    canvasRef.current = canvas;
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    poolRef.current = null;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);

  // reuse the buffer the worker handed back, when it is the right size
  const pool = poolRef.current;
  if (pool && pool.length === img.data.length) {
    pool.set(img.data);
    poolRef.current = null;
    return { width, height, data: pool };
  }
  return { width, height, data: img.data };
}

/**
 * Open a camera stream and bind it to a video element.
 *
 * Handles the things the pre-3.0 samples got wrong: `playsInline` and `muted`
 * are required for iOS Safari to composite a hidden video at all, permission
 * errors become state instead of a console line, and the track is stopped on
 * unmount so the camera indicator goes out.
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]
 * @param {'user'|'environment'} [opts.facingMode='environment']
 * @param {number} [opts.width=1280]
 * @param {number} [opts.height=720]
 * @returns {{ videoRef: React.RefObject<HTMLVideoElement>, stream: MediaStream|null, error: Error|null, ready: boolean }}
 */
export function useCamera({
  enabled = true,
  facingMode = 'environment',
  width = 1280,
  height = 720,
} = {}) {
  const videoRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(new Error('Camera access requires a secure context (https or localhost).'));
      return undefined;
    }

    let cancelled = false;
    let active = null;

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode,
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        active = s;
        setStream(s);
        setError(null);
        const el = videoRef.current;
        if (el) {
          el.srcObject = s;
          el.playsInline = true;
          el.muted = true;
          return el.play().then(() => { if (!cancelled) setReady(true); });
        }
        return undefined;
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeCameraError(err));
      });

    return () => {
      cancelled = true;
      setReady(false);
      setStream(null);
      if (active) active.getTracks().forEach((t) => t.stop());
      const el = videoRef.current;
      if (el) el.srcObject = null;
    };
  }, [enabled, facingMode, width, height]);

  return { videoRef, stream, error, ready };
}

function describeCameraError(err) {
  const map = {
    NotAllowedError: 'Camera permission was denied. Allow camera access and reload.',
    NotFoundError: 'No camera was found on this device.',
    NotReadableError: 'The camera is already in use by another application.',
    OverconstrainedError: 'No camera matches the requested resolution or facing mode.',
    SecurityError: 'Camera access requires a secure context (https or localhost).',
  };
  const e = new Error(map[err?.name] || err?.message || 'Could not open the camera.');
  e.name = err?.name || 'CameraError';
  e.cause = err;
  return e;
}

/**
 * Drive a callback once per rendered video frame, preferring
 * `requestVideoFrameCallback` (which fires on real decoded frames) and falling
 * back to `requestAnimationFrame`.
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef
 * @param {(video: HTMLVideoElement) => void} onFrame
 * @param {boolean} [enabled=true]
 */
export function useVideoFrameLoop(videoRef, onFrame, enabled = true) {
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  useEffect(() => {
    if (!enabled) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    let handle = 0;
    let stopped = false;
    const useRvfc = typeof video.requestVideoFrameCallback === 'function';

    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2) cbRef.current(video);
      handle = useRvfc
        ? video.requestVideoFrameCallback(tick)
        : requestAnimationFrame(tick);
    };
    handle = useRvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (useRvfc) video.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    };
  }, [videoRef, enabled]);
}
