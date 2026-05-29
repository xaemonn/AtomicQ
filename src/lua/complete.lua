-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: completedKey (queue:name:completed)
-- KEYS[4]: channelKey (queue:name:events)
-- ARGV[1]: jobId
-- ARGV[2]: now (Current timestamp in ms)
-- ARGV[3]: lockToken
-- ARGV[4]: queueName
--
-- Returns 1 on success, -1 if the caller no longer owns the job (it was
-- cancelled, or stall-recovered and handed to another worker).

-- 0. Ownership check — prevents a stale worker from overwriting state
if redis.call("HEXISTS", KEYS[2], ARGV[1]) == 0
   or redis.call("HGET", KEYS[1], "lockToken") ~= ARGV[3] then
    return -1
end

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])

-- 2. Update job metadata
redis.call("HSET", KEYS[1],
    "status", "COMPLETED",
    "completedAt", ARGV[2]
)
redis.call("HDEL", KEYS[1], "lockToken")

-- 3. Add to completed history (Sorted Set for time-based tracking).
--    Retention is handled by cleanup.lua, which deletes the job hash too.
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[1])

redis.call("PUBLISH", KEYS[4], cjson.encode({ event = "job:completed", queueName = ARGV[4], jobId = ARGV[1] }))

return 1
