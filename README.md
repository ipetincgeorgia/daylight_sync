# Daylight Sync

Small web application to query Daylight booking numbers, map them to PRO numbers, and show a dashboard per booking.

## Features

- Input one or multiple booking numbers
- Query through a secure backend API proxy
- Show a mapping table: booking number + PRO number + status
- Show a dashboard card for each booking:
  - current status
  - shipping location
  - consignee
  - station timeline/events

## 1) Configure

1. Copy `.env.example` to `.env`.
2. Update all values with your Daylight API credentials and endpoint.
3. Most important field:
   - `DAYLIGHT_TRACKING_ENDPOINT`: set this to your real path (for example `/v1/tracking`).

If your endpoint URL includes the booking in the path, use:

```
DAYLIGHT_TRACKING_ENDPOINT=/v1/tracking/{bookingNumber}
```

## 2) Run locally

```bash
npm install
npm start
```

Open: <http://localhost:8080>

## 3) Deploy to Google Cloud Run

1. Build image:

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/daylight-sync
```

2. Deploy:

```bash
gcloud run deploy daylight-sync \
  --image gcr.io/YOUR_PROJECT_ID/daylight-sync \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars PORT=8080,DAYLIGHT_USERNAME=...,DAYLIGHT_PASSWORD=...,DAYLIGHT_ACCOUNT=...,DAYLIGHT_API_KEY=...,DAYLIGHT_API_SECRET=...,DAYLIGHT_BASE_URL=https://dylt-portalapi.apigee.io,DAYLIGHT_TRACKING_ENDPOINT=/replace-with-your-endpoint
```

Use Secret Manager for production credentials instead of plain env vars.

## API Route

`POST /api/daylight/query`

Request body:

```json
{
  "bookingNumbers": ["BKG1001", "BKG1002"]
}
```

Response contains normalized records:

- `bookingNumber`
- `proNumber`
- `status`
- `shippingLocation`
- `consignee`
- `stations[]`
- `raw` (full source payload for debugging)

## Notes

Daylight API response formats can differ by endpoint. The server normalizes common field names (`pro`, `proNumber`, `status`, `stations`, etc.). If your endpoint uses different names, adjust mapping in `server.js`.
