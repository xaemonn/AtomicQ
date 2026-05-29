-- KEYS[1]: jobKey
-- KEYS[2]: failedKey
-- KEYS[3]: waitingKey
-- ARGV[1]: jobId
-- ARGV[2]: now
--
-- Atomically moves a job from 'failed' back to 'waiting' with its original
-- priority score and a fresh attempt budget. Returns 1 on success, 0 if the
-- job is not in the failed set.

if redis.call('ZREM', KEYS[2], ARGV[1]) == 0 then
    return 0
end

local priority = redis.call('HGET', KEYS[1], 'priority') or 5
redis.call('HSET', KEYS[1], 'status', 'WAITING', 'attempts', '0', 'runAt', ARGV[2])
redis.call('ZADD', KEYS[3], priority, ARGV[1])

return 1
