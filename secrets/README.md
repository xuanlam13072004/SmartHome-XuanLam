# secrets/

Server secrets that must never be committed. Git ignores everything here except
this file; docker-compose mounts the folder read-only into the API Gateway at
`/run/smarthome-secrets`.

| File | What | How to get it |
|---|---|---|
| `firebase-service-account.json` | Lets the Gateway send push notifications (FCM) | Firebase console → Project settings → Service accounts → Generate new private key ([docs/architecture/push.md](../docs/architecture/push.md)) |

Without the file push notifications are simply off; everything else works.
After adding or replacing it: `docker compose restart api-gateway`.
