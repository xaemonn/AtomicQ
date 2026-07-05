import fs from 'fs';
import path from 'path';
import { Redis } from 'ioredis';

// Type definitions for our dynamic Redis methods
// This allows TS to know about the commands we inject at runtime
declare module 'ioredis' {
  interface Redis {
    hello(numKeys: number, name: string): Promise<string>;
    // Our core queue commands
    enqueue(numKeys: number, jobKey: string, waitingKey: string, delayedKey: string, channelKey: string, idempotencyKey: string, jobId: string, jobJson: string, runAt: number, maxAttempts: number, priorityScore: number, now: number, queueName: string): Promise<string>;
    moveToActive(numKeys: number, delayedKey: string, waitingKey: string, activeKey: string, limiterKey: string, channelKey: string, now: number, jobKeyPrefix: string, limitMax: number, limitDuration: number, lockToken: string, queueName: string): Promise<string | null>;
    complete(numKeys: number, jobKey: string, activeKey: string, completedKey: string, channelKey: string, jobId: string, now: number, lockToken: string, queueName: string): Promise<number>;
    fail(numKeys: number, jobKey: string, activeKey: string, delayedKey: string, failedKey: string, channelKey: string, jobId: string, errorMsg: string, now: number, nextRunAt: number, lockToken: string, queueName: string): Promise<number>;
    heartbeat(numKeys: number, activeKey: string, jobKey: string, jobId: string, now: number, lockToken: string): Promise<number>;
    cleanStalled(numKeys: number, activeKey: string, waitingKey: string, failedKey: string, now: number, stallInterval: number, jobKeyPrefix: string): Promise<string[]>;
    updateProgress(numKeys: number, jobKey: string, progress: string): Promise<number>;
    cancel(numKeys: number, jobKey: string, activeKey: string, waitingKey: string, cancelledKey: string, delayedKey: string, jobId: string, now: number): Promise<number>;
    retry(numKeys: number, jobKey: string, failedKey: string, waitingKey: string, jobId: string, now: number): Promise<number>;
    advanceCron(numKeys: number, cronKey: string, jobName: string, expectedJson: string, newJson: string): Promise<number>;
    cleanup(numKeys: number, setKey: string, jobPrefix: string, maxAge: number, maxCount: number, now: number): Promise<number>;
    // Add other commands here as we create them
  }
}

/**
 * Loads all .lua scripts from the src/lua directory into the Redis instance.
 * Using defineCommand allows us to call these scripts as methods on the redis object.
 */
export async function loadScripts(redis: Redis): Promise<void> {
  let luaDir = path.join(__dirname, 'lua');
  
  if (!fs.existsSync(luaDir)) {
    luaDir = path.join(__dirname, '../src/lua');
    if (!fs.existsSync(luaDir)) {
      // Without the scripts no queue operation can work — fail at startup, not on the first job
      throw new Error(`No Lua directory found at ${path.join(__dirname, 'lua')} or ${luaDir}`);
    }
  }

  const files = fs.readdirSync(luaDir).filter(file => file.endsWith('.lua'));

  for (const file of files) {
    const scriptName = path.parse(file).name; // e.g., 'hello' from 'hello.lua'
    const scriptContent = fs.readFileSync(path.join(luaDir, file), 'utf8');

    // ioredis specific: register the command
    // Note: In a real queue, we'd need to know the number of keys.
    // We'll adopt a convention: the first line comment defines the key count, 
    // or we'll default to 0 for these basic tests.
    redis.defineCommand(scriptName, {
      lua: scriptContent
    });

    console.log(`📡 Loaded Lua command: redis.${scriptName}()`);
  }
}
