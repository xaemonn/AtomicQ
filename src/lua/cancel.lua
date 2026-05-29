-- KEYS[1]: jobKey
-- KEYS[2]: activeKey
-- KEYS[3]: waitingKey
-- KEYS[4]: cancelledKey
-- KEYS[5]: delayedKey
-- ARGV[1]: jobId
-- ARGV[2]: now
--
-- Returns 1 if the job was cancelled, 0 if it does not exist or is already
-- in a terminal state (COMPLETED / FAILED / CANCELLED).

local jobKey = KEYS[1]
local jobId = ARGV[1]
local now = ARGV[2]

local status = redis.call('HGET', jobKey, 'status')
if not status or status == 'COMPLETED' or status == 'FAILED' or status == 'CANCELLED' then
    return 0
end

-- Remove from every non-terminal location
redis.call('ZREM', KEYS[3], jobId)
redis.call('ZREM', KEYS[5], jobId)
redis.call('HDEL', KEYS[2], jobId)

-- Finalize status; dropping the lock token makes a running worker's
-- complete/fail call a no-op
redis.call('HSET', jobKey, 'status', 'CANCELLED', 'cancelledAt', now)
redis.call('HDEL', jobKey, 'lockToken')
redis.call('ZADD', KEYS[4], now, jobId)

return 1
