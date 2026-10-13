# New requirement from the on-call lead

A second supplier is joining next week. Their tool exports **semicolon**-separated
files (same columns, same encoding quirks). Ops wants to reuse this pipeline
with a new config, and only wants to set what is different:

```json
{
  "input": "eu_feed.csv",
  "output": "out/eu_catalog.json",
  "options": {"delimiter": ";"}
}
```

- Add an `options.delimiter` setting. The default stays `","`, so existing
  configs keep working unchanged.
- Every option the new config does not mention (required columns, the dedupe
  key, the encoding) must keep its default.

A sample of their file:

```
sku;name;price
EU-1;Crêpe Pan;24.90
EU-2;Moka Pot;31.00
```

Please add tests for the new supplier's config.
