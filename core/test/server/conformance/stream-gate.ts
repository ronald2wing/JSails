/**
 * A rendezvous between a streaming fixture and the client reading it.
 *
 * A streaming producer sends its first chunk, then waits at the gate named by
 * its request until the client reports that chunk arrived, or until a
 * generous timeout. A pipeline that streams releases the gate at once; one
 * that buffers the body cannot deliver the first chunk until the producer
 * finishes, so the producer only goes on when the timeout fires. The outcome
 * is therefore a fact about buffering, not about how loaded the machine is.
 */

/** How the producer left the gate. */
export type GateOutcome = 'released' | 'timeout';

/** How long a producer waits for its first chunk to be seen. */
export const GATE_TIMEOUT_MS = 1000;

const releases = new Map<string, () => void>();
const outcomes = new Map<string, GateOutcome>();

/** Producer side: wait until the client has the first chunk of request `id`. */
export function waitAtGate(id: string): Promise<void> {
  if (outcomes.has(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (outcome: GateOutcome): void => {
      if (outcomes.has(id)) return;
      clearTimeout(timer);
      releases.delete(id);
      outcomes.set(id, outcome);
      resolve();
    };
    const timer = setTimeout(() => finish('timeout'), GATE_TIMEOUT_MS);
    releases.set(id, () => finish('released'));
  });
}

/** Client side: the first chunk of request `id` arrived. */
export function releaseGate(id: string): void {
  const release = releases.get(id);
  if (release !== undefined) release();
  else if (!outcomes.has(id)) outcomes.set(id, 'released');
}

/** How the producer of request `id` left the gate, once it has. */
export function gateOutcome(id: string): GateOutcome | undefined {
  return outcomes.get(id);
}
