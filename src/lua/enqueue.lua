-- KEYS[1]: jobKey           (queue:{name}:jobs:{id})
-- KEYS[2]: waitingKey       (queue:{name}:waiting)
-- KEYS[3]: delayedKey       (queue:{name}:delayed)
-- KEYS[4]: channelKey       (queue:{name}:events)
-- KEYS[5]: idempotencyKey   (queue:{name}:idem:{key})  "" when unused
-- ARGV[1]: jobId
-- ARGV[2]: jobJson
-- ARGV[3]: runAt (timestamp ms)
-- ARGV[4]: maxAttempts
-- ARGV[5]: priorityScore
-- ARGV[6]: now
-- ARGV[7]: queueName

-- ── Idempotency check ────────────────────────────────────────────────────────
-- Only run when caller supplied an idem key (KEYS[5] is non-empty)
if KEYS[5] ~= "" then
    -- SET NX EX: only set if the key does NOT already exist; expire in 24h
    local set = redis.call("SET", KEYS[5], ARGV[1], "NX", "EX", 86400)
    if set == false then
        -- Key already existed → return the stored jobId to the caller
        local existingId = redis.call("GET", KEYS[5])
        return existingId
    end
    -- set == "OK" → fresh key, continue with normal enqueue below
end

-- ── Normal enqueue ────────────────────────────────────────────────────────────

local isDelayed = tonumber(ARGV[3]) > tonumber(ARGV[6])

-- 1. Save job metadata into a Redis Hash
redis.call("HSET", KEYS[1],
    "data",        ARGV[2],
    "status",      isDelayed and "DELAYED" or "WAITING",
    "id",          ARGV[1],
    "runAt",       ARGV[3],
    "attempts",    "0",
    "maxAttempts", ARGV[4],
    "priority",    ARGV[5]
)

-- 2. Route to the right sorted set
if isDelayed then
    -- Delayed job: score = future timestamp
    redis.call("ZADD", KEYS[3], ARGV[3], ARGV[1])
else
    -- Ready job: score = priority (lower = higher priority)
    redis.call("ZADD", KEYS[2], ARGV[5], ARGV[1])
end

-- 3. Notify workers (wake-up) and the dashboard (live feed)
redis.call("PUBLISH", KEYS[4], cjson.encode({ event = "job:added", queueName = ARGV[7], jobId = ARGV[1], delayed = isDelayed }))

return ARGV[1]
