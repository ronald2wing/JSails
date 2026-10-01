---
title: Data Contracts
order: 31
section: Reference
---

# Data Contracts

`jsails/data` is a small, human-first contract for structured data. A contract
names a shape once and then serves three jobs without a class, constructor, or
serializer:

- **Validation** — `contract.schema.parse(value)` returns a plain object.
- **JSON Schema** — `contract.jsonSchema` (input) and
  `contract.outputJsonSchema` (output) describe the same shape for AI tools,
  editors, or an API response.
- **Model columns** — `@jsails.data(Contract)` stores the value in a `json`
  column and validates it on every insert and update.

The parsed value is always a plain object. There is no `toJSON`, no `fromArray`,
and no framework-owned instance. Zod owns parsing; `JSON.stringify` owns
serialization.

## Defining a contract

```ts
import { defineData } from 'jsails/data';
import { z } from 'jsails/zod';

export const Preferences = defineData({
  name: 'Preferences',
  description: 'Display preferences for one account.',
  properties: {
    theme: z.enum(['light', 'dark']).describe('The active theme.'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
  },
});
```

`properties` is an ordinary object of Zod schemas. `defineData` builds a strict
object schema internally, so a contract rejects unknown keys. `name` is required
and is also the default AI tool name; `description` is optional and becomes the
JSON Schema and AI tool description.

| Member | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Stable contract name. |
| `description` | `string \| undefined` | Human description. |
| `properties` | `ZodRawShape` | Field schemas, in declaration order. |
| `schema` | `ZodObject` | The generated strict object schema. |
| `jsonSchema` | `object` | Lazy input JSON Schema (`io: 'input'`). |
| `outputJsonSchema` | `object` | Lazy output JSON Schema (`io: 'output'`). |

Validation is explicit:

```ts
const preferences = Preferences.schema.parse(input); // typed plain object
```

`defineData` never throws for invalid *data* — that belongs to `parse` — and
throws a value-free `DataContractError` (`code: 'invalid_contract'`) only for a
malformed contract. JSON Schema generation is lazy: an unrepresentable schema
fails at first access with a value-free error, not at module load.

### A list of contracts

Use `defineDataList` when the value is an array of the same object:

```ts
import { defineDataList } from 'jsails/data';

export const PreferencesList = defineDataList(Preferences, {
  name: 'PreferencesList',
  description: 'A list of display preferences.',
});
```

The list exposes `item` (the object contract), `schema` (`z.array(item.schema)`),
and the same input/output JSON Schema properties. The default name is
`<item name>List`. `defineDataList` rejects anything that is not a data contract.

### Deriving the value type

`DataValue` turns a contract into its parsed TypeScript value:

```ts
import type { DataValue } from 'jsails/data';

type PreferencesValue = DataValue<typeof Preferences>;
// { theme: 'light' | 'dark'; density: 'comfortable' | 'compact' }

type PreferencesListValue = DataValue<typeof PreferencesList>;
// PreferencesValue[]
```

`DataValue` is a type-only projection. It does not enforce that a model field
matches its decorator, so import it and declare the field explicitly.

## Data-backed JSON columns

Decorate a model field with `@jsails.data` to make it a `json` column backed by a
contract:

```ts
import { ApplicationRecord } from 'jsails/models';
import { defineData, type DataValue } from 'jsails/data';
import { z } from 'jsails/zod';

export const Preferences = defineData({
  name: 'Preferences',
  properties: {
    theme: z.enum(['light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
  },
});

export class User extends ApplicationRecord {
  declare id: number;

  @jsails.data(Preferences)
  declare preferences: DataValue<typeof Preferences>;
}
```

The compiler reads the decorator as a marker and emits a portable `json` column;
it does not need to resolve the contract at compile time. At runtime the
decorator records the contract, and `defineModel` wires a validation hook:

- **insert** validates the field against the contract and persists the parsed
  value;
- **update** validates the field only when the update payload contains it and
  persists the parsed value;
- **load** does **not** validate (the same deliberate non-goal as
  `defineEntityValidation`: legacy rows must not turn into an availability
  outage).

Parsing is applied, not just checked: Zod defaults and transforms become the
stored JSON. A missing `density` becomes `comfortable` before the insert, and a
trimmed string is stored trimmed. The stored value therefore matches
`DataValue<typeof Contract>`, not merely the input shape.

A list contract works the same way:

```ts
@jsails.data(PreferencesList)
declare history: DataValue<typeof PreferencesList>;
```

`@jsails.nullable()` makes the column and the contract nullable:

```ts
@jsails.data(Preferences)
@jsails.nullable()
declare preferences: DataValue<typeof Preferences> | null;
```

`@jsails.data` and `@jsails.encrypts()` are mutually exclusive — encryption is
for scalar strings, not structured objects — and `defineModel` rejects the
combination.

Use `db:push` as usual; a data contract field is a normal `json` column and
needs no special migration.

### What this does not do

- It does not query inside JSON. `json` is opaque to SQL; filter on real columns.
- It does not validate rows on load.
- It does not statically verify that the field type matches the contract.
  `DataValue<typeof Contract>` is the type-level half; the decorator is the
  runtime half.
- It does not add a TypeORM transformer. Drivers that return a parsed object
  (MariaDB, Postgres, SQLite via TypeORM) return the same plain value; a driver
  that returns a raw string is outside the supported set.

## AI tools

An AI tool needs a name, a description, and a JSON Schema. A data contract
already has all three, so `aiTool` projects it directly and validates the model's
arguments through the same schema:

```ts
import { aiTool } from '@jsails/ai';

const createUser = aiTool(Preferences, {
  name: 'set_preferences',
  description: 'Set the display preferences for the signed-in account.',
  call: async (input) => {
    // `input` is already validated and typed.
    return User.update({ id }, { preferences: input });
  },
});
```

`aiTool` uses `jsonSchema` (input) for the tool's `parameters`. Pass `returns` to
validate the handler's result through an output contract before it reaches the
model:

```ts
const result = await aiTool(Preferences, {
  call: () => ({ theme: 'dark', density: 'compact' }),
  returns: Preferences,
}).call({});
```

For a provider that supports structured output, send
`contract.outputJsonSchema` as the response format. The AI runtime itself is
provider-neutral and does not impose a response-format field; the transport owns
that wire detail. A contract gives both sides the same schema:

```ts
const responseSchema = Preferences.outputJsonSchema;
```

The full model pipeline is therefore: the model returns JSON → `schema.parse`
validates it → `@jsails.data` validates it again at persistence → the database
stores the same plain object in a `json` column.

## Honest limits

- **No class instances.** The value is a plain object by design; methods belong
  on services, not on data.
- **No nested data contracts as first-class fields.** A nested shape is a nested
  Zod object today. `DataValue`/`@jsails.data` only projects top-level contracts.
- **No collection wrapper.** `defineDataList` is an array contract, not a
  paginator, cursor, or Eloquent-style collection.
- **No casts beyond JSON.** The contract is storage-neutral; it does not attach a
  database cast or driver-specific transform.
- **No AI response-format wiring.** `@jsails/ai` is deliberately provider-neutral;
  pass `outputJsonSchema` to the transport you own.
