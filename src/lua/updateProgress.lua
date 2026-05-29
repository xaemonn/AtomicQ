local jobKey = KEYS[1]
local progress = ARGV[1]

-- Update the progress field in the job hash
if redis.call('EXISTS', jobKey) == 1 then
    redis.call('HSET', jobKey, 'progress', progress)
    return 1
end

return 0
