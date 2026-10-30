import { createPortal } from "react-dom";

type KeywordActionMenuProps = {
  x: number;
  y: number;
  /**
   * The dashboard runs one force refresh at a time; starting a second while
   * the first is in flight dropped its keywords (upstream's known issue).
   */
  forceRefreshDisabled?: boolean;
  /** Omitted where there is no per-keyword refresh (Google Play). */
  onForceRefresh?: () => void;
  onCopy: () => void;
  onDelete: () => void;
};

export function KeywordActionMenu(props: KeywordActionMenuProps) {
  const menu = (
    <div
      className="keyword-action-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      role="menu"
      aria-label="Keyword actions"
    >
      {props.onForceRefresh ? (
        <button
          type="button"
          className="keyword-action-item"
          role="menuitem"
          disabled={props.forceRefreshDisabled}
          onClick={props.onForceRefresh}
        >
          Force Refresh
        </button>
      ) : null}
      <button
        type="button"
        className="keyword-action-item"
        role="menuitem"
        onClick={props.onCopy}
      >
        Copy
      </button>
      <button
        type="button"
        className="keyword-action-item danger"
        role="menuitem"
        onClick={props.onDelete}
      >
        Delete
      </button>
    </div>
  );
  return createPortal(menu, document.body);
}
