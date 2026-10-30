import type { ReactNode } from "react";

type SortableThProps = {
  label: ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onSort: () => void;
  className?: string;
  title?: string;
  describedBy?: string;
};

/** A column header whose sort control is a real button, as in the iOS table. */
export function SortableTh(props: SortableThProps) {
  return (
    <th
      className={`sortable ${props.active ? "active" : ""} ${props.className ?? ""}`}
      aria-sort={props.active ? (props.dir === "asc" ? "ascending" : "descending") : "none"}
      title={props.title}
    >
      <button
        type="button"
        className="column-sort-button"
        aria-describedby={props.describedBy}
        onClick={props.onSort}
      >
        <span className={`sort-label ${props.active ? "active" : ""}`}>
          <span>{props.label}</span>
          {props.active ? (
            <span aria-hidden="true">{props.dir === "asc" ? " ▲" : " ▼"}</span>
          ) : null}
        </span>
      </button>
    </th>
  );
}
