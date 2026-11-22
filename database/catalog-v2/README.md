# SmartHome Product Catalog V2

The one Product catalog of the system: **published**, catalog revision 13
(`manifest.json`). The API Gateway, MQTT Worker, Device Simulator and the
database initializer all load it through `shared/catalog-v2` (loader,
compiler, runtime); `db-initialize` publishes it to MongoDB, and the Flutter
app reads products from the Gateway. There is no other catalog (the old
`database/seeds` no longer exists).

## Files

- `manifest.json`: catalog identity, revision, lifecycle and source file routing.
- `hardware-profile.json`: confirmed hardware facts and open hardware questions.
- `capabilities.json`: reusable semantic capability contracts.
- `products.json`: the five Products (`prod_entrance_controller`,
  `prod_roof_controller`, `prod_hazard_mitigation`, `prod_irrigation_manager`,
  `prod_security_camera`), each with its own product revision.
- `schemas/catalog.schema.json`: formal JSON Schema documentation.

Product descriptions: `docs/products/README.md`.

## Validate

```powershell
node shared/catalog-v2/cli.js
node --test shared/catalog-v2/catalog-v2.test.js
```

The runtime compiler emits only active instances. Instances marked `planned`
remain reviewable in the catalog but do not contribute state, operations, events
or resources to the compiled runtime Product.

## Changing a published Product

Devices are bound to the product revision they were claimed with
(`device_metadata.catalog_revision`). A behavioural change needs a new product
revision and a new catalog revision; never edit a published revision in place,
and keep the Gateway, MQTT Worker, Simulator and Flutter in step.
