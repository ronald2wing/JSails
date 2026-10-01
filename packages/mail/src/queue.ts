/**
 * Queued mail: hand a message to the jobs runtime and send it from a worker.
 *
 * {@link queueMail} validates the message with the same rules a transport
 * applies, encodes it as a JSON payload (attachments as base64), and
 * dispatches the {@link MAIL_SEND_JOB} job through the public `jsails/jobs`
 * service. Nothing is dispatched for an invalid message, so a bad address
 * fails in the request that produced it rather than in a worker later.
 *
 * {@link mailSendJob} is the matching job definition. The app registers it like
 * any job (a registry entry, or a `jobs/mail-send.job.ts` that default-exports
 * it); its handler decodes the payload and sends through the mail service of
 * the worker's application scope, so the worker must also run `mailPlugin`.
 * {@link createMailSendJob} binds an explicit mailer instead. A validation
 * failure in the worker is not retried; any other failure is, under the
 * queue's retry policy.
 *
 * The jobs token comes from `jsails/internal`, which loads neither the jobs
 * runtime nor its queue client, so an app that never queues mail never loads
 * them.
 */

import { currentAppScope } from 'jsails/facades';
import { jobsToken } from 'jsails/internal';
import type { JobObjectDefinition, JobsService } from 'jsails/jobs';
import type { ServiceRegistry } from 'jsails/extensions';
import { z } from 'jsails/zod';
import {
  MailError,
  MAX_MAIL_RECIPIENTS,
  validateMessage,
  type MailAddress,
  type MailAddressList,
  type MailMessage,
  type Mailer,
} from './mailer.js';
import { mailToken, type MailQueueOptions } from './service.js';

/** The job name a queued message is dispatched under. */
export const MAIL_SEND_JOB = 'mail.send';

/** The largest encoded payload a queued message may produce, in bytes. */
export const MAX_QUEUED_MAIL_BYTES: number = 5 * 1024 * 1024;

const addressSchema = z.union([
  z.string(),
  z.strictObject({ name: z.string(), address: z.string() }),
]);

const addressListSchema = z.union([addressSchema, z.array(addressSchema).max(MAX_MAIL_RECIPIENTS)]);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The payload of a {@link MAIL_SEND_JOB} job. */
export const queuedMailSchema: z.ZodObject<
  {
    mail: z.ZodOptional<z.ZodString>;
    to: z.ZodUnion<
      readonly [
        z.ZodUnion<
          readonly [
            z.ZodString,
            z.ZodObject<
              {
                name: z.ZodString;
                address: z.ZodString;
              },
              z.core.$strict
            >,
          ]
        >,
        z.ZodArray<
          z.ZodUnion<
            readonly [
              z.ZodString,
              z.ZodObject<
                {
                  name: z.ZodString;
                  address: z.ZodString;
                },
                z.core.$strict
              >,
            ]
          >
        >,
      ]
    >;
    cc: z.ZodOptional<
      z.ZodUnion<
        readonly [
          z.ZodUnion<
            readonly [
              z.ZodString,
              z.ZodObject<
                {
                  name: z.ZodString;
                  address: z.ZodString;
                },
                z.core.$strict
              >,
            ]
          >,
          z.ZodArray<
            z.ZodUnion<
              readonly [
                z.ZodString,
                z.ZodObject<
                  {
                    name: z.ZodString;
                    address: z.ZodString;
                  },
                  z.core.$strict
                >,
              ]
            >
          >,
        ]
      >
    >;
    bcc: z.ZodOptional<
      z.ZodUnion<
        readonly [
          z.ZodUnion<
            readonly [
              z.ZodString,
              z.ZodObject<
                {
                  name: z.ZodString;
                  address: z.ZodString;
                },
                z.core.$strict
              >,
            ]
          >,
          z.ZodArray<
            z.ZodUnion<
              readonly [
                z.ZodString,
                z.ZodObject<
                  {
                    name: z.ZodString;
                    address: z.ZodString;
                  },
                  z.core.$strict
                >,
              ]
            >
          >,
        ]
      >
    >;
    replyTo: z.ZodOptional<
      z.ZodUnion<
        readonly [
          z.ZodUnion<
            readonly [
              z.ZodString,
              z.ZodObject<
                {
                  name: z.ZodString;
                  address: z.ZodString;
                },
                z.core.$strict
              >,
            ]
          >,
          z.ZodArray<
            z.ZodUnion<
              readonly [
                z.ZodString,
                z.ZodObject<
                  {
                    name: z.ZodString;
                    address: z.ZodString;
                  },
                  z.core.$strict
                >,
              ]
            >
          >,
        ]
      >
    >;
    from: z.ZodOptional<
      z.ZodUnion<
        readonly [
          z.ZodString,
          z.ZodObject<
            {
              name: z.ZodString;
              address: z.ZodString;
            },
            z.core.$strict
          >,
        ]
      >
    >;
    subject: z.ZodString;
    text: z.ZodOptional<z.ZodString>;
    html: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            filename: z.ZodString;
            contentBase64: z.ZodString;
            contentType: z.ZodOptional<z.ZodString>;
          },
          z.core.$strict
        >
      >
    >;
  },
  z.core.$strict
> = z.strictObject({
  mail: z.string().max(100).optional(),
  to: addressListSchema,
  cc: addressListSchema.optional(),
  bcc: addressListSchema.optional(),
  replyTo: addressListSchema.optional(),
  from: addressSchema.optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z
    .array(
      z.strictObject({
        filename: z.string(),
        contentBase64: z.string().regex(BASE64),
        contentType: z.string().optional(),
      }),
    )
    .optional(),
});

/** A decoded {@link MAIL_SEND_JOB} payload. */
export type QueuedMail = z.infer<typeof queuedMailSchema>;

/** A fresh, JSON-safe copy of one address. */
function copyAddress(address: MailAddress): MailAddress {
  return typeof address === 'string' ? address : { name: address.name, address: address.address };
}

function copyList(list: MailAddressList): MailAddress | MailAddress[] {
  return Array.isArray(list) ? list.map(copyAddress) : copyAddress(list as MailAddress);
}

/**
 * Validate `message` and encode it as a {@link MAIL_SEND_JOB} payload. Throws
 * the validation `MailError`, or `too_large` when the encoded payload passes
 * {@link MAX_QUEUED_MAIL_BYTES}.
 */
export function encodeQueuedMail(message: MailMessage): QueuedMail {
  const validated = validateMessage(message);
  const mail = (message as { readonly mail?: unknown }).mail;
  const payload: QueuedMail = {
    ...(typeof mail === 'string' ? { mail } : {}),
    to: copyList(message.to),
    ...(message.cc === undefined ? {} : { cc: copyList(message.cc) }),
    ...(message.bcc === undefined ? {} : { bcc: copyList(message.bcc) }),
    ...(message.replyTo === undefined ? {} : { replyTo: copyList(message.replyTo) }),
    ...(message.from === undefined ? {} : { from: copyAddress(message.from) }),
    subject: validated.subject,
    ...(validated.text === undefined ? {} : { text: validated.text }),
    ...(validated.html === undefined ? {} : { html: validated.html }),
    ...(validated.attachments === undefined
      ? {}
      : {
          attachments: validated.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentBase64: Buffer.from(
              attachment.content.buffer,
              attachment.content.byteOffset,
              attachment.content.byteLength,
            ).toString('base64'),
            ...(attachment.contentType === undefined
              ? {}
              : { contentType: attachment.contentType }),
          })),
        }),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_QUEUED_MAIL_BYTES) {
    throw new MailError(
      'too_large',
      `a queued mail must encode to at most ${MAX_QUEUED_MAIL_BYTES} bytes; send large attachments inline or link to them`,
    );
  }
  return payload;
}

/** Turn a {@link MAIL_SEND_JOB} payload back into a sendable message. */
export function decodeQueuedMail(payload: QueuedMail): MailMessage {
  return {
    to: payload.to,
    ...(payload.cc === undefined ? {} : { cc: payload.cc }),
    ...(payload.bcc === undefined ? {} : { bcc: payload.bcc }),
    ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
    ...(payload.from === undefined ? {} : { from: payload.from }),
    subject: payload.subject,
    ...(payload.text === undefined ? {} : { text: payload.text }),
    ...(payload.html === undefined ? {} : { html: payload.html }),
    ...(payload.attachments === undefined
      ? {}
      : {
          attachments: payload.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: new Uint8Array(Buffer.from(attachment.contentBase64, 'base64')),
            ...(attachment.contentType === undefined
              ? {}
              : { contentType: attachment.contentType }),
          })),
        }),
  };
}

/**
 * Validate `message` and dispatch it through `jobs` as a {@link MAIL_SEND_JOB}
 * job. The dispatch options are passed through to the jobs runtime.
 */
export async function queueMail(
  jobs: JobsService,
  message: MailMessage,
  options?: MailQueueOptions,
): Promise<void> {
  const payload = encodeQueuedMail(message);
  if (options === undefined) {
    await jobs.dispatch(MAIL_SEND_JOB, payload);
  } else {
    await jobs.dispatch(MAIL_SEND_JOB, payload, options);
  }
}

/**
 * Queue `message` through the jobs service registered in `services`, failing
 * with `missing_jobs` when there is none. `services` is an application's
 * registry or a plugin's declared view of it.
 */
export async function queueMailThrough(
  services: Pick<ServiceRegistry, 'tryGet'>,
  message: MailMessage,
  options?: MailQueueOptions,
): Promise<void> {
  const jobs = services.tryGet(jobsToken);
  if (jobs === undefined) {
    throw new MailError(
      'missing_jobs',
      'queueing mail needs a jobs runtime: add jobsPlugin to plugins.use, or send the message directly',
    );
  }
  await queueMail(jobs, message, options);
}

/** Options for {@link createMailSendJob}. */
export interface MailSendJobOptions {
  /** The mailer to send through; defaults to the worker scope's mail service. */
  readonly mailer?: Mailer;
}

/** Resolve the mail service of the running job's application scope. */
function scopedMailer(): Mailer {
  const mailer = currentAppScope()?.services.tryGet(mailToken);
  if (mailer === undefined) {
    throw new MailError(
      'missing_transport',
      'the mail.send job found no mail service: run mailPlugin in the worker or bind a mailer',
    );
  }
  return mailer;
}

/**
 * Whether a worker-side failure is worth another attempt. A message the
 * validator rejects will be rejected again; a missing transport may be fixed
 * by a redeploy within the retry window, so it keeps its attempts.
 */
function retryable(error: unknown): boolean {
  return !(error instanceof MailError && error.code.startsWith('invalid_'));
}

/** Build the {@link MAIL_SEND_JOB} job definition. */
export function createMailSendJob(options: MailSendJobOptions = {}): JobObjectDefinition {
  const raw: unknown = options;
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('createMailSendJob requires an options object');
  }
  const { mailer } = options;
  if (mailer !== undefined && typeof mailer.send !== 'function') {
    throw new TypeError('mailer must implement the Mailer contract');
  }
  return Object.freeze({
    name: MAIL_SEND_JOB,
    schema: queuedMailSchema,
    handler: async (payload: QueuedMail): Promise<void> => {
      await (mailer ?? scopedMailer()).send(decodeQueuedMail(payload));
    },
    policy: Object.freeze({ retryOn: retryable }),
  });
}

/** The {@link MAIL_SEND_JOB} job, sending through the worker scope's mail service. */
export const mailSendJob: JobObjectDefinition = createMailSendJob();
