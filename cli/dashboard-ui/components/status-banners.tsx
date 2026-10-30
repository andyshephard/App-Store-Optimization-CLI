type StatusBannersProps = {
  showLoading: boolean;
  loadingText: string;
  showError: boolean;
  errorText: string;
  showSuccess: boolean;
  successText: string;
  /** Keeps ids unique when a second set is on the page (the store views). */
  idPrefix?: string;
};

export function StatusBanners(props: StatusBannersProps) {
  const prefix = props.idPrefix ?? "";
  return (
    <div className="status-slot" aria-live="polite">
      <p id={`${prefix}loading-text`} className={`loading-text ${props.showLoading ? "visible" : ""}`}>
        {props.loadingText}
      </p>
      <p id={`${prefix}add-error`} className={`error ${props.showError ? "visible" : ""}`}>
        {props.errorText}
      </p>
      <p id={`${prefix}add-success`} className={`success ${props.showSuccess ? "visible" : ""}`}>
        {props.successText}
      </p>
    </div>
  );
}
