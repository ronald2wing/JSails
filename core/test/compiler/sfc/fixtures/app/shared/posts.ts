/** The posts of the SFC fixture app, as plain data. */

export interface Post {
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export const posts: readonly Post[] = [
  {
    slug: 'hello',
    title: 'Hello',
    date: '2026-01-02',
    body: '<p>First</p>',
    tags: ['intro', 'news'],
  },
  { slug: 'again', title: 'Again', date: '2026-02-03', body: '<p>Second</p>', tags: [] },
];
