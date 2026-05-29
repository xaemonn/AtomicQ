local activeKey = KEYS[1]
local jobId = ARGV[1]
local now = ARGV[2]

-- Update the heartbeat timestamp in the active hash
if redis.call('HEXISTS', activeKey, jobId) == 1 then
    redis.call('HSET', activeKey, jobId, now)
    return 1
end

return 0
