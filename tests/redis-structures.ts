import { setupRedisContainer } from './test-helper';

async function exerciseRedisStructures() {
  console.log("--- Redis Structure Deep Dive ---");

  const context = await setupRedisContainer();
  const redis = context.redis;

  try {
    // 1. Strings (Simple Key-Value)
    console.log("\n[String Test]");
    await redis.set("my-string", "Hello Redis!");
    const str = await redis.get("my-string");
    console.log(`GET my-string: ${str}`);

    // 2. Hashes (Object-like field-value maps)
    console.log("\n[Hash Test]");
    await redis.hset("job:1", {
      name: "send-email",
      data: JSON.stringify({ to: "user@example.com", body: "Welcome!" }),
      attempts: "0",
      priority: "high"
    });
    const jobData = await redis.hgetall("job:1");
    console.log("HGETALL job:1:", jobData);

    // 3. Sorted Sets (Ordered by Score)
    console.log("\n[Sorted Set Test - The Engine's Heart]");
    const now = Date.now();
    await redis.zadd("waiting", now + 1000, "job:delayed"); // delayed 1s
    await redis.zadd("waiting", now - 1000, "job:ready");   // ready 1s ago
    await redis.zadd("waiting", now, "job:now");           // ready now

    const readyJobs = await redis.zrangebyscore("waiting", 0, now);
    console.log(`Ready jobs (score <= ${now}):`, readyJobs);

    // 4. Pub/Sub (Real-time events)
    console.log("\n[Pub/Sub Test]");
    const sub = await redis.duplicate(); // Separate client for subscribe
    await sub.subscribe("queue-updates");

    sub.on("message", (channel, message) => {
      console.log(`Pub/Sub: Received message on ${channel}: ${message}`);
    });

    // We publish on the main connection
    await redis.publish("queue-updates", "Job 1 Completed");

    // Give it a moment to receive the pub/sub then cleanup
    await new Promise(resolve => setTimeout(resolve, 500));
    await sub.unsubscribe("queue-updates");
    await sub.quit();

  } catch (err) {
    console.error("Structure exercise failed:", err);
  } finally {
    console.log("\n--- Exercise Finished ---");
    await redis.quit();
    await context.container.stop();
    process.exit(0);
  }
}

exerciseRedisStructures();
