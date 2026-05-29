--[[
  cleanup.lua — Prune old completed/failed/cancelled jobs from a sorted set.

  KEYS[1] = setKey      (e.g. queue:myq:completed)
  KEYS[2] = jobPrefix   (prefix for job hashes, e.g. "queue:myq:jobs:")

  ARGV[1] = maxAge      (ms; remove jobs older than now-maxAge, 0 = skip)
  ARGV[2] = maxCount    (keep only last N entries; 0 = skip)
  ARGV[3] = now         (current timestamp in ms)

  Returns: number of jobs deleted
]]

local setKey    = KEYS[1]
local jobPrefix = KEYS[2]

local maxAge   = tonumber(ARGV[1])
local maxCount = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

local deleted = 0
local toDelete = {}

-- 1. Collect entries older than maxAge (score = completedAt timestamp)
if maxAge and maxAge > 0 then
  local cutoff = now - maxAge
  -- ZRANGEBYSCORE returns members with score <= cutoff (oldest first)
  local old = redis.call("ZRANGEBYSCORE", setKey, "-inf", cutoff)
  for _, jobId in ipairs(old) do
    table.insert(toDelete, jobId)
  end
end

-- 2. Collect entries exceeding maxCount (oldest beyond the keep window)
if maxCount and maxCount > 0 then
  local total = redis.call("ZCARD", setKey)
  if total > maxCount then
    local excess = total - maxCount
    -- Get the oldest excess entries (lowest scores = oldest completions)
    local overflow = redis.call("ZRANGE", setKey, 0, excess - 1)
    for _, jobId in ipairs(overflow) do
      table.insert(toDelete, jobId)
    end
  end
end

-- 3. Deduplicate and delete
local seen = {}
for _, jobId in ipairs(toDelete) do
  if not seen[jobId] then
    seen[jobId] = true
    redis.call("ZREM", setKey, jobId)
    redis.call("DEL", jobPrefix .. jobId)
    deleted = deleted + 1
  end
end

return deleted
