import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { PUBG_TOOLS } from '../src/catalog.js';
import { schemaShape } from '../src/schema-shape.js';

/*
 * The model-facing contract of the PUBG tools (names, descriptions, what an input may contain). Lab describes the same
 * tools with TypeBox; scripts/compare-lab-schemas.ts proves the two agree, and this snapshot makes any change here a
 * visible, deliberate one. Update with UPDATE_SNAPSHOT=1.
 */
const file = new URL('./fixtures/tool-schemas.snapshot.json', import.meta.url);
const current = Object.fromEntries(
  PUBG_TOOLS.map((spec) => [
    spec.name,
    { description: spec.description, input: schemaShape(z.toJSONSchema(spec.input, { io: 'input' })) },
  ]),
);

test('the PUBG tool contract matches the snapshot', () => {
  if (process.env.UPDATE_SNAPSHOT === '1') writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  assert.deepEqual(current, JSON.parse(readFileSync(file, 'utf8')));
});

test('every tool of Lab is there, nothing else', () => {
  assert.deepEqual(
    PUBG_TOOLS.map((spec) => spec.name).sort(),
    [
      'pubg_compare_stats',
      'pubg_get_match',
      'pubg_get_period_review',
      'pubg_get_review_facts',
      'pubg_query_stats',
      'pubg_query_team_damage',
      'pubg_resolve_players',
      'pubg_search_matches',
    ],
  );
});
