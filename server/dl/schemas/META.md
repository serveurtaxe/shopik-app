# New Schema Development Guide

## 1. File Setup
*   **Location:** Create a file in `server/dl/schemas/`.
*   **Naming:** Use a **singular noun** + `.js` (e.g., `invoice.js`, `receipt.js`, `subscription_plan.js`).
*   **Imports:** Import shared utilities as needed, typically `uid` from the common functions path.

## 2. Exports
Every file must export two items:

1.  **Default Export (`schemaObject`):** A plain JavaScript object where keys are field names and values are Mongoose-style type definitions. Do not wrap in `{ default: ... }`.
    ```js
    const mySchema = {
        name: String,
        email: { type: String, required: true },
        tags: [String],
        createdAt: { type: Date, default: Date.now }
    };
    export default mySchema;
    ```

2.  **Meta Export (`meta`):** An optional object containing configuration keys read by `createModels.js`.
    ```js
    const meta = { /* config */ };
    export { meta };
    ```

## 3. Field Definitions
Schemas use a subset of Mongoose type definitions:

*   **Primitives:** `String`, `Number`, `Boolean`, `Date`.
*   **Nested Objects:** Define fields inside `{ ... }` (e.g., `address: { city: String, street: String }`).
*   **Arrays:** `[Type]` for primitives or `[{ ... }]` for arrays of objects.
*   **Sub-Schema Spread:** Define a sub-schema once and spread it into multiple fields to share structure.
    ```js
    const sharedSchema = { id: String, email: String };
    fieldA: sharedSchema,
    fieldB: sharedSchema
    ```
*   **Array Sub-Schema Spread:** Spread an array definition into nested fields.
*   **Sensitive Data:** Use `select: false` on fields like tokens or payment info to exclude them from default queries.
*   **Filterable fields:** `filter: true` exposes a field to `Model.processFilter`, which turns a plain String value into a case-insensitive **prefix** regex — fine for an admin column filter, wrong for a code (`'1370'` would match `'13701'`), and a case-insensitive regex can never use an index. Use `filter: 'exact'` for whole-value lookups; `id`/`*Id`/`*Ids`/`path` and enum strings are exact on their own.

## 4. Meta Object Configuration
The `meta` object configures the model beyond raw schema fields. It supports these keys:

### Indexes (`index`)
Define Mongoose indexes. An array is recommended over a single object.
```js
// Example
index: [
    { "fieldA": 1 },
    { "nested.field": -1 }
]
```
Sort keys go after the equality keys and in the order the query sorts in: an index ending
`{ a: -1, b: -1 }` cannot serve `sort: { b: -1, a: -1 }`, and MongoDB then collscans and
blocks on the sort. Extending an index with the sort suffix is cheaper than a second index
over the same filter keys.

### Constants / Enums (`constants`)
An object of named arrays used as `enum` values in schema fields. Accessible on the model via `Model.constants`.
```js
// Definition
constants: { STATUS: { ACTIVE:'active', INACTIVE:'inactive' } }

// Usage in schema field
status: { type: String, enum: Object.values(constants.STATUS) }
```

### Search Fields (`searchFields`)
Defines which data is concatenated for full-text search.
*   **String fields:** List paths directly (e.g., `['phone', 'email']`).
*   **Array/Object fields:** Use `arrayField:subfield1|subfield2` format to flatten nested arrays (e.g., `['labels:name|label']`).

### Virtuals (`virtuals`)
Custom getters computed on the fly using Mongoose virtual syntax.
```js
// Example
virtuals :{
    displayValue: function () { return `${this.name} - ${this.email}`; }
}
```

### Hooks (`hooks`)
Mongoose middleware (pre/post save, findOneAndUpdate, etc.).
```js
// Example
hooks: {
    pre: { save: async function (next) { /* logic */ next(); } },
    post: { findOneAndUpdate: async function (result) { /* logic */ } }
}
```

## 5. Auto-Generated Model Behavior
`createModels.js` automatically handles the following based on your file name:
*   **Model Name:** PascalCase of filename (e.g., `invoice.js` → `Invoice`).
*   **Collection Name:** snake_case plural of model name (e.g., `Invoice` → `invoices`).
*   **Auto-Fields:** Every model receives an auto-generated `id`, a default `active: true` boolean, and Mongoose timestamps.

## 6. Key Rules & Gotchas
*   **Do not manually create models.** They are generated automatically from the schema file.
*   **Do not use `Schema.Types` directly.** Schemas are plain objects, not Schema instances.
*   **Reference constants via `constants.XXX`.** Do not hardcode enum values in field definitions; always reference them from `meta.constants`.
*   **Use `uid()`** for unique ID generation if needed outside of the auto-generated `id`.
*   **Spread syntax:** When spreading an array sub-schema, ensure the target field expects that specific shape.
*   **Search fields for arrays:** Must use `{ fieldName, subFields }` format; plain strings do not work for nested arrays.