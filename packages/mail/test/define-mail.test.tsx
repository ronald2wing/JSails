/**
 * `defineMail` tests: rendering through Preact escapes every prop, the text
 * part is derived or explicit, a mailable is an ordinary message, and a
 * malformed definition or subject is refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineMail } from '../src/define-mail.js';
import { MailError, validateMessage } from '../src/mailer.js';

interface WelcomeProps {
  readonly name: string;
  readonly url: string;
}

const Welcome = defineMail<WelcomeProps>('welcome', {
  subject: (props) => `Welcome, ${props.name}`,
  render: (props) => (
    <div>
      <h1>Hello {props.name}</h1>
      <p>
        Start at <a href={props.url}>your dashboard</a>.
      </p>
    </div>
  ),
  preview: { name: 'Ada', url: 'https://example.com/home' },
});

describe('defineMail', () => {
  it('renders the subject, HTML, and a derived text part', () => {
    const rendered = Welcome.render({ name: 'Ada', url: 'https://example.com/home' });
    assert.equal(rendered.subject, 'Welcome, Ada');
    assert.equal(
      rendered.html,
      '<div><h1>Hello Ada</h1><p>Start at <a href="https://example.com/home">your dashboard</a>.</p></div>',
    );
    assert.equal(rendered.text, 'Hello Ada\n\nStart at your dashboard (https://example.com/home).');
  });

  it('escapes props in text and attributes', () => {
    const rendered = Welcome.render({
      name: '<script>alert(1)</script>',
      url: '"><img src=x onerror=alert(1)>',
    });
    // Preact escapes `<`, `&`, and (in attributes) `"`, so no tag or attribute
    // can be opened or closed by a prop.
    assert.equal(
      rendered.html,
      '<div><h1>Hello &lt;script>alert(1)&lt;/script></h1><p>Start at <a href="&quot;>&lt;img src=x onerror=alert(1)>">your dashboard</a>.</p></div>',
    );
    // The derived text decodes the entities back to the literal characters.
    assert.equal(
      rendered.text,
      'Hello <script>alert(1)</script>\n\nStart at your dashboard ("><img src=x onerror=alert(1)>).',
    );
  });

  it('uses an explicit text part when given', () => {
    const Receipt = defineMail<{ readonly total: string }>('receipt', {
      subject: 'Your receipt',
      render: (props) => <p>Total {props.total}</p>,
      text: (props) => `Total: ${props.total}`,
    });
    assert.deepEqual(Receipt.render({ total: '$5' }), {
      subject: 'Your receipt',
      html: '<p>Total $5</p>',
      text: 'Total: $5',
    });
    assert.equal(Receipt.preview, undefined);
  });

  it('prefixes a doctype only to a full document', () => {
    const Doc = defineMail<object>('doc', {
      subject: 'Doc',
      render: () => (
        <html>
          <head>
            <title>Ignored in text</title>
          </head>
          <body>
            <p>Body</p>
          </body>
        </html>
      ),
    });
    const rendered = Doc.render({});
    assert.ok(rendered.html.startsWith('<!DOCTYPE html><html>'));
    assert.equal(rendered.text, 'Body');
  });

  it('builds a mailable that validates as an ordinary message', () => {
    const mailable = Welcome.message(
      { to: { name: 'Ada', address: 'ada@example.com' }, cc: 'ops@example.com' },
      { name: 'Ada', url: 'https://example.com/home' },
    );
    assert.equal(mailable.mail, 'welcome');
    assert.equal(mailable.subject, 'Welcome, Ada');
    const validated = validateMessage(mailable);
    assert.equal(validated.to, '"Ada" <ada@example.com>');
    assert.equal(validated.cc, 'ops@example.com');
    assert.equal(validated.html, mailable.html);
    assert.ok(Object.isFrozen(mailable));
  });

  it('refuses a subject with a line break or no content', () => {
    const Bad = defineMail<{ readonly subject: string }>('bad', {
      subject: (props) => props.subject,
      render: () => <p>x</p>,
    });
    for (const subject of ['', '  ', 'a\r\nBcc: eve@evil.test']) {
      assert.throws(
        () => Bad.render({ subject }),
        (error: unknown) =>
          error instanceof MailError &&
          error.code === 'invalid_subject' &&
          !error.message.includes('evil'),
      );
    }
  });

  it('rejects a malformed definition', () => {
    const render = () => <p>x</p>;
    assert.throws(() => defineMail('', { subject: 's', render }), TypeError);
    assert.throws(() => defineMail('has space', { subject: 's', render }), TypeError);
    assert.throws(() => defineMail('a'.repeat(101), { subject: 's', render }), TypeError);
    assert.throws(() => defineMail('ok', null as never), TypeError);
    assert.throws(() => defineMail('ok', { subject: 1, render } as never), TypeError);
    assert.throws(() => defineMail('ok', { subject: 's' } as never), TypeError);
    assert.throws(() => defineMail('ok', { subject: 's', render, text: 'x' } as never), TypeError);
  });
});
