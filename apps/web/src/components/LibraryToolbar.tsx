import type { ApiLibraryStatusFilter } from "../lib/revisionApi";
import type {
  LibraryFilters,
  LibraryProjectOption,
} from "../lib/libraryCatalog";

interface LibraryToolbarProps {
  readonly filters: LibraryFilters;
  readonly projects: readonly LibraryProjectOption[];
  readonly typeLabel: string;
  readonly typeOptions: readonly { readonly value: string; readonly label: string }[];
  readonly showStatus?: boolean;
  readonly onChange: (filters: LibraryFilters) => void;
}

export function LibraryToolbar({
  filters,
  projects,
  typeLabel,
  typeOptions,
  showStatus = true,
  onChange,
}: LibraryToolbarProps) {
  const update = <Key extends keyof LibraryFilters>(
    key: Key,
    value: LibraryFilters[Key],
  ) => onChange({ ...filters, [key]: value });

  return (
    <div className="library-toolbar" aria-label="组件库检索">
      <label className="library-search-field">
        <span>SEARCH</span>
        <input
          type="search"
          value={filters.query}
          placeholder="名称 / 来源工程 / 分类"
          onChange={(event) => update("query", event.target.value)}
        />
      </label>
      <label>
        <span>SOURCE PROJECT</span>
        <select
          value={filters.projectId}
          onChange={(event) => update("projectId", event.target.value)}
        >
          <option value="">全部来源工程</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{typeLabel}</span>
        <select
          value={filters.type}
          onChange={(event) => update("type", event.target.value)}
        >
          <option value="">全部分类</option>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {showStatus ? (
        <label>
          <span>STATUS</span>
          <select
            value={filters.status}
            onChange={(event) => update("status", event.target.value as ApiLibraryStatusFilter)}
          >
            <option value="active">使用中</option>
            <option value="retired">已退役管理</option>
            <option value="all">全部状态</option>
          </select>
        </label>
      ) : null}
    </div>
  );
}
