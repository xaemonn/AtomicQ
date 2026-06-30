import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const queue = new Queue('emails', redis);
  
  const waiting = await redis.zcard(`queue:emails:waiting`);
  const activeLength = await redis.hlen(`queue:emails:active`);
  
  console.log(`Waiting: ${waiting}, Active: ${activeLength}`);
  await redis.quit();
}

main().catch(console.error);
