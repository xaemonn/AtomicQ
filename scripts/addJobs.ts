import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { loadScripts } from '../src/scripts';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  await loadScripts(redis);
  const queue = new Queue('emails', redis);
  
  console.log('Adding 1000 jobs to the emails queue...');
  
  const batchSize = 100;
  for (let i = 0; i < 1000; i += batchSize) {
    const promises = [];
    for (let j = 0; j < batchSize; j++) {
      promises.push(queue.add('welcome-email-bulk', { test: i + j }));
    }
    await Promise.all(promises);
    console.log(`Added ${i + batchSize} jobs`);
  }
  
  console.log('Done!');
  await redis.quit();
}

main().catch(console.error);
