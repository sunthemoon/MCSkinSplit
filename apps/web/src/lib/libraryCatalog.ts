import {
  SEMANTIC_CATEGORY_LABELS,
  type AggregateKind,
} from "@mc-skin-split/skin-core";
import type {
  ApiLibraryStatusFilter,
  ApiPart,
  ApiPartBundle,
} from "./revisionApi";

export interface LibraryFilters {
  readonly query: string;
  readonly projectId: string;
  readonly status: ApiLibraryStatusFilter;
  readonly type: string;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  query: "",
  projectId: "",
  status: "active",
  type: "",
};

export interface LibraryProjectOption {
  readonly id: string;
  readonly label: string;
  readonly name: string;
}

type LibraryAsset = ApiPart | ApiPartBundle;

const bundleKindLabels: Readonly<Record<AggregateKind, string>> = {
  hair: "完整头发",
  clothing: "完整衣服",
  accessory: "饰品组合",
};

export function filterLibraryAssets<T extends LibraryAsset>(
  assets: readonly T[],
  filters: LibraryFilters,
): readonly T[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return assets.filter((asset) => {
    if (filters.status !== "all" && asset.libraryStatus !== filters.status) {
      return false;
    }
    if (filters.projectId && asset.sourceProjectId !== filters.projectId) {
      return false;
    }
    const assetType = "category" in asset ? asset.category : asset.kind;
    if (filters.type && assetType !== filters.type) {
      return false;
    }
    if (!query) return true;
    const typeLabel = "category" in asset
      ? SEMANTIC_CATEGORY_LABELS[asset.category]
      : bundleKindLabels[asset.kind];
    return [
      asset.name,
      asset.sourceProjectName,
      asset.sourceBranchName,
      asset.sourceRevisionId,
      assetType,
      typeLabel,
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function buildLibraryProjectOptions(
  assets: readonly LibraryAsset[],
): readonly LibraryProjectOption[] {
  const projects = new Map<string, string>();
  const idsByName = new Map<string, Set<string>>();
  for (const asset of assets) {
    projects.set(asset.sourceProjectId, asset.sourceProjectName);
    const ids = idsByName.get(asset.sourceProjectName) ?? new Set<string>();
    ids.add(asset.sourceProjectId);
    idsByName.set(asset.sourceProjectName, ids);
  }
  return [...projects].map(([id, name]) => ({
    id,
    name,
    label: (idsByName.get(name)?.size ?? 0) > 1
      ? `${name} · ${shortLibraryId(id)}`
      : name,
  })).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

export function librarySourceLabel(
  asset: LibraryAsset,
  projectOptions: readonly LibraryProjectOption[],
): string {
  const project = projectOptions.find((candidate) => candidate.id === asset.sourceProjectId);
  return `${project?.label ?? asset.sourceProjectName} · ${asset.sourceBranchName} #${asset.sourceRevisionSequence}`;
}

export function shortLibraryId(id: string): string {
  const compact = id.replace(/^[^_]+_/, "");
  return compact.slice(0, 6) || id.slice(0, 6);
}

export const BUNDLE_KIND_LABELS = bundleKindLabels;
