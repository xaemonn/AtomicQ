-- KEYS[1]: cronKey (queue:name:cron)
-- ARGV[1]: jobName (hash field)
-- ARGV[2]: expected definition JSON (as read by the caller)
-- ARGV[3]: new definition JSON (with the next nextRunAt)
--
-- Compare-and-swap. Returns 1 if this caller advanced the definition and
-- therefore owns this occurrence, 0 if another scheduler got there first
-- (or the definition was changed/removed in the meantime).

if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
    return 0
end

redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
