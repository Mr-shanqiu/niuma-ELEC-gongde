import { createContext, useContext } from "react";
import { App } from "antd";

/**
 * Session actions shared by every page.
 *
 * A 401 anywhere has to end in one place: sign the operator out instead of
 * leaving a page that quietly shows nothing. Pages call `endSession()` rather
 * than navigating themselves.
 */
export const SessionContext = createContext<{ endSession: () => void }>({
  endSession: () => {}
});

export function useSessionActions() {
  const { endSession } = useContext(SessionContext);
  const { message, notification } = App.useApp();
  return { endSession, message, notification };
}

/** True when a failure means the cookie is gone, not that the data is empty. */
export function isUnauthorized(error: unknown): boolean {
  return (error as { status?: number })?.status === 401;
}
