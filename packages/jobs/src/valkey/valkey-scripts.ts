/**
 * The Lua scripts of the Valkey transport, each one atomic on the server.
 *
 * BullMQ owns its queue keys and its own scripts; these scripts touch them
 * only where the contract needs a step BullMQ has no command for (failed-job
 * paging, removal that keeps deduplication keys, the test hooks), and
 * otherwise keep the transport's own records: batches, schedules and leases.
 * A value the scripts store for JavaScript (an envelope, a schedule spec, a
 * failure record) is stored and returned as an opaque string and never
 * decoded in Lua, so its numbers keep their precision.
 *
 * Replies use RESP2 conventions: a Lua `false` element is avoided (it would
 * truncate an array), so an absent value is the empty string.
 */

import type { ValkeyConnections, ValkeyScript } from 'jsails/plugin-sdk';

/** True when any queue has a job runnable now: waiting, prioritized, active, or delayed and due. */
const BUSY = `
for i = 1, #KEYS, 4 do
  if redis.call('LLEN', KEYS[i]) > 0 or redis.call('ZCARD', KEYS[i + 1]) > 0
    or redis.call('LLEN', KEYS[i + 2]) > 0
    or redis.call('ZCOUNT', KEYS[i + 3], '-inf', '(' .. ARGV[1]) > 0 then
    return 1
  end
end
return 0
`;

/** The ids of the delayed jobs due by score ARGV[1]. */
const DUE_DELAYED = `
return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
`;

/** Move a completed or failed job back to waiting, attempts kept, as a lost lock does. */
const REDELIVER = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1]) + redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 0 or redis.call('EXISTS', KEYS[5]) == 0 then return 0 end
redis.call('HDEL', KEYS[5], 'finishedOn', 'returnvalue', 'failedReason', 'processedOn')
redis.call('LPUSH', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], 0, '0')
return 1
`;

/** Delete every completed job of a queue, keeping deduplication keys, as retention does. */
const EVICT_COMPLETED = `
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  redis.call('DEL', ARGV[1] .. id, ARGV[1] .. id .. ':logs')
end
redis.call('DEL', KEYS[1])
return #ids
`;

/**
 * Create a batch record for total ARGV[1] with finalizer queue, envelope and
 * id ARGV[2..4]; ARGV[5] '1' creates it staged, expiring after ARGV[6] ms
 * unless its children are found stored. Replies the state ('new', 'staged'
 * for a staged record of this total, 'exists', or 'conflict' for another
 * total), the stored count, and the record's finalizer id.
 */
const BATCH_CLAIM = `
local total = redis.call('HGET', KEYS[1], 'total')
if not total then
  redis.call('HSET', KEYS[1], 'total', ARGV[1], 'fq', ARGV[2], 'fenv', ARGV[3], 'fid', ARGV[4],
    'staged', ARGV[5], 'stored', 0, 'n', 0, 'c', 0, 'f', 0, 's', 0, 'retried', 0, 'settled', 0,
    'released', 0)
  if ARGV[5] == '1' then redis.call('PEXPIRE', KEYS[1], ARGV[6]) end
  return {'new', '0', ARGV[4]}
end
if total ~= ARGV[1] then return {'conflict', '0', ''} end
local f = redis.call('HMGET', KEYS[1], 'staged', 'stored', 'fid')
if f[1] == '1' then return {'staged', f[2], f[3]} end
return {'exists', f[2], f[3]}
`;

/**
 * Raise the count of a batch's stored children to ARGV[1]; a staged record
 * whose children are all stored stops being staged, and keeps no expiry
 * until it settles.
 */
const BATCH_STORED = `
local f = redis.call('HMGET', KEYS[1], 'stored', 'total', 'staged', 'settled')
if not f[1] then return 0 end
if tonumber(f[1]) < tonumber(ARGV[1]) then redis.call('HSET', KEYS[1], 'stored', ARGV[1]) end
if f[3] == '1' and tonumber(ARGV[1]) >= tonumber(f[2]) then
  redis.call('HSET', KEYS[1], 'staged', 0)
  if f[4] ~= '1' then redis.call('PERSIST', KEYS[1]) end
end
return 1
`;

/**
 * The recorded indexes among a run of child indexes: '1' for a recorded
 * child, '' otherwise, so a resumed chunk skips them.
 */
const BATCH_RECORDED = `
local out = {}
for i = 1, #ARGV do
  out[i] = redis.call('HEXISTS', KEYS[1], ARGV[i]) == 1 and '1' or ''
end
return out
`;

/**
 * Record a child's first final outcome ('c', 's', or a failure record) when
 * the record is the incarnation the child was stored under (finalizer id
 * ARGV[5]). A child of a staged record ran, so the one transaction that
 * stored every child applied: the record stops being staged. The record that
 * reaches the total settles the batch and starts its retention. Replies the
 * finalizer to release while the batch is settled and its finalizer not yet
 * stored, else {0}.
 */
const BATCH_RECORD = `
local r = redis.call('HMGET', KEYS[1], 'total', 'fid', 'staged')
local total = r[1]
if not total or r[2] ~= ARGV[5] then return {0} end
if r[3] == '1' then
  redis.call('HSET', KEYS[1], 'staged', 0, 'stored', total)
  redis.call('PERSIST', KEYS[1])
end
local index = tonumber(ARGV[1])
if index >= tonumber(total) then return {0} end
if redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[2]) == 1 then
  local kind = 'f'
  if ARGV[2] == 'c' or ARGV[2] == 's' then kind = ARGV[2] end
  redis.call('HINCRBY', KEYS[1], kind, 1)
  if kind == 'f' then redis.call('ZADD', KEYS[3], index, ARGV[1]) end
  local n = redis.call('HINCRBY', KEYS[1], 'n', 1)
  if n >= tonumber(total) and redis.call('HGET', KEYS[1], 'settled') == '0' then
    redis.call('HSET', KEYS[1], 'settled', 1, 'settledAt', ARGV[3])
    for i = 1, 3 do redis.call('PEXPIRE', KEYS[i], ARGV[4]) end
  end
end
if redis.call('HGET', KEYS[1], 'settled') == '1' and redis.call('HGET', KEYS[1], 'released') == '0' then
  local f = redis.call('HMGET', KEYS[1], 'fq', 'fenv', 'fid')
  return {1, f[1], f[2], f[3]}
end
return {0}
`;

/** Mark a settled batch's finalizer stored. */
const BATCH_RELEASED = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'released', 1) end
return 1
`;

/**
 * A batch's counts in one read, or an empty reply for an unknown batch and
 * for a staged one, which is not known to be stored.
 */
const BATCH_STATUS = `
local f = redis.call('HMGET', KEYS[1], 'total', 'c', 'f', 's', 'n', 'settled', 'retried', 'staged')
if not f[1] or f[8] == '1' then return {} end
return {f[1], f[2], f[3], f[4], f[5], f[6], f[7]}
`;

/** Up to ARGV[1] failed children by ascending index, as index and failure record pairs. */
const BATCH_FAILURES = `
local indexes = redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
local out = {}
for _, index in ipairs(indexes) do
  out[#out + 1] = index
  out[#out + 1] = redis.call('HGET', KEYS[2], index) or ''
end
return out
`;

/**
 * Before a failed child of the incarnation with finalizer id ARGV[2] is
 * retried: on an unsettled batch, take back its recorded failure so its next
 * final outcome counts (replying the record, to restore should the retry not
 * happen); on a settled batch change nothing.
 */
const BATCH_UNRECORD = `
local r = redis.call('HMGET', KEYS[1], 'fid', 'settled')
if not r[1] or r[1] ~= ARGV[2] then return {'absent'} end
if r[2] == '1' then return {'settled'} end
local value = redis.call('HGET', KEYS[2], ARGV[1])
if not value or value == 'c' or value == 's' then return {'absent'} end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HINCRBY', KEYS[1], 'f', -1)
redis.call('HINCRBY', KEYS[1], 'n', -1)
return {'unrecorded', value}
`;

/** A child of the settled incarnation with finalizer id ARGV[1] was retried. */
const BATCH_RETRIED = `
local r = redis.call('HMGET', KEYS[1], 'settled', 'fid')
if r[1] == '1' and r[2] == ARGV[1] then redis.call('HINCRBY', KEYS[1], 'retried', 1) end
return 1
`;

/**
 * One queue's page of failed jobs, newest first, as id, failure time, data
 * and reason quadruples: every job at the cursor's score (ARGV[1], or
 * '+inf' for the first page), up to ARGV[2] strictly older, and every job
 * tied with the oldest of those, so ordering ties by id stays exact.
 */
const FAILED_PAGE = `
local key, prefix, limit = KEYS[1], ARGV[3], tonumber(ARGV[2])
local seen, ids = {}, {}
local function take(list)
  for i = 1, #list, 2 do
    if not seen[list[i]] then
      seen[list[i]] = true
      ids[#ids + 1] = list[i]
      ids[#ids + 1] = list[i + 1]
    end
  end
end
local older
if ARGV[1] == '+inf' then
  older = redis.call('ZREVRANGEBYSCORE', key, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, limit)
else
  take(redis.call('ZRANGEBYSCORE', key, ARGV[1], ARGV[1], 'WITHSCORES'))
  older = redis.call('ZREVRANGEBYSCORE', key, '(' .. ARGV[1], '-inf', 'WITHSCORES', 'LIMIT', 0, limit)
end
take(older)
if #older > 0 then
  local low = older[#older]
  take(redis.call('ZRANGEBYSCORE', key, low, low, 'WITHSCORES'))
end
local out = {}
for i = 1, #ids, 2 do
  local fields = redis.call('HMGET', prefix .. ids[i], 'data', 'failedReason')
  out[#out + 1] = ids[i]
  out[#out + 1] = ids[i + 1]
  out[#out + 1] = fields[1] or ''
  out[#out + 1] = fields[2] or ''
end
return out
`;

/**
 * Find job ARGV[1] on the queues whose key prefixes follow: the one-based
 * queue position, its failure time ('' when it is not in the failed set),
 * its data and its reason; {0} when no queue holds it.
 */
const FIND_JOB = `
for i = 2, #ARGV do
  local hash = ARGV[i] .. ARGV[1]
  if redis.call('EXISTS', hash) == 1 then
    local fields = redis.call('HMGET', hash, 'data', 'failedReason')
    local score = redis.call('ZSCORE', ARGV[i] .. 'failed', ARGV[1])
    return {i - 1, score or '', fields[1] or '', fields[2] or ''}
  end
end
return {0}
`;

/** Delete failed job ARGV[1] when it failed at or after ARGV[2]; its deduplication key stays. */
const REMOVE_FAILED = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) < tonumber(ARGV[2]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3])
return 1
`;

/** Delete up to ARGV[3] failed jobs that failed before ARGV[2]; deduplication keys stay. */
const PRUNE_FAILED = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[2], 'LIMIT', 0, tonumber(ARGV[3]))
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('DEL', ARGV[1] .. id, ARGV[1] .. id .. ':logs')
end
return #ids
`;

/**
 * Before a retry: reset the unknown-release count and the stall count of a
 * job still in the failed set (BullMQ's own retry resets neither).
 */
const RESET_COUNTS = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('HSET', KEYS[2], 'progress', '0')
redis.call('HDEL', KEYS[2], 'stc')
return 1
`;

/** The stored schedules: spec, paused, anchor, through and revision hashes, the set revision and stamp. */
const SCHEDULE_READ = `
return {
  redis.call('HGETALL', KEYS[1]), redis.call('HGETALL', KEYS[3]), redis.call('HGETALL', KEYS[4]),
  redis.call('HGETALL', KEYS[5]), redis.call('HGETALL', KEYS[6]),
  redis.call('HGET', KEYS[7], 'rev') or '0', redis.call('HGET', KEYS[7], 'stamp') or ''
}
`;

/**
 * Compare-and-set apply. KEYS: spec, repeat, paused, anchor, through, rev,
 * meta. ARGV: expected revision, now, the schedule limit, the stamp, the
 * upsert count, then id, spec and canonical repeat per upsert, then the
 * removed ids. Replies 1 when applied, 0 on a stale revision, -1 when the
 * set would exceed the limit.
 */
const SCHEDULE_APPLY = `
local spec, rep, paused, anchor, through, rev, meta =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]
if tonumber(redis.call('HGET', meta, 'rev') or '0') ~= tonumber(ARGV[1]) then return 0 end
local upserts = tonumber(ARGV[5])
local first_removed = 6 + upserts * 3
local added, dropped, counted = 0, 0, {}
for i = 0, upserts - 1 do
  if redis.call('HEXISTS', spec, ARGV[6 + i * 3]) == 0 then added = added + 1 end
end
for i = first_removed, #ARGV do
  if not counted[ARGV[i]] and redis.call('HEXISTS', spec, ARGV[i]) == 1 then
    counted[ARGV[i]] = true
    dropped = dropped + 1
  end
end
if redis.call('HLEN', spec) + added - dropped > tonumber(ARGV[3]) then return -1 end
for i = 0, upserts - 1 do
  local id, json, canonical = ARGV[6 + i * 3], ARGV[7 + i * 3], ARGV[8 + i * 3]
  local seq = redis.call('HINCRBY', meta, 'seq', 1)
  redis.call('HSET', spec, id, json)
  redis.call('HSET', rev, id, seq)
  if redis.call('HGET', rep, id) ~= canonical then
    redis.call('HSET', rep, id, canonical)
    redis.call('HSETNX', paused, id, '0')
    redis.call('HSET', anchor, id, ARGV[2])
    redis.call('HDEL', through, id)
  end
end
for i = first_removed, #ARGV do
  for _, key in ipairs(KEYS) do
    if key ~= meta then redis.call('HDEL', key, ARGV[i]) end
  end
end
redis.call('HSET', meta, 'stamp', ARGV[4])
redis.call('HINCRBY', meta, 'rev', 1)
if upserts > 0 or dropped > 0 then redis.call('HINCRBY', meta, 'changes', 1) end
return 1
`;

/** Pause (ARGV[1] '1') or resume ('0') the ids from ARGV[3]; a resume skips to ARGV[2]. KEYS: spec, paused, through, rev, meta. */
const SCHEDULE_PAUSE = `
local changed = false
for i = 3, #ARGV do
  local id = ARGV[i]
  if redis.call('HEXISTS', KEYS[1], id) == 1 and redis.call('HGET', KEYS[2], id) ~= ARGV[1] then
    local seq = redis.call('HINCRBY', KEYS[5], 'seq', 1)
    redis.call('HSET', KEYS[2], id, ARGV[1])
    redis.call('HSET', KEYS[4], id, seq)
    if ARGV[1] == '0' then redis.call('HSET', KEYS[3], id, ARGV[2]) end
    changed = true
  end
end
if changed then redis.call('HINCRBY', KEYS[5], 'changes', 1) end
return 1
`;

/**
 * Check, then record, a fire. When schedule ARGV[1] is unpaused at revision
 * ARGV[2] and last fired at ARGV[3] ('' for never): with ARGV[5] '0' reply
 * its spec, so the fire can be enqueued on its queue; with ARGV[5] '1' move
 * its last fire to ARGV[4] and reply 1. Otherwise reply ''.
 * KEYS: spec, paused, rev, through.
 */
const SCHEDULE_FIRE = `
local id = ARGV[1]
local spec = redis.call('HGET', KEYS[1], id)
if not spec or redis.call('HGET', KEYS[2], id) == '1' then return '' end
if redis.call('HGET', KEYS[3], id) ~= ARGV[2] then return '' end
if (redis.call('HGET', KEYS[4], id) or '') ~= ARGV[3] then return '' end
if ARGV[5] == '0' then return spec end
redis.call('HSET', KEYS[4], id, ARGV[4])
return 1
`;

/** The schedule set's change counter. */
const SCHEDULE_CHANGES = `
return redis.call('HGET', KEYS[1], 'changes') or '0'
`;

const LEASE_ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;

const LEASE_RENEW = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const LEASE_RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/** Every script, bound to the provider's shared command connection. */
export interface ValkeyScripts {
  readonly busy: ValkeyScript;
  readonly dueDelayed: ValkeyScript;
  readonly redeliver: ValkeyScript;
  readonly evictCompleted: ValkeyScript;
  readonly batchClaim: ValkeyScript;
  readonly batchStored: ValkeyScript;
  readonly batchRecorded: ValkeyScript;
  readonly batchRecord: ValkeyScript;
  readonly batchReleased: ValkeyScript;
  readonly batchStatus: ValkeyScript;
  readonly batchFailures: ValkeyScript;
  readonly batchUnrecord: ValkeyScript;
  readonly batchRetried: ValkeyScript;
  readonly failedPage: ValkeyScript;
  readonly findJob: ValkeyScript;
  readonly removeFailed: ValkeyScript;
  readonly pruneFailed: ValkeyScript;
  readonly resetCounts: ValkeyScript;
  readonly scheduleRead: ValkeyScript;
  readonly scheduleApply: ValkeyScript;
  readonly schedulePause: ValkeyScript;
  readonly scheduleFire: ValkeyScript;
  readonly scheduleChanges: ValkeyScript;
  readonly leaseAcquire: ValkeyScript;
  readonly leaseRenew: ValkeyScript;
  readonly leaseRelease: ValkeyScript;
}

/** Bind every script once per adapter. */
export function bindValkeyScripts(connections: ValkeyConnections): ValkeyScripts {
  const bind = (lua: string): ValkeyScript => connections.script({ lua });
  return Object.freeze({
    busy: bind(BUSY),
    dueDelayed: bind(DUE_DELAYED),
    redeliver: bind(REDELIVER),
    evictCompleted: bind(EVICT_COMPLETED),
    batchClaim: bind(BATCH_CLAIM),
    batchStored: bind(BATCH_STORED),
    batchRecorded: bind(BATCH_RECORDED),
    batchRecord: bind(BATCH_RECORD),
    batchReleased: bind(BATCH_RELEASED),
    batchStatus: bind(BATCH_STATUS),
    batchFailures: bind(BATCH_FAILURES),
    batchUnrecord: bind(BATCH_UNRECORD),
    batchRetried: bind(BATCH_RETRIED),
    failedPage: bind(FAILED_PAGE),
    findJob: bind(FIND_JOB),
    removeFailed: bind(REMOVE_FAILED),
    pruneFailed: bind(PRUNE_FAILED),
    resetCounts: bind(RESET_COUNTS),
    scheduleRead: bind(SCHEDULE_READ),
    scheduleApply: bind(SCHEDULE_APPLY),
    schedulePause: bind(SCHEDULE_PAUSE),
    scheduleFire: bind(SCHEDULE_FIRE),
    scheduleChanges: bind(SCHEDULE_CHANGES),
    leaseAcquire: bind(LEASE_ACQUIRE),
    leaseRenew: bind(LEASE_RENEW),
    leaseRelease: bind(LEASE_RELEASE),
  });
}
