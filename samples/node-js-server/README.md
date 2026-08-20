# Node stream detection sample

Detects markers from an ffmpeg rawvideo stream.

```bash
export ARUCO_TOKEN=$(head -c 24 /dev/urandom | base64)
npm run server          # terminal 1
npm run stream_unix     # terminal 2  (stream_osx / stream_win)
```

The server refuses to start without `ARUCO_TOKEN`, and every request must carry
`Authorization: Bearer $ARUCO_TOKEN`. The pre-3.0 version put a shared secret in
the URL path — where it lands in access logs, proxies and browser history — and
left the debug snapshot endpoint entirely unauthenticated.

Set `ARUCO_DEBUG_SNAPSHOT=1` to enable `/snapshot.json`.

## Configuration

| Variable | Default |
| --- | --- |
| `ARUCO_TOKEN` | *(required)* |
| `PORT` | 8081 |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | 640 / 480 |
| `ARUCO_DICTIONARY` | `DICT_5X5_50` |
| `ARUCO_DEBUG_SNAPSHOT` | off |

The pixel format must match: `-pix_fmt rgba` and the declared width/height, or
the decoder assembles misaligned frames. A dropped byte is recoverable —
`StreamDecoder.resync()` discards the partial frame rather than splicing two
together for the rest of the session, which is what the old implementation did.

No `jpeg-js` dependency any more: the sample no longer re-encodes every frame to
disk just to show a debug image.
