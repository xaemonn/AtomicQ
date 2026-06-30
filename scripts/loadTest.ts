/**
 * Phase 41 — Load Test Script
 *
 * Run:  npx ts-node -r dotenv/config scripts/loadTest.ts
 *
 * What this does:
 *  1. Enqueues 10,000 jobs as fast as possible (batched pipelines)
 *  2. Measures enqueue throughput (jobs/sec)
 *  3. Starts 3 workers × concurrency-5 = 15 concurrent slots
 *  4. Measures total processing time and throughput
 *  5. Prints p50 / p95 / p99 latency from Redis latency sorted set
 *  6. Prints Redis memory usage before / during / after
 *  7. Prints bottleneck analysis
 */

import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';

// ─── Config ──────────────────────────────────────────────────────────────────

const QUEUE_NAME    = 'load-test';
const TOTAL_JOBS    = 10_000;
const BATCH_SIZE    = 500;          // jobs per Promise.all batch during enqueue
const WORKER_COUNT  = 3;
const CONCURRENCY   = 5;            // per worker → 15 max concurrent
const POLL_INTERVAL = 50;           // ms — aggressive polling for load test
const REDIS_URL     = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('en-US');
}

function ms(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`;
}

async function redisMemoryMB(redis: Redis): Promise<number> {
  const info = await redis.info('memory');
  const match = info.match(/used_memory:(\d+)/);
  return match ? Math.round(Number(match[1]) / 1024 / 1024 * 100) / 100 : -1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printHeader(title: string) {
  const bar = '═'.repeat(60);
  console.log(`\n╔${bar}╗`);
  console.log(`║  ${title.padEnd(58)}║`);
  console.log(`╚${bar}╝`);
}

function printRow(label: string, value: string) {
  console.log(`  ${label.padEnd(35)} ${value}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 AtomicQ — Load Test');
  console.log(`   ${TOTAL_JOBS.toLocaleString()} jobs · ${WORKER_COUNT} workers · concurrency ${CONCURRENCY} each\n`);

  // ── Setup ──────────────────────────────────────────────────────────────────
  const redis = new Redis(REDIS_URL);
  await loadScripts(redis);

  // Flush only the load-test keys (safer than FLUSHDB in production-like env)
  const keys = await redis.keys(`queue:${QUEUE_NAME}:*`);
  if (keys.length > 0) await redis.del(...keys);

  const queue = new Queue(QUEUE_NAME, redis);

  // ── Phase 1: Measure Redis memory baseline ─────────────────────────────────
  printHeader('Phase 1 — Redis Baseline');
  const memBefore = await redisMemoryMB(redis);
  printRow('Redis memory (before):', `${memBefore} MB`);

  // ── Phase 2: Enqueue 10,000 jobs ──────────────────────────────────────────
  printHeader('Phase 2 — Enqueue 10,000 Jobs');
  console.log(`  Batch size: ${BATCH_SIZE} jobs per round\n`);

  const enqueueStart = Date.now();

  for (let i = 0; i < TOTAL_JOBS; i += BATCH_SIZE) {
    const end   = Math.min(i + BATCH_SIZE, TOTAL_JOBS);
    const batch = [];
    for (let j = i; j < end; j++) {
      batch.push(
        queue.add('load-job', {
          index: j,
          payload: `job-data-${j}`,
          createdAt: Date.now(),
        }, { attempts: 1 }) // 1 attempt — no retries for load test
      );
    }
    await Promise.all(batch);

    // Progress indicator every 2000 jobs
    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= TOTAL_JOBS) {
      const done = Math.min(i + BATCH_SIZE, TOTAL_JOBS);
      const elapsed = Date.now() - enqueueStart;
      const rate = Math.round((done / elapsed) * 1000);
      process.stdout.write(`\r  Enqueued: ${fmt(done)} / ${fmt(TOTAL_JOBS)} jobs  [${rate} jobs/sec]   `);
    }
  }

  const enqueueMs = Date.now() - enqueueStart;
  const enqueueRate = Math.round((TOTAL_JOBS / enqueueMs) * 1000);
  console.log('\n');
  printRow('Total enqueue time:', ms(enqueueMs));
  printRow('Enqueue throughput:', `${fmt(enqueueRate)} jobs/sec`);
  printRow('Target (<5s):', enqueueMs < 5000 ? '✅ PASS' : '❌ FAIL (exceeded 5s)');

  const memAfterEnqueue = await redisMemoryMB(redis);
  printRow('Redis memory (after enqueue):', `${memAfterEnqueue} MB`);
  printRow('Memory delta:', `+${(memAfterEnqueue - memBefore).toFixed(2)} MB`);

  // ── Phase 3: Process with 3 workers ×5 concurrency ──────────────────────
  printHeader('Phase 3 — Processing (3 workers × concurrency 5)');
  console.log('  Waiting for all jobs to complete...\n');

  let completed = 0;
  let failed    = 0;
  const workerRedisClients: Redis[] = [];
  const workers: Worker[]           = [];

  // Spin up 3 workers, each with its own Redis connection
  for (let w = 0; w < WORKER_COUNT; w++) {
    const wRedis = new Redis(REDIS_URL);
    await loadScripts(wRedis);
    workerRedisClients.push(wRedis);

    const worker = new Worker(
      QUEUE_NAME,
      async (_job) => {
        // Simulate minimal work — just a tiny async yield
        // This isolates queue overhead from "real" work
      },
      wRedis,
      { concurrency: CONCURRENCY, pollInterval: POLL_INTERVAL }
    );

    worker.on('completed', () => { completed++; });
    worker.on('failed',    () => { failed++;    });
    workers.push(worker);
  }

  const processStart = Date.now();

  // Start all workers simultaneously
  await Promise.all(workers.map(w => w.start()));

  // Poll progress every second until all jobs done
  await new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      const m   = await queue.getMetrics();
      const pct = ((m.completed + m.failed) / TOTAL_JOBS * 100).toFixed(1);
      const elapsed = Date.now() - processStart;
      const rate    = elapsed > 0 ? Math.round(((m.completed + m.failed) / elapsed) * 1000) : 0;

      process.stdout.write(
        `\r  Completed: ${fmt(m.completed)} | Failed: ${fmt(m.failed)} | ` +
        `Active: ${m.active} | Waiting: ${m.waiting} | ${pct}% [${rate} jobs/sec]   `
      );

      if (m.completed + m.failed >= TOTAL_JOBS) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });

  const processMs = Date.now() - processStart;
  const processRate = Math.round((TOTAL_JOBS / processMs) * 1000);

  // Stop all workers gracefully
  await Promise.all(workers.map(w => w.stop()));

  console.log('\n');
  printRow('Total processing time:', ms(processMs));
  printRow('Processing throughput:', `${fmt(processRate)} jobs/sec`);
  printRow('Completed:', fmt(completed));
  printRow('Failed:', fmt(failed));

  const memAfterProcess = await redisMemoryMB(redis);
  printRow('Redis memory (after processing):', `${memAfterProcess} MB`);

  // ── Phase 4: Latency Percentiles ──────────────────────────────────────────
  printHeader('Phase 4 — Latency Percentiles (from Redis)');

  const lk = `queue:${QUEUE_NAME}:latency`;
  const latencyData = await redis.zrange(lk, 0, -1, 'WITHSCORES');

  // WITHSCORES returns [member, score, member, score, ...]
  const durations: number[] = [];
  for (let i = 1; i < latencyData.length; i += 2) {
    durations.push(Number(latencyData[i]));
  }
  durations.sort((a, b) => a - b);

  if (durations.length > 0) {
    printRow('Samples recorded:', fmt(durations.length));
    printRow('p50 (median):', `${ms(percentile(durations, 50))}`);
    printRow('p95:', `${ms(percentile(durations, 95))}`);
    printRow('p99:', `${ms(percentile(durations, 99))}`);
    printRow('min:', `${ms(durations[0])}`);
    printRow('max:', `${ms(durations[durations.length - 1])}`);
  } else {
    printRow('Latency data:', 'not available (no data in sorted set)');
  }

  // ── Phase 5: Bottleneck Analysis ──────────────────────────────────────────
  printHeader('Phase 5 — Bottleneck Analysis');

  const workerSlots    = WORKER_COUNT * CONCURRENCY;
  const idealRate      = workerSlots * (1000 / Math.max(1, POLL_INTERVAL));
  const efficiencyPct  = Math.round((processRate / idealRate) * 100);
  const jobsPerWorker  = Math.round(TOTAL_JOBS / WORKER_COUNT);

  printRow('Worker slots (total):', String(workerSlots));
  printRow('Observed rate:', `${fmt(processRate)} jobs/sec`);
  printRow('Jobs per worker:', fmt(jobsPerWorker));

  if (processRate > 3000) {
    printRow('Bottleneck:', '✅ None — throughput is excellent');
  } else if (processRate > 1000) {
    printRow('Bottleneck:', '🟡 Moderate — likely Lua script overhead');
    console.log('\n  Suggestion: Use pipeline batching in Lua or increase worker count');
  } else {
    printRow('Bottleneck:', '🔴 Significant — check Redis latency or network');
    console.log('\n  Suggestion: Check Redis LATENCY LATEST, increase concurrency, or use Redis Cluster');
  }

  if (enqueueMs < 5000) {
    printRow('Enqueue goal (<5s):', `✅ ${ms(enqueueMs)} — PASS`);
  } else {
    printRow('Enqueue goal (<5s):', `❌ ${ms(enqueueMs)} — FAIL`);
    console.log('  Suggestion: Increase BATCH_SIZE or use MULTI/EXEC pipeline enqueue');
  }

  // ── Final Summary Table ───────────────────────────────────────────────────
  printHeader('Summary');
  console.log(`
  ┌─────────────────────────────────────────────┐
  │  METRIC                        VALUE         │
  ├─────────────────────────────────────────────┤
  │  Total jobs                ${String(fmt(TOTAL_JOBS)).padStart(13)} │
  │  Workers                   ${String(WORKER_COUNT).padStart(13)} │
  │  Concurrency (each)        ${String(CONCURRENCY).padStart(13)} │
  ├─────────────────────────────────────────────┤
  │  Enqueue time              ${String(ms(enqueueMs)).padStart(13)} │
  │  Enqueue rate              ${String(fmt(enqueueRate) + ' /s').padStart(13)} │
  │  Process time              ${String(ms(processMs)).padStart(13)} │
  │  Process rate              ${String(fmt(processRate) + ' /s').padStart(13)} │
  ├─────────────────────────────────────────────┤
  │  p50 latency               ${String(durations.length ? ms(percentile(durations, 50)) : 'N/A').padStart(13)} │
  │  p95 latency               ${String(durations.length ? ms(percentile(durations, 95)) : 'N/A').padStart(13)} │
  │  p99 latency               ${String(durations.length ? ms(percentile(durations, 99)) : 'N/A').padStart(13)} │
  ├─────────────────────────────────────────────┤
  │  Redis mem before          ${String(memBefore + ' MB').padStart(13)} │
  │  Redis mem peak            ${String(memAfterEnqueue + ' MB').padStart(13)} │
  │  Redis mem after           ${String(memAfterProcess + ' MB').padStart(13)} │
  └─────────────────────────────────────────────┘
  `);

  // Cleanup
  const cleanupKeys = await redis.keys(`queue:${QUEUE_NAME}:*`);
  if (cleanupKeys.length > 0) await redis.del(...cleanupKeys);

  // Close all connections
  await Promise.all(workerRedisClients.map(r => r.quit()));
  await redis.quit();

  console.log('  ✅ Load test complete. All Redis keys cleaned up.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Load test failed:', err.message);
  process.exit(1);
});
