/**
 * The preamble of `fragment` fences in the docs (see
 * `website/scripts/check-docs.mjs`). A fragment is a sample that assumes an app
 * around it: the models, records, and values declared here are in scope when it
 * compiles, beside the framework globals every app has. A whole-module fence
 * (the default) never sees them.
 *
 * Each stub is a global (`declare global`). The gate compiles this file as a
 * `.ts` module, so a stub that stops matching the framework fails the gate.
 * Keep the stubs to names several pages share; a page-specific name belongs in
 * the sample itself.
 */

export {};

declare global {
  /** The `Post` model most data-layer samples query. */
  class Post extends ApplicationRecord {
    id: number;
    title: string;
    body: string;
    published: boolean;
    authorId: number;
    createdAt: Date;
    updatedAt: Date;
  }

  /** The `User` model the auth and ownership samples use. */
  class User extends ApplicationRecord {
    id: number;
    email: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** A loaded post, for samples that start from one record. */
  const post: Post;

  /** The signed-in user, for samples that start from one. */
  const user: User;
}
