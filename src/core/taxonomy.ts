import { isCategoryId, type CategoryId } from "./category.ts";

/**
 * One node of Pluggy's category tree, reduced to what the roll-up needs.
 * `parentDescription` is carried only to match the wire shape and is never
 * read; `parentId` is the authoritative relationship.
 */
export type TaxonomyEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly parentDescription?: string | null;
};

function parentOf(id: string, parents: ReadonlyMap<string, string | null>): string | null {
  if (!parents.has(id)) {
    throw new Error(`Category points to missing parent ${id}`);
  }

  const parentId = parents.get(id);
  if (parentId === undefined) {
    throw new Error(`Category points to missing parent ${id}`);
  }

  return parentId;
}

function rootOf(id: string, parents: ReadonlyMap<string, string | null>): CategoryId {
  const seen = new Set<string>();
  let current = id;

  while (true) {
    if (seen.has(current)) {
      throw new Error(`Category tree contains a cycle at ${current}`);
    }
    seen.add(current);

    const parentId = parentOf(current, parents);
    if (parentId === undefined) {
      throw new Error(`Category ${id} points to missing parent ${current}`);
    }

    if (parentId === null) {
      if (!isCategoryId(current)) {
        throw new Error(`Category tree root ${current} is not a top-level category`);
      }
      return current;
    }

    current = parentId;
  }
}

/** Maps every category id to its top-level ancestor, transitively. */
export function buildRollup(entries: readonly TaxonomyEntry[]): ReadonlyMap<string, CategoryId> {
  const parents = new Map<string, string | null>();

  for (const entry of entries) {
    if (parents.has(entry.id)) {
      throw new Error(`Category tree contains duplicate id ${entry.id}`);
    }
    parents.set(entry.id, entry.parentId);
  }

  const rollup = new Map<string, CategoryId>();
  for (const entry of entries) {
    rollup.set(entry.id, rootOf(entry.id, parents));
  }

  return rollup;
}
