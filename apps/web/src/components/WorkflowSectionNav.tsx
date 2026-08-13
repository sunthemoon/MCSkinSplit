import {
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

export interface WorkflowSectionDefinition {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly detail: string;
}

export interface WorkflowSectionPosition {
  readonly id: string;
  readonly top: number;
}

export const WORKFLOW_SECTIONS: readonly WorkflowSectionDefinition[] = [
  {
    id: "workspace-history",
    code: "00",
    label: "历次记录",
    detail: "Revision 时间线",
  },
  {
    id: "workspace-catalog",
    code: "A+",
    label: "分析目录",
    detail: "结果与完整大类",
  },
  {
    id: "workspace-ai",
    code: "AI",
    label: "AI 识别",
    detail: "隔离提案与审核",
  },
  {
    id: "workspace-preview",
    code: "01",
    label: "载入预览",
    detail: "PNG · UV · 3D",
  },
  {
    id: "workspace-semantic",
    code: "04",
    label: "组件拆分",
    detail: "语义编辑与部件库",
  },
  {
    id: "workspace-repair",
    code: "07",
    label: "组件修补",
    detail: "像素修补与白模",
  },
  {
    id: "workspace-composition",
    code: "08",
    label: "混搭合成",
    detail: "Bundle · 还原 · 冲突",
  },
] as const;

export function resolveActiveWorkflowSection(
  positions: readonly WorkflowSectionPosition[],
  threshold: number,
  atPageEnd = false,
): string | null {
  const measuredPositions = positions.filter((position) =>
    Number.isFinite(position.top),
  );
  if (measuredPositions.length === 0) return null;
  if (atPageEnd) return measuredPositions.at(-1)?.id ?? null;

  let activeId = measuredPositions[0]?.id ?? null;
  for (const position of measuredPositions) {
    if (position.top > threshold) break;
    activeId = position.id;
  }
  return activeId;
}

export function resolveWorkflowSectionIdFromHash(
  hash: string,
  sections: readonly WorkflowSectionDefinition[] = WORKFLOW_SECTIONS,
): string | null {
  return sections.find((section) => `#${section.id}` === hash)?.id ?? null;
}

interface WorkflowSectionNavProps {
  readonly sections?: readonly WorkflowSectionDefinition[];
}

export function WorkflowSectionNav({
  sections = WORKFLOW_SECTIONS,
}: WorkflowSectionNavProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const [activeId, setActiveId] = useState<string | null>(
    sections[0]?.id ?? null,
  );

  useEffect(() => {
    let animationFrame: number | null = null;
    let initialHashFrame: number | null = null;

    const updateActiveSection = () => {
      animationFrame = null;
      const positions = sections.flatMap((section) => {
        const element = document.getElementById(section.id);
        return element
          ? [{ id: section.id, top: element.getBoundingClientRect().top }]
          : [];
      });
      const threshold = Math.min(180, Math.max(96, window.innerHeight * 0.22));
      const atPageEnd =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 4;
      const nextId = resolveActiveWorkflowSection(
        positions,
        threshold,
        atPageEnd,
      );
      if (nextId !== null) setActiveId(nextId);
    };

    const scheduleUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(updateActiveSection);
    };

    const followLocationHash = () => {
      const nextHashId = resolveWorkflowSectionIdFromHash(
        window.location.hash,
        sections,
      );
      if (!nextHashId) {
        scheduleUpdate();
        return;
      }
      setActiveId(nextHashId);
      window.requestAnimationFrame(() => {
        document.getElementById(nextHashId)?.scrollIntoView({
          behavior: "auto",
          block: "start",
        });
      });
    };

    const initialHashId = resolveWorkflowSectionIdFromHash(
      window.location.hash,
      sections,
    );
    if (initialHashId) {
      setActiveId(initialHashId);
      initialHashFrame = window.requestAnimationFrame(() => {
        document.getElementById(initialHashId)?.scrollIntoView({
          behavior: "auto",
          block: "start",
        });
      });
    } else {
      updateActiveSection();
    }
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("hashchange", followLocationHash);
    window.addEventListener("popstate", followLocationHash);
    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("hashchange", followLocationHash);
      window.removeEventListener("popstate", followLocationHash);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (initialHashFrame !== null) window.cancelAnimationFrame(initialHashFrame);
    };
  }, [sections]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) return;
    const activeLink = Array.from(
      list.querySelectorAll<HTMLAnchorElement>("a[data-section-id]"),
    ).find((link) => link.dataset.sectionId === activeId);
    if (!activeLink) return;

    const listRect = list.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    if (linkRect.left < listRect.left) {
      list.scrollBy({ left: linkRect.left - listRect.left, behavior: "auto" });
    } else if (linkRect.right > listRect.right) {
      list.scrollBy({ left: linkRect.right - listRect.right, behavior: "auto" });
    }
  }, [activeId]);

  const activeIndex = Math.max(
    0,
    sections.findIndex((section) => section.id === activeId),
  );

  const navigate = (
    event: MouseEvent<HTMLAnchorElement>,
    sectionId: string,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = document.getElementById(sectionId);
    if (!target) return;

    event.preventDefault();
    const nextHash = `#${sectionId}`;
    if (window.location.hash !== nextHash) {
      const nextUrl = new URL(window.location.href);
      nextUrl.hash = sectionId;
      window.history.pushState(window.history.state, "", nextUrl);
    }
    setActiveId(sectionId);
    target.focus({ preventScroll: true });
    target.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  };

  return (
    <nav className="workflow-section-nav" aria-label="工作区快速导航">
      <header className="workflow-section-nav-heading">
        <span>WORKFLOW INDEX</span>
        <strong>工作流定位</strong>
        <small>
          {String(activeIndex + 1).padStart(2, "0")} / {String(sections.length).padStart(2, "0")}
        </small>
      </header>
      <ol ref={listRef}>
        {sections.map((section) => {
          const active = section.id === activeId;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={active ? "location" : undefined}
                data-active={active}
                data-section-id={section.id}
                onClick={(event) => navigate(event, section.id)}
              >
                <span aria-hidden="true">{section.code}</span>
                <strong>{section.label}</strong>
                <small>{section.detail}</small>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
