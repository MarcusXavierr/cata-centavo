import { isCategoryId, type CategoryId } from "./category.ts";
import { TAXONOMY, type TaxonomyEntry } from "./taxonomy-tree.ts";

export type { TaxonomyEntry };


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

/**
 * Built once at module load. `buildRollup` throws on a duplicate id, a missing
 * parent, a cycle or a root that is not top-level — so a defect in the shipped
 * constant fails the suite rather than a user's walk.
 */
const ROLLUP = buildRollup(TAXONOMY);

/**
 * The top-level ancestor of a Pluggy category id, or `null` when we do not know
 * the id.
 *
 * Returning `null` rather than throwing is the whole point: the tree ships as
 * code, so a category Pluggy adds tomorrow is absent by construction. An
 * unknown leaf must cost that one row its group, not take a whole account's
 * walk down with it (design D3).
 */
export function topCategoryOf(categoryId: string | null): CategoryId | null {
  if (categoryId === null) {
    return null;
  }
  return ROLLUP.get(categoryId) ?? null;
}

