/**
 * Tests for `scripts/machine-budget.mjs`: the configuration and directory,
 * `jobShare`, grant decisions (elastic grants, the lone-request rule, the
 * live free-memory check), first-come-first-served admission, stale lock
 * breaking (including a lock whose holder is killed), dead, reused-PID and
 * heartbeat-expired leases, suspended waiters leaving and rejoining the
 * queue, the nested-holder and `JSAILS_BUDGET=off` pass-throughs, and a
 * multi-process stress run in which holders are killed while holding and the
 * concurrent sum never passes the budget.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  HEARTBEAT_STALE_MS,
  LOCK_STALE_MS,
  WAITER_STALE_MS,
  acquire,
  budgetConfig,
  budgetDir,
  decideGrant,
  jobShare,
  processStartTime,
  recordIsLive,
} from '../machine-budget.mjs';

const GIB = 1024 ** 3;
const scratch = mkdtempSync(join(tmpdir(), 'jsails-budget-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let dirCounter = 0;
function freshDir() {
  dirCounter += 1;
  const dir = join(scratch, `budget-${dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const config = { enabled: true, memoryMb: 1000, cpu: 8, reserveMb: 1024 };
/** In-process deps: one live process, plenty of free memory, a fast poll. */
function deps(dir, overrides = {}) {
  return {
    env: {},
    dir,
    config,
    availableMemory: () => 64 * GIB,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    ...overrides,
  };
}

/** A pid that no longer exists: a child that has exited. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

const leases = (dir) => readdirSync(dir).filter((name) => name.startsWith('lease-'));
const waiters = (dir) => readdirSync(dir).filter((name) => name.startsWith('wait-'));

describe('budgetConfig', () => {
  const machine = { totalMemory: 32 * GIB, constrainedMemory: 0, parallelism: 12 };

  it('takes 60% of memory, twice the parallelism and a 10% reserve by default', () => {
    assert.deepEqual(budgetConfig({}, machine), {
      enabled: true,
      memoryMb: 19660,
      cpu: 24,
      reserveMb: 3276,
    });
  });

  it('follows a lower cgroup limit and keeps at least a 1 GiB reserve', () => {
    const constrained = budgetConfig({}, { ...machine, constrainedMemory: 6 * GIB });
    assert.equal(constrained.memoryMb, 3686);
    assert.equal(constrained.reserveMb, 1024);
    const unlimited = budgetConfig({}, { ...machine, constrainedMemory: 2 ** 63 });
    assert.equal(unlimited.memoryMb, 19660);
  });

  it('takes overrides from the environment and refuses malformed ones', () => {
    const env = { JSAILS_MEMORY_BUDGET_MB: '8000', JSAILS_CPU_BUDGET: '6', JSAILS_BUDGET: 'off' };
    assert.deepEqual(budgetConfig(env, machine), {
      enabled: false,
      memoryMb: 8000,
      cpu: 6,
      reserveMb: 3276,
    });
    assert.throws(() => budgetConfig({ JSAILS_CPU_BUDGET: '0' }, machine), /positive integer/);
    assert.throws(() => budgetConfig({ JSAILS_MEMORY_BUDGET_MB: '1.5' }, machine), /positive/);
  });
});

describe('budgetDir', () => {
  const home = '/home/u';
  it('prefers JSAILS_BUDGET_DIR, then a per-user directory per platform, never tmpdir', () => {
    assert.equal(budgetDir({ JSAILS_BUDGET_DIR: '/x' }, { platform: 'linux', home }), '/x');
    assert.equal(
      budgetDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, { platform: 'linux', home }),
      join('/run/user/1000', 'jsails-budget'),
    );
    assert.equal(
      budgetDir({}, { platform: 'linux', home }),
      join(home, '.cache', 'jsails', 'budget'),
    );
    assert.equal(
      budgetDir({}, { platform: 'darwin', home }),
      join(home, 'Library', 'Caches', 'jsails', 'budget'),
    );
    assert.equal(
      budgetDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform: 'win32', home }),
      join('C:\\Users\\u\\AppData\\Local', 'jsails', 'budget'),
    );
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.ok(!budgetDir({ TMPDIR: '/tmp' }, { platform, home }).startsWith('/tmp'));
    }
  });
});

describe('jobShare', () => {
  it('takes the CPU grant passed down, else the parallelism, capped at the pool size', () => {
    assert.equal(jobShare(6, { env: {}, parallelism: 12 }), 6);
    assert.equal(jobShare(6, { env: {}, parallelism: 2 }), 2);
    assert.equal(jobShare(6, { env: { JSAILS_JOBS: '3' }, parallelism: 12 }), 3);
    assert.equal(jobShare(2, { env: { JSAILS_JOBS: '8' }, parallelism: 12 }), 2);
    assert.equal(jobShare(6, { env: { JSAILS_JOBS: 'x' }, parallelism: 1 }), 1);
  });
});

describe('decideGrant', () => {
  const request = { mb: { need: 200, want: 800 }, cpu: { need: 1, want: 6 } };
  const plenty = 64 * 1024;

  it('grants a lone request everything it wants that fits', () => {
    assert.deepEqual(decideGrant({ leases: [], config, availableMb: plenty, ...request }), {
      mb: 800,
      cpu: 6,
    });
  });

  it('admits a lone request with at least its need, even beyond the budget', () => {
    const big = { mb: { need: 4000, want: 6000 }, cpu: { need: 10, want: 12 } };
    assert.deepEqual(decideGrant({ leases: [], config, availableMb: 0, ...big }), {
      mb: 4000,
      cpu: 10,
    });
  });

  it('shares what is free between need and want, and waits when need does not fit', () => {
    const held = [{ mb: 500, cpu: 4 }];
    assert.deepEqual(decideGrant({ leases: held, config, availableMb: plenty, ...request }), {
      mb: 500,
      cpu: 4,
    });
    const full = [{ mb: 900, cpu: 1 }];
    assert.equal(decideGrant({ leases: full, config, availableMb: plenty, ...request }), undefined);
    const busy = [{ mb: 100, cpu: 8 }];
    assert.equal(decideGrant({ leases: busy, config, availableMb: plenty, ...request }), undefined);
  });

  it('keeps the live free memory above the reserve', () => {
    const held = [{ mb: 100, cpu: 1 }];
    // 1300 MiB free, 1024 reserved: 276 fit.
    assert.deepEqual(decideGrant({ leases: held, config, availableMb: 1300, ...request }), {
      mb: 276,
      cpu: 6,
    });
    assert.equal(decideGrant({ leases: held, config, availableMb: 1100, ...request }), undefined);
  });
});

describe('recordIsLive', () => {
  const live = { now: () => 1_000_000, alive: () => true, startTime: () => '42' };

  it('is dead when the process is gone or its start time changed', () => {
    assert.equal(recordIsLive({ pid: 7, start: '42' }, 0, live), true);
    assert.equal(recordIsLive({ pid: 7, start: '41' }, 0, live), false);
    assert.equal(recordIsLive({ pid: 7, start: '42' }, 0, { ...live, alive: () => false }), false);
    assert.equal(recordIsLive({ start: '42' }, 0, live), false);
  });

  it('falls back to the heartbeat where no start time can be read', () => {
    const noStart = { ...live, startTime: () => null };
    const now = noStart.now();
    assert.equal(recordIsLive({ pid: 7, start: null }, now - HEARTBEAT_STALE_MS, noStart), true);
    assert.equal(
      recordIsLive({ pid: 7, start: null }, now - HEARTBEAT_STALE_MS - 1, noStart),
      false,
    );
  });
});

describe('acquire', () => {
  it('serves waiters first come, first served, even within one millisecond', async () => {
    const dir = freshDir();
    // A frozen clock: every request is made in the same millisecond.
    const frozen = Date.now();
    const at = (overrides = {}) => deps(dir, { now: () => frozen, ...overrides });
    const first = await acquire({ label: 'a', mb: { need: 800 } }, at());
    const order = [];
    const second = acquire({ label: 'b', mb: { need: 500 } }, at()).then((grant) => {
      order.push('b');
      return grant;
    });
    // Let b queue before c, which alone would fit beside a.
    while (waiters(dir).length === 0) await new Promise((resolve) => setImmediate(resolve));
    const third = acquire({ label: 'c', mb: { need: 100 } }, at()).then((grant) => {
      order.push('c');
      return grant;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, [], 'c went ahead of b, or b was admitted beside a');
    first.release();
    const [b, c] = await Promise.all([second, third]);
    assert.deepEqual(order, ['b', 'c']);
    assert.equal(b.mb, 500);
    assert.equal(c.mb, 100);
    b.release();
    c.release();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('grants elastically and passes the grant down', async () => {
    const dir = freshDir();
    const alone = await acquire(
      { mb: { need: 100, want: 2000 }, cpu: { need: 1, want: 6 } },
      deps(dir, { pid: process.pid }),
    );
    assert.equal(alone.mb, 1000);
    assert.equal(alone.cpu, 6);
    assert.deepEqual(alone.env, { JSAILS_BUDGET_HOLDER: String(process.pid), JSAILS_JOBS: '6' });
    assert.equal(alone.nested, false);
    // The lone holder took everything, so the next one waits for it.
    let beside;
    const pending = acquire({ mb: { need: 100, want: 2000 }, cpu: { want: 4 } }, deps(dir)).then(
      (grant) => {
        beside = grant;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(beside, undefined);
    alone.release();
    await pending;
    assert.deepEqual([beside.mb, beside.cpu], [1000, 4]);
    beside.release();
  });

  it('admits beside a holder only within the live free memory', async () => {
    const dir = freshDir();
    let free = 1100 * 1024 * 1024;
    const options = deps(dir, { availableMemory: () => free });
    const first = await acquire({ mb: { need: 100 } }, options);
    let second;
    const pending = acquire({ mb: { need: 200 } }, options).then((grant) => {
      second = grant;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(second, undefined, 'admitted with only 76 MiB above the reserve');
    free = 4 * GIB;
    await pending;
    assert.equal(second.mb, 200);
    first.release();
    second.release();
  });

  it('reaps a lease whose process is gone, or whose pid was reused', async () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, 'lease-1-dead.json'),
      JSON.stringify({ pid: await deadPid(), start: null, mb: 1000, cpu: 8, at: 0 }),
    );
    writeFileSync(
      join(dir, 'lease-2-reused.json'),
      JSON.stringify({ pid: process.pid, start: 'earlier', mb: 1000, cpu: 8, at: 0 }),
    );
    const grant = await acquire(
      { mb: { need: 600 } },
      deps(dir, { startTime: () => 'now', sleep: () => new Promise((r) => setTimeout(r, 5)) }),
    );
    assert.equal(grant.mb, 600);
    assert.deepEqual(leases(dir).length, 1);
    grant.release();
  });

  it('reaps a lease whose heartbeat stopped where no start time can be read', async () => {
    const dir = freshDir();
    const lease = join(dir, 'lease-1-quiet.json');
    writeFileSync(
      lease,
      JSON.stringify({ pid: process.pid, start: null, mb: 1000, cpu: 8, at: 0 }),
    );
    let now = Date.now();
    const options = deps(dir, { startTime: () => null, now: () => now });
    let grant;
    const pending = acquire({ mb: { need: 600 } }, options).then((value) => {
      grant = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(grant, undefined, 'a lease with a fresh heartbeat was reaped');
    now += HEARTBEAT_STALE_MS + 1000;
    await pending;
    assert.equal(existsSync(lease), false);
    grant.release();
  });

  it('drops a waiter that stopped polling, though its process lives, and keeps such a lease', async () => {
    const dir = freshDir();
    const stale = new Date(Date.now() - WAITER_STALE_MS - 1000);
    // A suspended process: alive, with its recorded start time, but silent.
    const suspended = { pid: process.pid, start: 'same', label: 'stopped', at: 0 };
    const waiter = join(dir, `wait-${'0'.repeat(15)}-000000000-${process.pid}-stopped.json`);
    writeFileSync(waiter, JSON.stringify({ ...suspended, mb: { need: 1, want: 1 } }));
    const lease = join(dir, `lease-${process.pid}-stopped.json`);
    writeFileSync(lease, JSON.stringify({ ...suspended, mb: 100, cpu: 1 }));
    utimesSync(waiter, stale, stale);
    utimesSync(lease, stale, stale);
    const grant = await acquire(
      { mb: { need: 100 } },
      { ...deps(dir, { startTime: () => 'same' }), signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(existsSync(waiter), false);
    assert.equal(existsSync(lease), true, 'a suspended holder still holds its memory');
    grant.release();
  });

  it('rejoins the queue when it was dropped while suspended', async () => {
    const dir = freshDir();
    const holder = await acquire({ mb: { need: 900 } }, deps(dir));
    const waiting = acquire(
      { mb: { need: 500 } },
      { ...deps(dir), signal: AbortSignal.timeout(10_000) },
    );
    while (waiters(dir).length === 0) await new Promise((resolve) => setImmediate(resolve));
    const [name] = waiters(dir);
    rmSync(join(dir, name));
    const deadline = Date.now() + 5000;
    while (!existsSync(join(dir, name))) {
      if (Date.now() > deadline) {
        holder.release();
        await assert.rejects(waiting, { name: 'TimeoutError' });
        assert.fail('the dropped waiter never wrote its record again');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    holder.release();
    const grant = await waiting;
    assert.equal(grant.mb, 500);
    grant.release();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('breaks a lock whose owner is dead or that is too old', async () => {
    const dir = freshDir();
    mkdirSync(join(dir, 'lock'));
    writeFileSync(
      join(dir, 'lock', 'owner'),
      JSON.stringify({ pid: await deadPid(), start: null }),
    );
    const first = await acquire({ mb: { need: 10 } }, deps(dir));
    first.release();

    mkdirSync(join(dir, 'lock'));
    writeFileSync(join(dir, 'lock', 'owner'), JSON.stringify({ pid: process.pid, start: null }));
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
    utimesSync(join(dir, 'lock'), old, old);
    const second = await acquire({ mb: { need: 10 } }, deps(dir));
    second.release();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('breaks the lock of a holder killed while holding it', async (t) => {
    const dir = freshDir();
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { mkdirSync, writeFileSync } from 'node:fs';
         import { processStartTime } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'machine-budget.mjs')).href)};
         mkdirSync(${JSON.stringify(join(dir, 'lock'))});
         writeFileSync(${JSON.stringify(join(dir, 'lock', 'owner'))}, JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) }));
         process.stdout.write('locked\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    t.after(() => holder.kill('SIGKILL'));
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    const started = Date.now();
    const grant = await acquire({ mb: { need: 10 } }, deps(dir));
    assert.ok(Date.now() - started < LOCK_STALE_MS, 'waited for the lock to age instead');
    grant.release();
  });

  it('takes no lease under a live holder, and one under a dead holder', async () => {
    const dir = freshDir();
    const nested = await acquire(
      { mb: { need: 100, want: 300 }, cpu: { want: 8 } },
      deps(dir, { env: { JSAILS_BUDGET_HOLDER: String(process.ppid), JSAILS_JOBS: '3' } }),
    );
    assert.deepEqual([nested.nested, nested.mb, nested.cpu], [true, 300, 3]);
    assert.deepEqual(nested.env, {});
    assert.deepEqual(readdirSync(dir), []);
    const orphan = await acquire(
      { mb: { need: 100 } },
      deps(dir, { env: { JSAILS_BUDGET_HOLDER: String(await deadPid()) } }),
    );
    assert.equal(orphan.nested, false);
    assert.equal(leases(dir).length, 1);
    orphan.release();
  });

  it('takes no lease with JSAILS_BUDGET=off', async () => {
    const dir = freshDir();
    const grant = await acquire(
      { mb: { need: 100, want: 200 }, cpu: { want: 5 } },
      deps(dir, { config: { ...config, enabled: false } }),
    );
    assert.deepEqual([grant.nested, grant.mb, grant.cpu], [false, 200, 5]);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('stops waiting when aborted and leaves nothing behind', async () => {
    const dir = freshDir();
    const holder = await acquire({ mb: { need: 900 } }, deps(dir));
    const controller = new AbortController();
    const waiting = acquire({ mb: { need: 500 } }, { ...deps(dir), signal: controller.signal });
    while (waiters(dir).length === 0) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(waiters(dir).length, 0);
    holder.release();
  });

  it(
    'reads a start time on Linux and none elsewhere',
    { skip: process.platform !== 'linux' && 'reads /proc' },
    () => {
      assert.match(String(processStartTime(process.pid)), /^\d+$/);
      assert.equal(processStartTime(process.pid, { platform: 'darwin' }), null);
    },
  );
});

describe('many processes against one budget', () => {
  it('admits every one, never holds more than the budget, and survives holders killed while holding', async () => {
    const dir = freshDir();
    const log = join(scratch, `stress-${Date.now()}.log`);
    writeFileSync(log, '');
    const module = pathToFileURL(join(import.meta.dirname, '..', 'machine-budget.mjs')).href;
    const child = (index) =>
      new Promise((resolve) => {
        const killSelf = index === 3 || index === 8;
        const body = `
          import { appendFileSync } from 'node:fs';
          import { acquire } from ${JSON.stringify(module)};
          const grant = await acquire({ label: 'stress-${index}', mb: { need: 300 }, cpu: { need: 1 } });
          appendFileSync(${JSON.stringify(log)}, \`+ ${index} \${grant.mb} \${performance.timeOrigin + performance.now()}\\n\`);
          await new Promise((resolve) => setTimeout(resolve, 120));
          appendFileSync(${JSON.stringify(log)}, \`- ${index} \${grant.mb} \${performance.timeOrigin + performance.now()}\\n\`);
          ${killSelf ? "process.kill(process.pid, 'SIGKILL');" : ''}
          grant.release();`;
        const proc = spawn(process.execPath, ['--input-type=module', '-e', body], {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            JSAILS_BUDGET_DIR: dir,
            JSAILS_MEMORY_BUDGET_MB: '1000',
            JSAILS_CPU_BUDGET: '64',
            JSAILS_BUDGET_HOLDER: '',
            JSAILS_BUDGET: '',
          },
        });
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        proc.on('exit', (code, signal) => resolve({ index, code, signal, stderr }));
      });
    const started = Date.now();
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => child(index)));
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    for (const outcome of outcomes) {
      const killed = outcome.index === 3 || outcome.index === 8;
      if (killed) assert.ok(outcome.signal === 'SIGKILL' || outcome.code !== 0, outcome.stderr);
      else assert.equal(outcome.code, 0, outcome.stderr);
    }
    const events = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [kind, index, mb, at] = line.split(' ');
        return { kind, index: Number(index), mb: Number(mb), at: Number(at) };
      })
      .sort((a, b) => a.at - b.at || (a.kind === '-' ? -1 : 1));
    assert.equal(events.filter((event) => event.kind === '+').length, 12);
    let held = 0;
    let worst = 0;
    for (const event of events) {
      held += event.kind === '+' ? event.mb : -event.mb;
      worst = Math.max(worst, held);
    }
    assert.ok(worst <= 1000, `held ${worst} MiB at once against a budget of 1000`);
    assert.equal(leases(dir).length <= 2, true, 'only killed holders may leave a lease behind');
  });
});
