import { Queue } from '../src/Queue';
import { loadScripts } from '../src/scripts';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const emailsQueue = new Queue('emails', redis);

async function main() {
  await loadScripts(redis);
  console.log('Adding a test job to emails queue...');
  const job = await emailsQueue.add('welcome-email', {
    to: 'test@example.com',
    subject: 'Welcome!'
  });
  console.log(`Job added with ID: ${job.id}`);
  await redis.quit();
}

main().catch(console.error);
