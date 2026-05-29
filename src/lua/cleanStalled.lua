-- KEYS[1]: activeKey
-- KEYS[2]: waitingKey
-- KEYS[3]: failedKey
-- ARGV[1]: now
-- ARGV[2]: stallInterval (ms without heartbeat before a job is stalled)
-- ARGV[3]: jobKeyPrefix
--
-- A stalled job counts as a failed attempt. If it still has attempts left it
-- goes back to 'waiting' with its priority score; otherwise it is moved to
-- 'failed' so a job that keeps crashing workers cannot loop forever.
-- Returns the list of recovered job IDs.

local now = tonumber(ARGV[1])
local stallInterval = tonumber(ARGV[2])

local stalled = {}
local activeJobs = redis.call('HGETALL', KEYS[1])

-- activeJobs is [id1, ts1, id2, ts2, ...]
for i = 1, #activeJobs, 2 do
    local jobId = activeJobs[i]
    local lastHeartbeat = tonumber(activeJobs[i+1])

    if (now - lastHeartbeat) > stallInterval then
        local jobKey = ARGV[3] .. jobId
        redis.call('HDEL', KEYS[1], jobId)
        redis.call('HDEL', jobKey, 'lockToken')

        local attempts = tonumber(redis.call('HGET', jobKey, 'attempts') or 0) + 1
        local maxAttempts = tonumber(redis.call('HGET', jobKey, 'maxAttempts') or 1)

        if attempts < maxAttempts then
            local priority = redis.call('HGET', jobKey, 'priority') or 5
            redis.call('HSET', jobKey, 'status', 'WAITING', 'attempts', attempts, 'lastError', 'job stalled')
            redis.call('ZADD', KEYS[2], priority, jobId)
        else
            redis.call('HSET', jobKey, 'status', 'FAILED', 'attempts', attempts,
                'failedAt', ARGV[1], 'error', cjson.encode({ message = 'job stalled more than allowable limit' }))
            redis.call('ZADD', KEYS[3], ARGV[1], jobId)
        end
        table.insert(stalled, jobId)
    end
end

return stalled
