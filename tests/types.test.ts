import { createJob, JobStatus } from "../src/types";

describe("Job Schema & Type System", () => {
  test("createJob should generate a valid Job object", () => {
    const data = { email: "user@example.com" };
    const job = createJob("uuid-123", "send-email", "test-queue", data, { attempts: 5 });

    expect(job.id).toBe("uuid-123");
    expect(job.name).toBe("send-email");
    expect(job.queueName).toBe("test-queue");
    expect(job.data).toEqual(data);
    expect(job.status).toBe(JobStatus.WAITING);
    expect(job.maxAttempts).toBe(5);
    expect(job.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("createJob should handle delayed jobs", () => {
    const job = createJob("uuid-delayed", "test", "test-queue", {}, { delay: 5000 });
    expect(job.status).toBe(JobStatus.DELAYED);
    expect(job.runAt).toBeGreaterThan(Date.now() + 4000);
  });
});
