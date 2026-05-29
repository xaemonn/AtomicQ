-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: delayedKey (queue:name:delayed)
-- KEYS[4]: failedKey (queue:name:failed)
-- KEYS[5]: channelKey (queue:name:events)
-- ARGV[1]: jobId
-- ARGV[2]: errorMessage
-- ARGV[3]: now
-- ARGV[4]: nextRunAt (Timestamp for retry, aka now + backoff)
-- ARGV[5]: lockToken
-- ARGV[6]: queueName
--
-- Returns 0 = retry scheduled, 1 = final failure, -1 = caller lost the lock.

-- 0. Ownership check — prevents a stale worker from overwriting state
if redis.call("HEXISTS", KEYS[2], ARGV[1]) == 0
   or redis.call("HGET", KEYS[1], "lockToken") ~= ARGV[5] then
    return -1
end

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])
redis.call("HDEL", KEYS[1], "lockToken")

-- 2. Fetch retry config
local attempts = tonumber(redis.call("HGET", KEYS[1], "attempts") or 0)
local maxAttempts = tonumber(redis.call("HGET", KEYS[1], "maxAttempts") or 1)

if attempts + 1 < maxAttempts then
    -- RETRY PATH: park in 'delayed' until the backoff elapses.
    -- moveToActive promotes it back to 'waiting' with its priority score.
    redis.call("HSET", KEYS[1],
        "status", "DELAYED",
        "attempts", attempts + 1,
        "runAt", ARGV[4],
        "lastError", ARGV[2]
    )
    redis.call("ZADD", KEYS[3], ARGV[4], ARGV[1])
    redis.call("PUBLISH", KEYS[5], cjson.encode({ event = "job:retrying", queueName = ARGV[6], jobId = ARGV[1], runAt = tonumber(ARGV[4]) }))
    return 0
else
    -- FAILURE PATH (Max attempts reached) — still increment attempts counter
    redis.call("HSET", KEYS[1],
        "status", "FAILED",
        "attempts", attempts + 1,
        "failedAt", ARGV[3],
        "error", ARGV[2]
    )
    -- Add to failed history (Sorted Set)
    redis.call("ZADD", KEYS[4], ARGV[3], ARGV[1])
    redis.call("PUBLISH", KEYS[5], cjson.encode({ event = "job:failed", queueName = ARGV[6], jobId = ARGV[1], error = ARGV[2] }))
    return 1
end
