/**
 * dsh-tool-map — the reviewed dsh tool map as data (T-2091; dsh-tool-map.json) and its boot
 * comparison with the schemas a running dsh declares. A newer dsh may add tools (hidden and
 * denied) or change a mapped tool — a field's type, a property outside the reviewed fields and
 * ignored list, or the required list (that tool is hidden and denied for the launch; an update
 * candidate doing it is held); it can never widen what Nassaj allows.
 */
import fs from 'node:fs';

// A JSON import (not a readFileSync path) so tsc emits the map into dist-server.
import shippedToolMap from './dsh-tool-map.json' with { type: 'json' };

/**
 * @param {string} [file] a map file to read instead of the shipped map
 * @returns {{ dsh: string, tools: Record<string, { claude: string, cls: string, fields: Record<string, string>, ignored: string[], required: string[] }> }}
 */
export function loadDshToolMap(file) {
  return file === undefined ? structuredClone(shippedToolMap) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The JSON type a schema property declares (first of a type list), or null. */
const typeOf = (property) => (property && typeof property === 'object' ? [].concat(property.type ?? [])[0] ?? null : null);

/**
 * @param {ReturnType<typeof loadDshToolMap>} map
 * @param {Array<{ name: string, schema: any }>} declared the tools a dsh launch registers
 * @returns {{ newTools: string[], changed: Array<{ name: string, field: string, want: string, got: string|null }>, lost: string[] }}
 */
export function compareToolSchemas(map, declared) {
  const byName = new Map(declared.map((tool) => [tool.name, tool.schema ?? {}]));
  const newTools = [...byName.keys()].filter((name) => !Object.hasOwn(map.tools, name)).sort();
  const lost = Object.keys(map.tools).filter((name) => !byName.has(name)).sort();
  const changed = [];
  for (const [name, entry] of Object.entries(map.tools)) {
    const schema = byName.get(name);
    if (!schema) continue;
    for (const [field, want] of Object.entries(entry.fields)) {
      const got = typeOf(schema.properties?.[field]);
      if (got !== want) changed.push({ name, field, want, got });
    }
    // qa C1: a property nobody reviewed may change what or where the tool touches.
    const reviewed = new Set([...Object.keys(entry.fields), ...(entry.ignored ?? [])]);
    for (const field of Object.keys(schema.properties ?? {})) {
      if (!reviewed.has(field)) changed.push({ name, field, want: 'reviewed', got: typeOf(schema.properties[field]) });
    }
    const required = [...(Array.isArray(schema.required) ? schema.required : [])].sort();
    if (JSON.stringify(required) !== JSON.stringify([...(entry.required ?? [])].sort())) {
      changed.push({ name, field: 'required', want: (entry.required ?? []).join(','), got: required.join(',') });
    }
  }
  return { newTools, changed, lost };
}

/** The mapped tools a launch may allow: declared, mapped and unchanged. */
export function allowedDshTools(map, declared) {
  const { changed } = compareToolSchemas(map, declared);
  const broken = new Set(changed.map((entry) => entry.name));
  const names = new Set(declared.map((tool) => tool.name));
  return Object.keys(map.tools).filter((name) => names.has(name) && !broken.has(name));
}
