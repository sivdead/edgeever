import { useSyncExternalStore } from "react";

export const SHOW_DESCENDANT_NOTES_STORAGE_KEY = "edgeever.showDescendantNotes";

export const SHOW_DESCENDANT_NOTES_CHANGED_EVENT = "edgeever:show-descendant-notes-changed";

// Parent notebooks keep aggregating their sub-notebooks unless turned off.
export const resolveStoredShowDescendantNotes = (stored: string | null): boolean =>
  stored !== "false";

export const readShowDescendantNotesPreference = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return resolveStoredShowDescendantNotes(
      window.localStorage?.getItem(SHOW_DESCENDANT_NOTES_STORAGE_KEY) ?? null,
    );
  } catch {
    return true;
  }
};

export const writeShowDescendantNotesPreference = (enabled: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(SHOW_DESCENDANT_NOTES_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Private mode / blocked storage — preference is session-only via the event.
  }
  window.dispatchEvent(
    new CustomEvent(SHOW_DESCENDANT_NOTES_CHANGED_EVENT, { detail: enabled }),
  );
};

const subscribe = (onChange: () => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === SHOW_DESCENDANT_NOTES_STORAGE_KEY) onChange();
  };
  window.addEventListener(SHOW_DESCENDANT_NOTES_CHANGED_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(SHOW_DESCENDANT_NOTES_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
};

export const useShowDescendantNotesPreference = () =>
  useSyncExternalStore(subscribe, readShowDescendantNotesPreference, () => true);
