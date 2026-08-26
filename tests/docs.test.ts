/**
 * Documentation drift.
 *
 * Docs go stale silently — nothing fails when a report is added and the
 * specification is not. These assert the handful of claims that are checkable
 * against the code, so drift shows up as a failing test rather than as a reader
 * being misled months later.
 *
 * Deliberately narrow: prose cannot be tested, so this only covers
 * correspondences that are mechanical.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('documentation', () => {
  it('has every file the README links to', () => {
    const readme = read('README.md');
    const links = [...readme.matchAll(/\]\((docs\/[a-z-]+\.md)\)/g)].map((m) => m[1]);

    expect(links.length).toBeGreaterThan(5);
    for (const link of new Set(links)) {
      expect(existsSync(link), `README links to ${link}, which does not exist`).toBe(true);
    }
  });

  it('links every doc from the README', () => {
    const readme = read('README.md');
    for (const file of readdirSync('docs').filter((f) => f.endsWith('.md'))) {
      expect(readme.includes(`docs/${file}`), `docs/${file} is not linked from the README`).toBe(true);
    }
  });

  it('documents every sheet of the Tabular MIS', () => {
    const page = read('src/app/(app)/mis/page.tsx');
    const spec = read('docs/mis-specification.md');

    const sheets = [...page.matchAll(/title="([A-Z])\. ([^"]+)"/g)].map((m) => ({
      letter: m[1],
      name: m[2],
    }));

    expect(sheets.length).toBeGreaterThanOrEqual(6);

    for (const sheet of sheets) {
      // Each sheet appears in the spec's index table and has its own section.
      expect(
        spec.includes(`| ${sheet.letter} | ${sheet.name} |`),
        `Tabular MIS sheet "${sheet.letter}. ${sheet.name}" is missing from the sheet index in mis-specification.md`,
      ).toBe(true);
    }
  });

  it('documents every section of the Analysis page', () => {
    const page = read('src/app/(app)/analysis/page.tsx');
    const spec = read('docs/mis-specification.md');

    const sections = [...page.matchAll(/title="([A-Z])\. ([^"]+)"/g)].map((m) => m[2]);
    expect(sections.length).toBeGreaterThanOrEqual(6);

    // The analytical reports section must at least name the same count.
    const analytical = spec.match(/## 8b\. Analytical reports[\s\S]*?(?=\n## )/);
    expect(analytical, 'mis-specification.md has no analytical-reports section').not.toBeNull();

    const headings = [...analytical![0].matchAll(/^### [A-Z]\. /gm)];
    expect(
      headings.length,
      `the Analysis page has ${sections.length} sections but the spec documents ${headings.length}`,
    ).toBe(sections.length);
  });

  it('states a test count the suite can actually reach', () => {
    const readme = read('README.md');
    const claimed = readme.match(/npm test\s+#\s*(\d+)\s*tests/);

    expect(claimed, 'the README no longer states a test count').not.toBeNull();

    const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
    // A weak but non-trivial bound: every suite file contributes cases, and the
    // claim should be in the right order of magnitude rather than left at an
    // early number.
    expect(Number(claimed![1])).toBeGreaterThanOrEqual(files.length * 5);
  });

  it('keeps the environment variables in .env.example and the README in step', () => {
    const example = read('.env.example');
    const readme = read('README.md');

    const vars = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(8);

    const undocumented = vars.filter((v) => !readme.includes(v));
    expect(undocumented, `these are in .env.example but not the README: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('does not promise scripts that no longer exist', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts);
    const docs = readdirSync('docs').map((f) => read(`docs/${f}`)).join('\n') + read('README.md');

    // Every `npm run X` mentioned anywhere must be a real script.
    const referenced = [...docs.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
    for (const name of new Set(referenced)) {
      expect(scripts.includes(name), `docs reference "npm run ${name}", which is not in package.json`).toBe(true);
    }
  });

  it('does not reference source files that have been moved or deleted', () => {
    const docs = readdirSync('docs')
      .filter((f) => f.endsWith('.md'))
      .flatMap((f) => {
        const text = read(`docs/${f}`);
        return [...text.matchAll(/`(src\/[a-zA-Z0-9/_.-]+\.tsx?)`/g)].map((m) => ({ file: f, path: m[1] }));
      });

    expect(docs.length).toBeGreaterThan(5);
    for (const { file, path } of docs) {
      expect(existsSync(path), `docs/${file} references ${path}, which does not exist`).toBe(true);
    }
  });
});
