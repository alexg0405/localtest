# Architecture

```
python -m pipeline <config.json>
        │
   cli.main ── config.load_config ── merges the file with config.DEFAULTS
        │
   runner.run ── for each name in config["stages"]:
        │            registry.get_stage(name)(context)
        │
   stages.py ── read_csv → normalize_headers → validate → parse_prices → dedupe → write_json
```

- **registry.py** holds the `@stage("name")` decorator, the stage table, and the
  `Context` and `Row` types every stage receives. A stage mutates the context
  and returns nothing.
- **Row** keeps `line` (the CSV line number) next to `fields`, so later stages
  can report problems against the original file.
- **config.py** owns defaults. Paths in a config are relative to the config
  file's folder.
- **runner.py** fails the run when rows were read but nothing could be written,
  because an empty catalog would take the storefront down.

Adding a stage: write a function in `stages.py`, decorate it with
`@stage("my_stage")`, and add its name to a config's `stages` list.
