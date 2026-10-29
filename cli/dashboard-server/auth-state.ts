import type { AsoInteractivePrompt, AsoInteractivePromptResponse } from "../shared/aso-interactive-prompts";
import type { AsoPromptHandler } from "../services/prompts/aso-prompt-handler";
import { logger } from "../utils/logger";
import { createDashboardPromptSession } from "./prompt-session";

export type DashboardAuthStatus = "idle" | "in_progress" | "failed" | "succeeded";

export type DashboardAuthState = {
  status: DashboardAuthStatus;
  updatedAt: string | null;
  lastError: string | null;
  requiresTerminalAction: boolean;
  canPrompt: boolean;
  pendingPrompt: AsoInteractivePrompt | null;
};

type CreateDashboardAuthStateParams = {
  reAuthenticate: (options?: {
    onUserActionRequired?: () => void;
    promptHandler?: AsoPromptHandler;
  }) => Promise<unknown>;
  onError: (error: unknown) => void;
  onSucceeded?: () => void;
};

function nowIsoString(): string {
  return new Date().toISOString();
}

export function createDashboardAuthStateManager(
  params: CreateDashboardAuthStateParams
) {
  const state: Omit<DashboardAuthState, "canPrompt" | "pendingPrompt"> = {
    status: "idle",
    updatedAt: null,
    lastError: null,
    requiresTerminalAction: false,
  };
  const promptSession = createDashboardPromptSession();

  let inFlight: Promise<void> | null = null;

  const setState = (
    status: DashboardAuthStatus,
    lastError: string | null = null
  ): void => {
    state.status = status;
    state.updatedAt = nowIsoString();
    state.lastError = lastError;
    state.requiresTerminalAction = false;
  };

  const markPrompted = (): void => {
    if (state.status !== "in_progress") return;
    state.updatedAt = nowIsoString();
  };

  return {
    getState(): DashboardAuthState {
      return {
        status: state.status,
        updatedAt: state.updatedAt,
        lastError: state.lastError,
        requiresTerminalAction: state.requiresTerminalAction,
        canPrompt: true,
        pendingPrompt: promptSession.getPendingPrompt(),
      };
    },

    isInProgress(): boolean {
      return inFlight != null;
    },

    submitPromptResponse(response: AsoInteractivePromptResponse): boolean {
      if (state.status !== "in_progress") return false;
      const accepted = promptSession.submitPromptResponse(response);
      if (accepted) {
        state.updatedAt = nowIsoString();
      }
      return accepted;
    },

    start(): boolean {
      if (inFlight) return false;

      setState("in_progress", null);
      promptSession.reset();
      inFlight = params
        .reAuthenticate({
          onUserActionRequired: () => {
            markPrompted();
          },
          promptHandler: promptSession.createPromptHandler(),
        })
        .then(() => {
          promptSession.reset();
          setState("succeeded", null);
          params.onSucceeded?.();
        })
        .catch((error) => {
          promptSession.failPendingPrompt(error);
          const message = error instanceof Error ? error.message : String(error);
          setState("failed", message || "Authentication failed.");
          params.onError(error);
          logger.error(`ASO dashboard reauthentication failed: ${message}`);
        })
        .finally(() => {
          inFlight = null;
        });

      return true;
    },
  };
}
