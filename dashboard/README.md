# AtomicQ dashboard

The real-time operations UI for [AtomicQ](../README.md): React 19, TypeScript, Tailwind CSS and Socket.IO, built with Vite.

## Running it

The dashboard needs the AtomicQ API server (`npm run dev` in the repository root, port 3000).

```bash
npm install
npm run dev        # http://localhost:5173 — proxies /api and /socket.io to localhost:3000
```

`npm run build` type-checks and writes the production bundle to `dist/`. The API server serves that folder itself when it exists, so in production (and in the Docker image) the dashboard and the API share one origin.

`npm run lint` runs ESLint.

## How it gets its data

- **REST** (`src/lib/api.ts`) — counters, job pages, workers, schedules and health, polled every few seconds. This is the source of truth.
- **Socket.IO** (`src/lib/live.ts`) — the server relays each queue's Redis Pub/Sub event channel as `job-event`. Events are applied in 250 ms batches to move the counters, the throughput chart, the event stream and any visible job row between polls; the next poll replaces those estimates with real numbers.

## Layout

```
src/
  App.tsx              shell: boot, polling, live-event batching, view switching
  components/
    Sidebar.tsx        navigation, queue list, connection status
    Overview.tsx       pipeline, performance, event stream, workers on the queue
    ThroughputChart.tsx  SVG line chart, no chart library
    JobsView.tsx       per-state job table and bulk actions
    JobDrawer.tsx      job inspector (timeline, error, payload)
    WorkersView.tsx    worker processes and slot usage
    SchedulesView.tsx  cron definitions
    AddJobDialog.tsx   enqueue a job by hand
    ui.tsx             shared pieces: pills, dialogs, toasts, logo
  lib/                 API client, live socket, formatting, status styles, hooks
```

Colours and fonts are defined in `tailwind.config.js`; shared component classes (`panel`, `btn`, `field`) live in `src/index.css`.
