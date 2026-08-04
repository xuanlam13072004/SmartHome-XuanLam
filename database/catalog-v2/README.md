# SmartHome Product Catalog V2

This directory is an additive, draft catalog. Runtime services continue to use
`database/seeds` until the clean-break cutover phase is explicitly performed.

## Files

- `manifest.json`: catalog identity and source file routing.
- `hardware-profile.json`: design-time confirmed facts and open hardware questions.
- `capabilities.json`: reusable semantic capability contracts.
- `products.json`: four Product definitions and their local policies.
- `schemas/catalog.schema.json`: formal JSON Schema documentation.

## Validate

```powershell
node shared/catalog-v2/cli.js
node --test shared/catalog-v2/catalog-v2.test.js
```

The runtime compiler emits only active instances. Instances marked `planned`
remain reviewable in the catalog but do not contribute state, operations, events
or resources to the compiled runtime Product.

## Publishing rule

All definitions remain `draft` until hardware questions are answered and the
Gateway, MQTT Worker, Simulator and Flutter have V2 implementations. A clean
database reset must not happen before that point.
