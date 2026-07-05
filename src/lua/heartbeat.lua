-- KEYS[1]: activeKey (queue:name:active)
-- KEYS[2]: jobKey    (queue:name:jobs:id)
-- ARGV[1]: jobId
-- ARGV[2]: now
-- ARGV[3]: lockToken
--
-- Refreshes the job's heartbeat in the active hash. Returns 1 on success, 0 if
-- the caller no longer owns the job (cancelled, or stall-recovered and claimed
-- by another worker) — a stale owner must not keep someone else's job alive.

if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1
   and redis.call('HGET', KEYS[2], 'lockToken') == ARGV[3] then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    return 1
end

return 0
