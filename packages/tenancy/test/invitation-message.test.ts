/**
 * Tests for invitation message composition: the plain and HTML bodies, HTML
 * escaping of every interpolation (attributes included), header-injection and
 * bidi stripping in names, quoting of every name, defanging of link-like
 * names, name truncation, URL validation, and the UTC expiry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { invitationMessage, MAX_DISPLAY_NAME_LENGTH } from '../src/invitation-message.js';
import { thrownCode } from './thrown-code.js';

/** Right-to-left override, left-to-right isolate, zero-width space and NUL. */
const INVISIBLE = String.fromCodePoint(0x202e, 0x2066, 0x200b, 0);

const base = {
  tenantName: 'Acme',
  inviterName: 'Ada',
  roleLabel: 'Admin',
  acceptUrl: 'https://acme.example.com/invitations/accept?token=jsinv_abc',
  expiresAt: new Date('2026-11-26T14:05:59.000Z'),
};

describe('invitationMessage', () => {
  it('composes subject, text and html', () => {
    const message = invitationMessage(base);
    assert.equal(message.subject, '“Ada” invited you to join “Acme”');
    assert.equal(
      message.text,
      [
        '“Ada” invited you to join “Acme” as “Admin”.',
        '',
        'Accept the invitation:',
        'https://acme.example.com/invitations/accept?token=jsinv_abc',
        '',
        'This invitation expires on 2026-11-26 14:05 UTC. If you were not expecting it, you can ignore this email.',
        '',
      ].join('\n'),
    );
    assert.ok(message.html.startsWith('<!doctype html>'));
    assert.ok(
      message.html.includes(
        '<a href="https://acme.example.com/invitations/accept?token=jsinv_abc">Accept the invitation</a>',
      ),
    );
    assert.ok(message.html.includes('<title>“Ada” invited you to join “Acme”</title>'));
    assert.ok(message.html.includes('<p>“Ada” invited you to join “Acme” as “Admin”.</p>'));
    assert.ok(Object.isFrozen(message));
  });

  it('omits the inviter and the role when they are absent or blank', () => {
    const message = invitationMessage({ ...base, inviterName: null, roleLabel: '  ' });
    assert.equal(message.subject, 'You have been invited to join “Acme”');
    assert.ok(message.text.startsWith('You have been invited to join “Acme”.\n'));
  });

  it('escapes every name in the HTML body and keeps the text body literal', () => {
    const message = invitationMessage({
      ...base,
      tenantName: '<img src=x onerror=alert(1)> & "Co" \'s',
      inviterName: '<b>Eve</b>',
      roleLabel: '<i>Boss</i>',
    });
    assert.equal(/<img|<b>|<i>/.test(message.html), false);
    assert.ok(
      message.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot; &#39;s'),
    );
    assert.ok(message.html.includes('&lt;b&gt;Eve&lt;∕b&gt;'));
    assert.ok(message.text.includes('“<b>Eve<∕b>” invited you'));
  });

  it('escapes the accept URL inside the attribute', () => {
    const message = invitationMessage({
      ...base,
      acceptUrl: 'https://acme.example.com/o\'k/"q"?a=1&b=2',
    });
    assert.ok(message.html.includes('href="https://acme.example.com/o&#39;k/%22q%22?a=1&amp;b=2"'));
    assert.equal(/o'k|&b=/.test(message.html), false);
  });

  it('strips line breaks, controls and bidi overrides from names', () => {
    const message = invitationMessage({
      ...base,
      tenantName: 'Acme\r\nBcc: victim@example.com',
      inviterName: `Ada${INVISIBLE}evil`,
    });
    assert.equal(/[\r\n]/.test(message.subject), false);
    assert.equal(message.subject, '“Ada evil” invited you to join “Acme Bcc: victim＠example․com”');
    assert.equal(/[\u202e\u2066\u200b\u0000]/u.test(message.html + message.text), false);
  });

  it('cuts long names to the display limit with an ellipsis', () => {
    const message = invitationMessage({ ...base, tenantName: 'x'.repeat(500), inviterName: null });
    const name = message.subject.slice('You have been invited to join “'.length, -1);
    assert.equal(Array.from(name).length, MAX_DISPLAY_NAME_LENGTH);
    assert.ok(name.endsWith('…'));
  });

  it('quotes every name, so a hostile inviter name reads as a name', () => {
    const message = invitationMessage({
      ...base,
      inviterName: 'Your bank security team. Click below',
    });
    assert.equal(
      message.subject,
      '“Your bank security team. Click below” invited you to join “Acme”',
    );
    assert.ok(
      message.text.startsWith('“Your bank security team. Click below” invited you to join “Acme”'),
    );
    assert.ok(message.html.includes('<p>“Your bank security team. Click below” invited you'));
  });

  it('turns curly quotes inside a name straight, so it cannot close its quotation', () => {
    const message = invitationMessage({ ...base, tenantName: 'Acme” — you won! “Prize' });
    assert.equal(message.subject, '“Ada” invited you to join “Acme" — you won! "Prize”');
  });

  it('defangs links, hosts and addresses in names so clients do not autolink them', () => {
    const message = invitationMessage({
      ...base,
      tenantName: 'Acme — claim your prize at https://evil.example/login',
      inviterName: 'support@evil.example via www.evil.example',
    });
    const all = `${message.subject}\n${message.text}\n${message.html}`.replaceAll(
      base.acceptUrl,
      '',
    );
    for (const linkable of ['https://', 'evil.example', 'www.', 'support@']) {
      assert.equal(all.includes(linkable), false, linkable);
    }
    assert.ok(message.text.includes('“Acme — claim your prize at https:∕∕evil․example∕login”'));
    assert.ok(message.subject.startsWith('“support＠evil․example via www․evil․example”'));
    // The accept URL is untouched and stays the one link.
    assert.ok(message.text.includes(base.acceptUrl));
    assert.equal(message.html.match(/<a /g)?.length, 1);
  });

  it('keeps a sentence-ending dot and ordinary punctuation in a name', () => {
    const message = invitationMessage({ ...base, tenantName: 'Acme Inc.', inviterName: 'A. B.' });
    assert.equal(message.subject, '“A. B.” invited you to join “Acme Inc.”');
  });

  it('accepts a URL object and serialises it', () => {
    const message = invitationMessage({
      ...base,
      acceptUrl: new URL('HTTPS://Acme.Example.com/a b'),
    });
    assert.ok(message.text.includes('https://acme.example.com/a%20b'));
  });

  const refusals: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an empty tenant name', { tenantName: ' \n ' }],
    ['a non-string tenant name', { tenantName: 7 }],
    ['a relative URL', { acceptUrl: '/accept' }],
    ['a javascript: URL', { acceptUrl: 'javascript:alert(1)' }],
    ['a data: URL', { acceptUrl: 'data:text/html,hi' }],
    ['a URL with credentials', { acceptUrl: 'https://user:pass@example.com/' }],
    ['an invalid date', { expiresAt: new Date(Number.NaN) }],
    ['a non-date expiry', { expiresAt: '2026-11-26' }],
  ];
  for (const [why, patch] of refusals) {
    it(`refuses ${why} with invalid_message_input`, () => {
      assert.equal(
        thrownCode(() => invitationMessage({ ...base, ...patch })),
        'invalid_message_input',
      );
    });
  }
});
