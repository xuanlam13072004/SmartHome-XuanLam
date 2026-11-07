# media-relay-service

Camera media relay (docs/architecture/camera-contract.md, sections 6 and 14.3).

- Cameras dial `ws://<host>:8090/v1/ingest` (`smarthome-media-ingest.v1`) with the
  ingest token the API Gateway put into the operation context.
- The app plays HLS from `http://<host>:8090/v1/sessions/<session_id>/<access_token>/index.m3u8`.
- Tokens are checked on every request against the Redis projection
  `media:session:<id>` written by the Gateway; `media.session.revoked` cuts
  connections at once.
- Keeps about 30 s of live fragments in RAM per camera. Never stores recordings
  and never transcodes.

Environment: `PORT` (8090), `HOST`, `REDIS_URL`.

```bash
npm ci
npm test        # relay tests + virtual camera end-to-end test
npm run build && npm start
```
