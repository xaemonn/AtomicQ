import redis from '../src/redis';
import { Queue } from '../src/Queue';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';

const JOB_COUNT = 10000;
const CONCURRENCY = 4;
const QUEUE_NAME = 'benchmark_queue';

async function runBenchmark() {
  await loadScripts(redis);
  const queue = new Queue(QUEUE_NAME, redis);

  console.log(`\n🚀 Starting Benchmark: ${JOB_COUNT} jobs\n`);

  // --- Benchmark 1: Ingestion (Add Jobs) ---
  console.log(`[Task 1] Ingesting ${JOB_COUNT} jobs...`);
  const startIngest = Date.now();
  
  const promises = [];
  for (let i = 0; i < JOB_COUNT; i++) {
    promises.push(queue.add('benchmark_job', { index: i }));
  }
  await Promise.all(promises);
  
  const endIngest = Date.now();
  const ingestDuration = (endIngest - startIngest) / 1000;
  const ingestThroughput = Math.round(JOB_COUNT / ingestDuration);
  
  console.log(`✅ Ingestion Complete: ${ingestDuration.toFixed(2)}s (${ingestThroughput} jobs/sec)\n`);

  // --- Benchmark 2: Processing ---
  console.log(`[Task 2] Processing ${JOB_COUNT} jobs with ${CONCURRENCY} workers...`);
  const startProcess = Date.now();
  
  let processedCount = 0;
  const workers: Worker[] = [];

  return new Promise<void>(async (resolve) => {
    // Create workers
    for (let i = 0; i < CONCURRENCY; i++) {
      const workerRedis = redis.duplicate();
      await loadScripts(workerRedis);
      
      const worker = new Worker(
        QUEUE_NAME, 
        async (job) => {
          // Noop job processing for benchmark
        }, 
        workerRedis, 
        {
          concurrency: 50, // sub-concurrency per worker instance
          pollInterval: 10
        }
      );

      worker.start();

      worker.on('completed', () => {
        processedCount++;
        if (processedCount % 1000 === 0) {
          process.stdout.write(`...processed ${processedCount} jobs\n`);
        }
        if (processedCount >= JOB_COUNT) {
          const endProcess = Date.now();
          const processDuration = (endProcess - startProcess) / 1000;
          const processThroughput = Math.round(JOB_COUNT / processDuration);
          
          console.log(`\n✅ Processing Complete: ${processDuration.toFixed(2)}s (${processThroughput} jobs/sec)\n`);
          
          // Cleanup
          workers.forEach(w => w.stop());
          redis.flushall().then(() => {
            console.log('🧹 Redis Flushed. Benchmark Finished.\n');
            process.exit(0);
          });
          resolve();
        }
      });

      workers.push(worker);
    }
  });
}

runBenchmark().catch(err => {
  console.error('Benchmark Failed:', err);
  process.exit(1);
});
