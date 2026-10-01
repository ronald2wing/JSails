/** TSX twin of `fixtures/app/pages/layout.jsails`: the root layout. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

async function navigation(): Promise<readonly { href: string; label: string }[]> {
  return [
    { href: '/', label: 'Home' },
    { href: '/blog', label: 'Blog' },
  ];
}

export default async function Layout(props: {
  readonly children: ComponentChild;
}): Promise<ComponentChild> {
  const links = await navigation();
  return (
    <div class="layout" data-s="1kidlf6i">
      <nav>
        {links.map((link, index) => (
          <a key={link.href} href={link.href} data-index={index}>
            {link.label}
          </a>
        ))}
      </nav>
      {props.children}
    </div>
  );
}
