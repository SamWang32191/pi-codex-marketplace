import { describe, it, expect } from 'vitest';

import { parseCatalog, KEBAB_NAME_RE } from '../../../src/registration/catalog.js';
import { sortFindings } from '../../../src/registration/findings.js';

function scopeOpts() {
  return { scope: 'global' as const };
}

describe('Marketplace Catalog parsing', () => {
  it('parses a valid catalog with local entries and snapshot-scoped Entry IDs', () => {
    const res = parseCatalog(
      {
        name: 'acme-marketplace',
        plugins: [
          { name: 'release-helper', path: './plugins/release-helper' },
          { name: 'docs-helper', path: './plugins/docs-helper' },
        ],
      },
      scopeOpts(),
    );
    expect(res.ok).toBe(true);
    expect(res.catalog!.name).toBe('acme-marketplace');
    expect(res.catalog!.entries).toHaveLength(2);
    expect(res.catalog!.entries[0].entryId).toBe('/plugins/0');
    expect(res.catalog!.entries[1].entryId).toBe('/plugins/1');
    expect(res.catalog!.entries[0].available).toBe(true);
    expect(res.catalog!.entries[1].name).toBe('docs-helper');
  });

  it('rejects a non-object catalog as malformed (Blocking)', () => {
    const res = parseCatalog([1, 2], scopeOpts());
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe('CATALOG_MALFORMED');
    expect(res.findings[0].classification).toBe('blocking');
  });

  it('rejects missing/non-kebab-case names as Blocking at the catalog boundary', () => {
    expect(parseCatalog({ plugins: [] }, scopeOpts()).findings[0].code).toBe('CATALOG_NAME_INVALID');
    const bad = parseCatalog({ name: 'My Marketplace', plugins: [] }, scopeOpts());
    expect(bad.ok).toBe(false);
    expect(bad.findings).toHaveLength(1);
    expect(bad.findings[0].classification).toBe('blocking');
  });

  it('accepts kebab-case names', () => {
    expect(KEBAB_NAME_RE.test('acme-marketplace')).toBe(true);
    expect(KEBAB_NAME_RE.test('a1-b2')).toBe(true);
    expect(KEBAB_NAME_RE.test('Acme')).toBe(false);
    expect(KEBAB_NAME_RE.test('a b')).toBe(false);
    expect(KEBAB_NAME_RE.test('-acme')).toBe(false);
  });

  it('recognizes non-local entry source kinds as Unavailable Entries (non-blocking)', () => {
    const res = parseCatalog(
      {
        name: 'mixed',
        plugins: [
          { name: 'local-a', path: './plugins/local-a' },
          { name: 'remote-b', type: 'git' },
          { name: 'remote-c', kind: 'github' },
          { name: 'odd-d', type: 'weird' },
        ],
      },
      scopeOpts(),
    );
    expect(res.ok).toBe(true);
    const entries = res.catalog!.entries;
    expect(entries[0].available).toBe(true);
    expect(entries[1].available).toBe(false);
    expect(entries[1].unavailableReason).toMatch(/unsupported source kind/i);
    expect(entries[2].type).toBe('git');
    expect(entries[3].type).toBe('unsupported');
    // Unavailable Entries are a disclosed outcome, not a finding (CONTEXT: Validation Warning is
    // reserved for ignored Inert Metadata only)
    expect(res.findings).toEqual([]);
  });

  it('flags malformed entry objects as Blocking at the entry boundary', () => {
    const res = parseCatalog({ name: 'bad', plugins: ['not-an-object'] }, scopeOpts());
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe('CATALOG_ENTRY_MALFORMED');
    expect(res.findings[0].pointer).toBe('/plugins/0');
  });

  it('local entries without a path are Unavailable (resolve failure), not Blocking', () => {
    const res = parseCatalog({ name: 'nl', plugins: [{ name: 'x' }] }, scopeOpts());
    expect(res.ok).toBe(true);
    expect(res.catalog!.entries[0].available).toBe(false);
    expect(res.catalog!.entries[0].unavailableReason).toMatch(/no local path declared/i);
  });

  it('sortFindings orders by class → phase → target → pointer → rule deterministically', () => {
    const res = parseCatalog(
      { name: 'acme', plugins: [{ name: 'x', path: './x' }, 'malformed'] },
      scopeOpts(),
    );
    const codes = res.findings.map((f) => f.code);
    expect(codes).toEqual(['CATALOG_ENTRY_MALFORMED']);
    const sorted = sortFindings(res.findings);
    expect(sorted.map((f) => f.code)).toEqual(codes);
  });
});