/**
 * Models for the write conformance suites: tenant-scoped boards and their
 * cards. Each has a randomly encrypted column, so a raw read shows whether
 * a write went through the codecs; a card keeps its board's counter cache
 * and touch, and declares save and delete hooks, so a set write on cards
 * must acknowledge them; a board's cards are detached from it by the
 * foreign-key action.
 */

import { column, defineModel, type ModelTarget } from '../../../../src/model/index.js';
import { ApplicationRecord } from '../../../../src/record/index.js';

export class Board extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare name: string;
  declare motto: string | null;
  declare cardsCount: number;
  declare touchedAt: Date | null;
}

export class Card extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare title: string;
  declare secret: string;
  declare boardId: number | null;
}

/** The ids of the cards whose `afterSave` or `afterDelete` ran, in order. */
export const SAVED_CARDS: number[] = [];

defineModel(Board, {
  table: 'gm_boards',
  columns: {
    tenantId: column.integer(),
    name: column.string(60),
    motto: column.string(60, { nullable: true, encrypted: { mode: 'random' } }),
    cardsCount: column.integer({ default: 0 }),
    touchedAt: column.timestamp({ nullable: true }),
  },
  tenant: 'tenantId',
  relations: {
    cards: { kind: 'hasMany', target: () => Card, inverse: 'board', dependent: 'nullify' },
  },
});

defineModel(
  Card,
  {
    table: 'gm_cards',
    columns: {
      tenantId: column.integer(),
      title: column.string(60),
      secret: column.string(60, { encrypted: { mode: 'random' } }),
    },
    tenant: 'tenantId',
    relations: {
      board: {
        kind: 'belongsTo',
        target: () => Board,
        nullable: true,
        counterCache: 'cardsCount',
        touch: 'touchedAt',
      },
    },
  },
  {
    hooks: {
      afterSave: ({ record }) => {
        SAVED_CARDS.push(record.id);
      },
      afterDelete: ({ record }) => {
        SAVED_CARDS.push(record.id);
      },
    },
  },
);

/** Every model of the suites, parents first. */
export const WRITE_MODELS: readonly ModelTarget[] = Object.freeze([Board, Card]);
