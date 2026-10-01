import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  Service,
  ServiceError,
  ServiceInputError,
  defineService,
} from '../../src/services/define-service.js';

describe('defineService', () => {
  it('validates input and returns the run result', async () => {
    const service = defineService({
      name: 'double',
      input: z.object({ n: z.number() }),
      run: ({ n }) => n * 2,
    });

    assert.equal(await service({ n: 3 }), 6);
    assert.equal(service.serviceName, 'double');
  });

  it('throws value-free field errors for invalid input', async () => {
    const service = defineService({
      name: 'double',
      input: z.object({ n: z.number() }),
      run: ({ n }) => n * 2,
    });

    await assert.rejects(
      async () => {
        await service({ n: 'nope' } as never);
      },
      (error: unknown) => {
        assert.ok(error instanceof ServiceInputError);
        assert.equal(error.code, 'invalid_input');
        assert.deepEqual(error.errors, [{ field: 'n', message: 'expected a number' }]);
        return true;
      },
    );
  });

  it('supports a no-input service', async () => {
    const service = defineService({
      input: z.void(),
      run: () => 'ok',
    });
    assert.equal(await service(), 'ok');
  });

  it('supports async run functions', async () => {
    const service = defineService({
      input: z.object({ value: z.string() }),
      async run({ value }) {
        return value.toUpperCase();
      },
    });
    assert.equal(await service({ value: 'a' }), 'A');
  });

  it('rejects malformed definitions', () => {
    assert.throws(
      () => defineService(null as never),
      (error) => error instanceof ServiceError && error.code === 'invalid_definition',
    );
    assert.throws(
      () => defineService({ input: {}, run: () => undefined } as never),
      (error) => error instanceof ServiceError && error.code === 'invalid_definition',
    );
    assert.throws(
      () => defineService({ input: z.object({}), run: null } as never),
      (error) => error instanceof ServiceError && error.code === 'invalid_definition',
    );
  });

  it('can be reused by a job without duplicating the schema', async () => {
    const service = defineService({
      input: z.object({ n: z.number() }),
      run: ({ n }) => n + 1,
    });

    const job = {
      name: 'increment',
      schema: service.input,
      handler: async (data: { n: number }) => {
        await service(data);
      },
    };

    assert.equal(await service({ n: 1 }), 2);
    assert.equal(job.schema, service.input);
  });
});

describe('Service', () => {
  it('groups multiple validated operations on one instance', async () => {
    class GreetingService extends Service {
      constructor(private readonly prefix: string) {
        super();
      }

      readonly greet = this.action({
        input: z.object({ name: z.string() }),
        run: ({ name }) => `${this.prefix}${name}`,
      });

      readonly shout = this.action({
        input: z.object({ name: z.string() }),
        run: ({ name }) => `${this.prefix}${name.toUpperCase()}!`,
      });
    }

    const service = new GreetingService('Hello, ');
    assert.equal(await service.greet({ name: 'Ada' }), 'Hello, Ada');
    assert.equal(await service.shout({ name: 'Ada' }), 'Hello, ADA!');
    assert.equal(typeof service.greet.input.safeParse, 'function');
  });

  it('validates each operation independently', async () => {
    class MathService extends Service {
      readonly double = this.action({
        input: z.object({ n: z.number() }),
        run: ({ n }) => n * 2,
      });
    }

    const service = new MathService();
    await assert.rejects(
      async () => {
        await service.double({ n: 'nope' } as never);
      },
      (error: unknown) => error instanceof ServiceInputError && error.errors[0]?.field === 'n',
    );
  });

  it('supports static operations', async () => {
    class StaticMathService extends Service {
      static readonly double = this.action({
        input: z.object({ n: z.number() }),
        run: ({ n }) => n * 2,
      });
    }

    assert.equal(await StaticMathService.double({ n: 4 }), 8);
  });

  it('supports an operation that acts on constructor data', async () => {
    class InvoiceService extends Service {
      constructor(private readonly invoiceId: string) {
        super();
      }

      readonly describe = this.action({
        input: z.void(),
        run: () => this.invoiceId,
      });
    }

    const service = new InvoiceService('inv_1');
    assert.equal(await service.describe(), 'inv_1');
  });
});
