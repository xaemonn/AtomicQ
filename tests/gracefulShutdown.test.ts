import { spawn } from 'child_process';
import * as path from 'path';
import { setupRedisContainer, TestContext } from './test-helper';

const ROOT = path.resolve(__dirname, '..');

describe('Phase 43 — Graceful Shutdown', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupRedisContainer();
  }, 60000);

  afterAll(async () => {
    if (context) {
      await context.redis.quit();
      await context.container.stop();
    }
  });

  interface RunResult {
    exitCode: number | null;
    stdout: string;
    elapsed: number;
  }

  function runWorkerScript(scriptPath: string): Promise<RunResult> {
    return new Promise((resolve) => {
      // scriptPath is relative to ROOT
      const child = spawn(
        'npx',
        ['ts-node', '-r', 'dotenv/config', scriptPath],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            REDIS_URL: `redis://${context.container.getHost()}:${context.container.getMappedPort(6379)}`
          },
          shell: true
        }
      );

      let stdout = '';
      const start = Date.now();

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        // Optionally pipe to current stdout for visibility
        // process.stdout.write(text);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        // process.stderr.write(chunk);
      });

      child.on('close', (code) => {
        resolve({ exitCode: code, stdout, elapsed: Date.now() - start });
      });
    });
  }

  it('should complete a 5s job before the 30s timeout (exit 0)', async () => {
    const r1 = await runWorkerScript('tests/sh_worker_slow.ts');
    
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain('job DONE');
    expect(r1.elapsed).toBeLessThan(30000);
  }, 60000);

  it('should force-exit after 30s if a job takes 35s (exit 1)', async () => {
    const r2 = await runWorkerScript('tests/sh_worker_very_slow.ts');
    
    expect(r2.exitCode).toBe(1);
    expect(r2.stdout).not.toContain('should NOT appear');
    expect(r2.elapsed).toBeGreaterThanOrEqual(28000); // 30s timeout
  }, 75000);
});
