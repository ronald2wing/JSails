/**
 * {@link AiToolFailure}: the one way a tool shows the model its own error text.
 *
 * Any other error a tool throws reaches the model as a fixed, value-free
 * result, because an exception message can carry secrets, SQL, file paths, or
 * user data. A tool that wants the model to see why it failed (so the model
 * can correct its call) throws `new AiToolFailure('the date must be in the
 * future')` with text it deliberately makes public.
 */

/** The longest public message passed to the model; longer text is cut. */
export const MAX_PUBLIC_MESSAGE_LENGTH = 2000;

/** A tool error whose message is deliberately shown to the model. */
export class AiToolFailure extends Error {
  /** The text the model sees, cut to {@link MAX_PUBLIC_MESSAGE_LENGTH} characters. */
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    const text = typeof publicMessage === 'string' ? publicMessage : '';
    super('the tool reported a failure');
    this.name = 'AiToolFailure';
    this.publicMessage = Array.from(text).slice(0, MAX_PUBLIC_MESSAGE_LENGTH).join('');
  }
}
