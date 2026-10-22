import { useState } from "react";
import { activeTrail } from "../reader/outline.js";
import type { OutlineNode } from "../reader/outline.js";

interface TocProps {
  readonly outline: readonly OutlineNode[];
  /** The page the reader is on, to show where in the book that is. */
  readonly page: number;
  readonly onGoTo: (page: number) => void;
}

/**
 * The table of contents, from the section tree. The section the reader is in is marked, and its
 * chapter is open; the others are closed until asked for, so a book with hundreds of sections is a
 * short list. A heading is a button that goes to the page its section starts on.
 */
export function Toc({ outline, page, onGoTo }: TocProps) {
  const trail = activeTrail(outline, page);
  const current = trail.at(-1)?.key;
  const onTrail = new Set(trail.map((node) => node.key));
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  if (outline.length === 0) {
    return <p className="muted">No headings were found in this book.</p>;
  }

  const toggle = (key: string): void => {
    setOpened((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderLevel = (nodes: readonly OutlineNode[]) => (
    <ul>
      {nodes.map((node) => {
        const expandable = node.children.length > 0;
        const open = expandable && (onTrail.has(node.key) || opened.has(node.key));
        return (
          <li key={node.key}>
            <div className="toc-row">
              {expandable ? (
                <button
                  type="button"
                  className="toc-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${node.entry.title}`}
                  onClick={() => {
                    toggle(node.key);
                  }}
                >
                  {open ? "▾" : "▸"}
                </button>
              ) : (
                <span className="toc-toggle" aria-hidden="true" />
              )}
              <button
                type="button"
                className="toc-link"
                aria-current={node.key === current ? "location" : undefined}
                data-on-trail={onTrail.has(node.key) ? "true" : undefined}
                onClick={() => {
                  onGoTo(node.entry.pageStart);
                }}
              >
                <span className="toc-title">{node.entry.title}</span>
                <span className="toc-page">{node.entry.pageStart}</span>
              </button>
            </div>
            {open ? renderLevel(node.children) : null}
          </li>
        );
      })}
    </ul>
  );

  return <nav aria-label="Table of contents">{renderLevel(outline)}</nav>;
}
