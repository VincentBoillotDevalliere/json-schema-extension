# JSON Schema Helper

A lightweight VS Code extension that validates JSON/JSONC files **against a local JSON Schema** and shows diagnostics (warnings) directly in the editor.

It can resolve a schema in two ways:

1. **Per-file via `$schema`** at the root of the JSON document  
2. **Via workspace mappings** (glob → schema path), useful when files don’t embed `$schema`

This is designed for projects that keep schemas in-repo (e.g. `./schemas/*.schema.json`) and want quick feedback without setting up a full schema association system.

---

## Features

- ✅ Validate JSON and JSONC (comments + trailing commas supported)
- ✅ Uses local JSON Schema files (relative or absolute paths)
- ✅ Diagnostics for:
  - Unknown properties (not in schema)
  - Missing required properties
  - Type mismatches (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`)
- ✅ Supports:
  - `$ref` pointers (`#/...`)
  - `allOf` merging
  - `oneOf` / `anyOf` (currently validates using the **first** option)
- ✅ Schema caching (reloads automatically when schema file changes)

---

## Quick start

### 1) Add `$schema` to your JSON

Given this schema:

`schemas/user.schema.json`
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "number" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "address": {
      "type": "object",
      "properties": {
        "street": { "type": "string" },
        "zip": { "type": "string" }
      },
      "required": ["street"]
    }
  },
  "required": ["name"]
}
```

Use it from a JSON file:

`test.json`
```json
{
  "$schema": "./schemas/user.schema.json",
  "name": "Ada",
  "age": 30,
  "size": "medium"
}
```

You’ll get a warning like:

- `Unknown property "size" (not in schema).`

---

## Workspace schema mappings (recommended for larger projects)

Instead of adding `$schema` everywhere, you can map files to schemas in your VS Code settings.

Example: associate every `*.user.json` file with `schemas/user.schema.json`.

`.vscode/settings.json`
```json
{
  "jsonSchemaHelper.schemaMappings": [
    {
      "pattern": "**/*.user.json",
      "schemaPath": "schemas/user.schema.json"
    }
  ]
}
```

### How paths are resolved

- `schemaPath` in mappings is resolved **from the workspace folder**
- `$schema` values are resolved **relative to the JSON document** (unless absolute)
- Absolute paths are supported
- `file://...` URIs are supported
- Remote schemas (`http://`, `https://`, etc.) are **ignored** (no network requests)

---

## Extension settings

### `jsonSchemaHelper.schemaMappings`

Array of `{ pattern, schemaPath }` objects.

- `pattern`: glob-like match (supports `*`, `**`, `?`)
- `schemaPath`: path to the schema file

Example:
```json
"jsonSchemaHelper.schemaMappings": [
  { "pattern": "**/configs/*.json", "schemaPath": "schemas/config.schema.json" },
  { "pattern": "user.json", "schemaPath": "schemas/user.schema.json" }
]
```

### `jsonSchemaHelper.showUnknownProperties` (default: `true`)

If enabled, properties not declared in `properties` (and not allowed by `additionalProperties`) produce a warning.

### `jsonSchemaHelper.enableDiagnostics` (default: `true`)

Enable/disable diagnostics entirely.

---

## Notes on JSON Schema support

This extension intentionally implements a **focused subset** of JSON Schema for fast, local validation:

Supported:
- `type`, `properties`, `required`, `items`, `additionalProperties`
- `$ref` (local refs only: `#/...`)
- `allOf` (merged)
- `oneOf`, `anyOf` (first entry only)

Not currently validated:
- numeric/string constraints (`minimum`, `pattern`, `format`, etc.)
- conditionals (`if/then/else`)
- advanced composition logic beyond “pick first” for `oneOf/anyOf`
- remote `$ref` or remote `$schema`

---

## Troubleshooting

**No diagnostics appear**
- Ensure the file is `json` or `jsonc`
- Ensure `jsonSchemaHelper.enableDiagnostics` is `true`
- Ensure a schema is resolvable (via `$schema` or a mapping)
- Ensure the schema file path is valid and readable

**Schema changes aren’t picked up**
- Saving the schema file should trigger reload automatically (mtime-based cache)
- If needed, run: “Developer: Reload Window”

---

## Development

- Built with the VS Code Extension API and `jsonc-parser`
- Diagnostics update on:
  - open/change/save document
  - schema file save
  - configuration change

---

## License

MIT
