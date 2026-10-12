# Learner API

Read-only API that returns BISD Learner records from Salesforce. Callers authenticate with a personal API key.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check |
| GET | `/learners?limit=50&offset=0` | `x-api-key` header | Newest learners first. `limit` 1–50 (default 50), `offset` 0–2000 (default 0) |

Example:

```
curl -H "x-api-key: <your key>" "https://<server>/learners?limit=50&offset=0"
```

Response:

```json
{
  "success": true,
  "count": 50,
  "limit": 50,
  "offset": 0,
  "learners": [
    {
      "Id": "...",
      "Learner_ID__c": "...",
      "Learner_Name__c": "...",
      "SDP_Branch__c": "...",
      "SDP_Branch_Name": "...",
      "Trade_Name_Generalized__c": "..."
    }
  ]
}
```

Errors: `401` bad or missing key, `400` bad `limit`/`offset`, `502` Salesforce error (details are in the server log only).

## Configuration

Copy `.env.example` to `.env` and fill it in. Never commit `.env` or key files.

- `API_KEYS`: one entry per consumer, `name:key,name:key`. Make a key with `npm run new-key`. To revoke someone, delete their entry and restart. The consumer name appears in the log for every request.
- `ALLOW_LOCAL_NO_KEY`: `true` only on your own PC for browser testing. **Must be `false` on the server**: behind a reverse proxy every request looks local, so `true` would make the API public.

## Run locally

```
npm install
npm run dev
```

## Deploy

1. Install Node.js 20 or newer on the server.
2. Copy this folder to the server **without** `node_modules`, `.env` and key files.
3. On the server, run `npm ci --omit=dev`.
4. Create `.env` on the server from `.env.example`, with `ALLOW_LOCAL_NO_KEY=false`.
5. Keep it running with a process manager, for example:
   ```
   npm install -g pm2
   pm2 start index.js --name learner-api
   pm2 save
   ```
6. Put it behind HTTPS (nginx, IIS or the server's load balancer). Do not expose it over plain HTTP.
7. Check: `https://<server>/health` returns `success: true`, and `/learners` without a key returns `401`.
