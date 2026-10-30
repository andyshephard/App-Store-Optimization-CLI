import { useState } from "react";
import { Input } from "../ui-react";
import { toActionableErrorMessage } from "../app-helpers";
import { isPlayPackageId } from "../../domain/play-package";
import { shortPlayAppName, type PlayApp } from "../store-merge";

type Props = {
  apps: PlayApp[];
  selectedAppId: string;
  onSelect: (appId: string) => void;
  onAdd: (appId: string) => Promise<void>;
  onRemove: (appId: string) => Promise<void>;
};

const SOURCE_HINT: Record<PlayApp["source"], string> = {
  ASO_PLAY_APP_ID: "Our app (ASO_PLAY_APP_ID)",
  ASO_PLAY_ROSTER_APP_IDS: "Competitor from ASO_PLAY_ROSTER_APP_IDS",
  dashboard: "Competitor added here",
};

/**
 * The sidebar's Google Play apps: our app and the competitors, like the App
 * Store "Apps" list. Selecting one shows its Play ranks; competitors are
 * added and removed by package name.
 */
export function PlayAppsList(props: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const appId = input.trim();
    if (!appId) return;
    if (!isPlayPackageId(appId)) {
      setErrorText("Enter a package name, e.g. com.example.app.");
      return;
    }
    setBusy(true);
    setErrorText("");
    try {
      await props.onAdd(appId);
      setInput("");
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to add the competitor"));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (app: PlayApp) => {
    setBusy(true);
    setErrorText("");
    try {
      await props.onRemove(app.id);
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to remove the competitor"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="apps-section play-apps-section" aria-label="Google Play apps">
      <p className="apps-section-title">Google Play apps</p>
      <form className="play-app-add" onSubmit={onSubmit} aria-label="Add a Google Play competitor">
        <Input
          type="text"
          className="play-app-add-input"
          placeholder="Competitor package name"
          aria-label="Competitor package name"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button
          type="submit"
          className="store-track-button"
          aria-label="Add competitor"
          disabled={busy || input.trim() === ""}
        >
          Add
        </button>
      </form>
      {errorText ? (
        <p className="play-app-error" role="alert">
          {errorText}
        </p>
      ) : null}
      <div role="tablist" aria-label="Google Play apps">
        {props.apps.map((app) => {
          const isSelected = app.id === props.selectedAppId;
          const label = app.name ?? shortPlayAppName(app);
          return (
            <div
              key={app.id}
              className={`app-item play-app-item ${isSelected ? "active" : ""}`}
              data-play-app-id={app.id}
              role="tab"
              tabIndex={0}
              aria-selected={isSelected}
              title={SOURCE_HINT[app.source]}
              onClick={() => props.onSelect(app.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                props.onSelect(app.id);
              }}
            >
              {app.iconUrl ? (
                <img src={app.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <span className="app-fallback">{label.slice(0, 2).toUpperCase()}</span>
              )}
              <span className="app-meta">
                <span className="app-name">
                  {label}
                  {app.kind === "owned" ? <span className="play-app-tag">Ours</span> : null}
                </span>
                <span className="app-id">{app.id}</span>
              </span>
              {app.removable ? (
                <button
                  type="button"
                  className="store-row-remove play-app-remove"
                  aria-label={`Stop tracking ${app.id} on Google Play`}
                  title="Stop tracking (its history is kept)"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRemove(app);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
