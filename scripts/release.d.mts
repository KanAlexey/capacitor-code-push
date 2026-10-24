// Types of scripts/release.mjs, for the tests that import it.
export function changelog(dir?: string): string;
export function notesOf(text: string, version: string): string | null;
export function commitOf(version: string, dir?: string): string | null;
