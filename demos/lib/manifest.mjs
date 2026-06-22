// Manifest loader + canonical paths, shared by the runner and the checker.
// The manifest (demos/manifest.json) is the registry of every demo; see
// demos/CONVENTIONS.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // demos/lib
export const DEMOS_DIR = resolve(here, '..');         // demos/
export const ROOT = resolve(here, '..', '..');        // repo root
export const MEDIA_DIR = resolve(ROOT, 'docs', 'media');
export const MANIFEST_PATH = resolve(DEMOS_DIR, 'manifest.json');

/** Whole manifest object (incl. min_video_width). */
export function loadRaw() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Just the demos array. */
export function loadManifest() {
  return loadRaw().demos;
}

/** One demo by id, or undefined. */
export function findDemo(id) {
  return loadManifest().find((d) => d.id === id);
}
