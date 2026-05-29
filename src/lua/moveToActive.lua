-- KEYS[1]: delayedKey
-- KEYS[2]: waitingKey
-- KEYS[3]: activeKey
-- KEYS[4]: limiterKey
-- KEYS[5]: channelKey
-- ARGV[1]: now
-- ARGV[2]: jobKeyPrefix
-- ARGV[3]: limitMax
-- ARGV[4]: limitDuration
-- ARGV[5]: lockToken  (unique per worker; required to complete/fail the job)
-- ARGV[6]: queueName

-- 0. Check Rate Limit if enabled
local max = tonumber(ARGV[3])
if max > 0 then
    local duration = tonumber(ARGV[4])
    redis.call("ZREMRANGEBYSCORE", KEYS[4], 0, ARGV[1] - duration)
    local count = redis.call("ZCARD", KEYS[4])

    if count >= max then
        -- We are rate limited
        return "RATE_LIMIT"
    end
end

-- 1. Promote due jobs from 'delayed' to 'waiting' (bounded batch per call)
local readyJobs = redis.call("ZRANGEBYSCORE", KEYS[1], 0, ARGV[1], "LIMIT", 0, 1000)

for _, jobId in ipairs(readyJobs) do
    local jobKey = ARGV[2] .. jobId
    local priority = redis.call("HGET", jobKey, "priority") or 5
    redis.call("ZADD", KEYS[2], priority, jobId)
    redis.call("ZREM", KEYS[1], jobId)
    redis.call("HSET", jobKey, "status", "WAITING")
end

-- 2. Pick highest priority job (ties broken by member = time-prefixed jobId → FIFO)
local jobs = redis.call('ZRANGE', KEYS[2], 0, 0)
if #jobs == 0 then
    return nil
end

local jobId = jobs[1]
local jobKey = ARGV[2] .. jobId

-- 3. Update rate limit tracker if enabled
if max > 0 then
    -- Use jobId as member to avoid collisions
    redis.call("ZADD", KEYS[4], ARGV[1], jobId)
end

-- 4. Move to active and stamp the lock token
redis.call('ZREM', KEYS[2], jobId)
redis.call('HSET', jobKey, 'status', 'ACTIVE', 'startedAt', ARGV[1], 'lockToken', ARGV[5])
redis.call('HSET', KEYS[3], jobId, ARGV[1])

redis.call("PUBLISH", KEYS[5], cjson.encode({ event = "job:active", queueName = ARGV[6], jobId = jobId }))

return jobId
