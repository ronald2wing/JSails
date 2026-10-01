/**
 * Queued mail tests: a message is validated before dispatch, dispatched as the
 * `mail.send` job through the public jobs service (a `createFakeJobs` recorder
 * validating against a registry holding `mailSendJob`), round-trips through
 * the payload with its attachments, and is sent by the job handler through the
 * worker scope's mail service. Without a jobs service, queueing fails with
 * `missing_jobs`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { definePlugin, runExtensions } from 'jsails/extensions';
import { FacadeError, withAppScope } from 'jsails/facades';
import {
  createJobRegistry,
  jobsToken,
  type JobContext,
  type JobObjectDefinition,
} from 'jsails/jobs';
import { createFakeJobs, type FakeJobs } from 'jsails/testing';

import {
  CallbackMailTransport,
  createMailSendJob,
  decodeQueuedMail,
  defineMail,
  encodeQueuedMail,
  InMemoryMailTransport,
  Mail,
  MAIL_SEND_JOB,
  MailError,
  mailPlugin,
  mailSendJob,
  mailToken,
  MAX_QUEUED_MAIL_BYTES,
  queueMail,
  type MailService,
  type QueuedMail,
  type ValidatedMail,
} from '../src/index.js';

const MESSAGE = { to: 'ada@example.com', subject: 'hello', text: 'plain body' };

function fakeJobs(): FakeJobs {
  return createFakeJobs({ registry: createJobRegistry({ [MAIL_SEND_JOB]: mailSendJob }) });
}

/** A plugin that provides `jobs` under the real jobs token. */
function jobsProvider(jobs: FakeJobs) {
  return definePlugin({
    name: 'fake-jobs',
    setup({ services }) {
      services.provide(jobsToken, jobs);
    },
  });
}

const CONTEXT: JobContext = {
  jobId: '1',
  name: MAIL_SEND_JOB,
  attemptsMade: 0,
  attemptsStarted: 1,
  log: async () => undefined,
  updateProgress: async () => undefined,
};

function mailError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof MailError && error.code === code;
}

describe('encodeQueuedMail / decodeQueuedMail', () => {
  it('round-trips every field, attachments as base64', () => {
    const message = {
      to: ['ada@example.com', { name: 'Grace', address: 'grace@example.com' }],
      cc: 'cc@example.com',
      bcc: { name: 'B', address: 'b@example.com' },
      replyTo: 'reply@example.com',
      from: { name: 'App', address: 'no-reply@example.com' },
      subject: 'hello',
      text: 'plain',
      html: '<p>plain</p>',
      attachments: [
        { filename: 'a.txt', content: 'hi', contentType: 'text/plain' },
        { filename: 'b.bin', content: new Uint8Array([0, 255, 7]) },
      ],
    };
    const payload = encodeQueuedMail(message);
    assert.equal(payload.attachments?.[0]?.contentBase64, 'aGk=');
    // The payload survives a JSON round trip, as a queue backend stores it.
    const decoded = decodeQueuedMail(JSON.parse(JSON.stringify(payload)) as QueuedMail);
    assert.deepEqual(decoded.to, message.to);
    assert.deepEqual(decoded.bcc, message.bcc);
    assert.deepEqual(decoded.from, message.from);
    assert.deepEqual(
      decoded.attachments?.map((attachment) => [...(attachment.content as Uint8Array)]),
      [
        [104, 105],
        [0, 255, 7],
      ],
    );
    assert.equal(decoded.attachments?.[0]?.contentType, 'text/plain');
  });

  it('validates before encoding', () => {
    assert.throws(
      () => encodeQueuedMail({ to: 'Eve <eve@evil.test>', subject: 'x' }),
      mailError('invalid_address'),
    );
    assert.throws(
      () => encodeQueuedMail({ to: 'a@example.com', subject: 'a\nb' }),
      mailError('invalid_subject'),
    );
  });

  it('refuses a payload past the size cap', () => {
    const content = new Uint8Array(MAX_QUEUED_MAIL_BYTES);
    assert.throws(
      () => encodeQueuedMail({ ...MESSAGE, attachments: [{ filename: 'big.bin', content }] }),
      mailError('too_large'),
    );
  });

  it('carries the template name of a mailable', () => {
    const Hello = defineMail<object>('hello', { subject: 'Hi', render: () => <p>Hi</p> });
    const payload = encodeQueuedMail(Hello.message({ to: 'ada@example.com' }, {}));
    assert.equal(payload.mail, 'hello');
  });
});

describe('queueMail', () => {
  it('dispatches the mail.send job with a schema-valid payload and options', async () => {
    const jobs = fakeJobs();
    await queueMail(jobs, MESSAGE);
    await queueMail(jobs, MESSAGE, { delay: 1000 });
    jobs.assertDispatchedTimes(MAIL_SEND_JOB, 2);
    assert.deepEqual(jobs.dispatched[0]?.payload, MESSAGE);
    assert.equal(jobs.dispatched[0]?.options, undefined);
    assert.deepEqual(jobs.dispatched[1]?.options, { delay: 1000 });
  });

  it('dispatches nothing for an invalid message', async () => {
    const jobs = fakeJobs();
    await assert.rejects(queueMail(jobs, { to: '', subject: 'x' }), mailError('invalid_address'));
    jobs.assertNothingDispatched();
  });
});

describe('mail service queue', () => {
  it('queues through the jobs service of the same application', async () => {
    const jobs = fakeJobs();
    // The jobs provider is declared after mail: resolution happens at call time.
    const runtime = await runExtensions([mailPlugin({ allowMemory: true }), jobsProvider(jobs)]);
    try {
      const service = runtime.services.get(mailToken) as MailService;
      await service.queue(MESSAGE);
      jobs.assertDispatched(
        MAIL_SEND_JOB,
        (payload) => (payload as QueuedMail).subject === 'hello',
      );
    } finally {
      await runtime.close();
    }
  });

  it('fails with missing_jobs when no jobs runtime is configured', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
    try {
      const service = runtime.services.get(mailToken) as MailService;
      await assert.rejects(service.queue(MESSAGE), mailError('missing_jobs'));
    } finally {
      await runtime.close();
    }
  });

  it('Mail.queue dispatches inside an application scope', async () => {
    const jobs = fakeJobs();
    const runtime = await runExtensions([mailPlugin({ allowMemory: true }), jobsProvider(jobs)]);
    try {
      await withAppScope(runtime.services, () => Mail.queue(MESSAGE, { attempts: 2 }));
      jobs.assertDispatchedTimes(MAIL_SEND_JOB, 1);
      assert.deepEqual(jobs.dispatched[0]?.options, { attempts: 2 });
    } finally {
      await runtime.close();
    }
  });

  it('Mail.queue fails with no_app_scope outside a scope', async () => {
    await assert.rejects(
      Mail.queue(MESSAGE),
      (error: unknown) => error instanceof FacadeError && error.code === 'no_app_scope',
    );
  });
});

describe('mailSendJob', () => {
  /** Run the job's handler the way a worker would: schema first. */
  async function run(definition: JobObjectDefinition, payload: unknown): Promise<void> {
    await definition.handler(definition.schema.parse(payload), CONTEXT);
  }

  it('sends through the worker scope mail service', async () => {
    const transport = new InMemoryMailTransport();
    const runtime = await runExtensions([mailPlugin({ transport })]);
    try {
      await withAppScope(runtime.services, () => run(mailSendJob, encodeQueuedMail(MESSAGE)));
      assert.deepEqual(
        transport.messages().map((message) => [message.to, message.subject, message.text]),
        [['ada@example.com', 'hello', 'plain body']],
      );
    } finally {
      await runtime.close();
      await transport.close();
    }
  });

  it('sends through an explicitly bound mailer', async () => {
    const sent: ValidatedMail[] = [];
    const job = createMailSendJob({
      mailer: new CallbackMailTransport((message) => {
        sent.push(message);
      }),
    });
    assert.equal(job.name, MAIL_SEND_JOB);
    await run(job, encodeQueuedMail(MESSAGE));
    assert.equal(sent.length, 1);
  });

  it('fails without a mail service in the worker scope', async () => {
    await assert.rejects(
      run(mailSendJob, encodeQueuedMail(MESSAGE)),
      mailError('missing_transport'),
    );
  });

  it('rejects an unknown payload field at the schema', () => {
    assert.throws(() => mailSendJob.schema.parse({ ...MESSAGE, extra: true }));
  });

  it('does not retry a message the validator rejects', () => {
    const retryOn = mailSendJob.policy?.retryOn;
    assert.equal(typeof retryOn, 'function');
    assert.equal(retryOn?.(new MailError('invalid_address', 'x'), CONTEXT), false);
    assert.equal(retryOn?.(new MailError('transport_failed', 'x'), CONTEXT), true);
    assert.equal(retryOn?.(new Error('boom'), CONTEXT), true);
  });

  it('rejects a malformed explicit mailer', () => {
    assert.throws(() => createMailSendJob({ mailer: {} as never }), TypeError);
  });
});
