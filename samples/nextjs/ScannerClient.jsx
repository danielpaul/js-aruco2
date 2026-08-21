'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useArucoDetector,
  useCamera,
  useVideoFrameLoop,
} from 'js-aruco3/react';

/**
 * Live marker scanner.
 *
 * Detection runs in a Web Worker, so the 8-120 ms of per-frame work never
 * touches the main thread and the page stays interactive.
 */
export default function ScannerClient({
  dictionary = 'DICT_5X5_50',
  halfResolution = true,
  onMarkers,
}) {
  const { videoRef, error: cameraError, ready: cameraReady } = useCamera({
    facingMode: 'environment',
    width: 1280,
    height: 720,
  });

  const { markers, ready, error, detect, stats } = useArucoDetector({
    dictionary,
    // a downscaled frame has less local contrast, so the ink threshold rises with it
    halfResolution,
    options: { adaptiveThresholdOffset: halfResolution ? 12 : 7 },
  });

  const canvasRef = useRef(null);
  const [fps, setFps] = useState(0);
  const framesRef = useRef({ n: 0, t: performance.now() });

  // Feed the worker. Frames arriving while it is busy are dropped by the hook.
  const onFrame = useCallback((video) => {
    detect(video);

    const f = framesRef.current;
    f.n += 1;
    const now = performance.now();
    if (now - f.t > 500) {
      setFps(Math.round((f.n * 1000) / (now - f.t)));
      f.n = 0;
      f.t = now;
    }
  }, [detect]);

  useVideoFrameLoop(videoRef, onFrame, ready && cameraReady);

  useEffect(() => { onMarkers?.(markers); }, [markers, onMarkers]);

  // Draw the overlay whenever results change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video?.videoWidth) return;

    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';

    for (const m of markers) {
      // corners already arrive in the video's own coordinate space
      const pts = m.corners;
      ctx.strokeStyle = '#00c46a';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = '#c1341c';
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 5, 0, Math.PI * 2);
      ctx.fill();

      const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
      const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
      ctx.fillStyle = '#00c46a';
      ctx.fillText(String(m.id), cx, cy);
    }
  }, [markers, videoRef]);

  if (cameraError) {
    return <p role="alert" style={{ color: '#c1341c' }}>{cameraError.message}</p>;
  }
  if (error) {
    return <p role="alert" style={{ color: '#c1341c' }}>Detector failed: {error.message}</p>;
  }

  return (
    <div>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        {/* playsInline and muted are required for iOS Safari to composite the video at all */}
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        />
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
      </div>

      <p style={{ fontVariantNumeric: 'tabular-nums' }}>
        {ready ? `${markers.length} marker(s)` : 'starting detector…'}
        {' · '}{fps} fps
        {' · '}{stats.candidates} candidates
      </p>

      <ul style={{ display: 'flex', gap: 10, listStyle: 'none', padding: 0, flexWrap: 'wrap' }}>
        {markers.map((m) => (
          <li key={m.id} style={{ padding: '4px 10px', border: '1px solid currentColor' }}>
            id {m.id}{m.hammingDistance > 0 ? ` (h${m.hammingDistance})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
