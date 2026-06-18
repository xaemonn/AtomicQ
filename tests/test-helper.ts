import { GenericContainer, StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { loadScripts } from '../src/scripts';

export interface TestContext {
  container: StartedTestContainer;
  redis: Redis;
}

/**
 * Helper to spawn a Redis container for tests.
 * Can be used in beforeAll/afterAll blocks.
 */
export async function setupRedisContainer(): Promise<TestContext> {
  const container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(6379);
  const url = `redis://${host}:${port}`;

  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });

  await loadScripts(redis);

  return { container, redis };
}

export async function teardownRedisContainer(context: TestContext): Promise<void> {
  if (context.redis) {
    await context.redis.quit();
  }
  if (context.container) {
    await context.container.stop();
  }
}
