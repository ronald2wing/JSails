/**
 * `htmlToText` tests: block structure becomes line breaks, links keep their
 * target, hidden content is dropped, and entities are decoded exactly once.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToText } from '../src/html-text.js';

describe('htmlToText', () => {
  it('turns blocks, breaks, and list items into lines', () => {
    assert.equal(
      htmlToText('<h1>Title</h1><p>One<br/>Two</p><ul><li>a</li><li>b</li></ul><p>End</p>'),
      'Title\n\nOne\nTwo\n\n- a\n- b\n\nEnd',
    );
  });

  it('collapses source whitespace like a browser', () => {
    assert.equal(htmlToText('<p>  many\n\n   spaces\there </p>'), 'many spaces here');
  });

  it('keeps a link target unless it repeats the label or is a fragment', () => {
    assert.equal(
      htmlToText('<p><a href="https://example.com/a?x=1&amp;y=2">Open</a></p>'),
      'Open (https://example.com/a?x=1&y=2)',
    );
    assert.equal(
      htmlToText('<a href="https://example.com">https://example.com</a>'),
      'https://example.com',
    );
    assert.equal(htmlToText('<a href="#top">Top</a>'), 'Top');
  });

  it('drops head, style, script, and title content', () => {
    assert.equal(
      htmlToText(
        '<html><head><title>T</title><style>p{color:red}</style></head><body><script>x()</script><p>Body</p></body></html>',
      ),
      'Body',
    );
  });

  it('decodes entities once, so escaped markup stays literal text', () => {
    assert.equal(
      htmlToText('<p>&lt;b&gt; &amp;amp; &quot;q&quot; &#39;s&#39; &#x263A;</p>'),
      '<b> &amp; "q" \'s\' ☺',
    );
    assert.equal(htmlToText('<p>&unknown; &#0; &#x110000;</p>'), '&unknown; &#0; &#x110000;');
  });

  it('does not end a tag at a > inside a quoted attribute value', () => {
    assert.equal(htmlToText('<p title="a > b">x</p><span class=">">y</span>'), 'x\ny');
  });

  it('separates table cells', () => {
    assert.equal(
      htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'),
      'a b\nc',
    );
  });
});
