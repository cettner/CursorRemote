import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** True inside the Tauri shell, false when running the UI in a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Toast sounds. The underlying plugin emits `<audio silent="true"/>` unless it
 * can parse the name, so leaving this unset makes every alert silent, which is
 * useless when you are away from the machine. These are the Windows toast sound
 * names; other platforms ignore anything they do not recognise and stay silent,
 * same as before.
 */
const SOUND_QUESTION = "Reminder";
const SOUND_DONE = "Default";

export async function initNotifications(): Promise<void> {
  if (isTauri) {
    try {
      if (!(await isPermissionGranted())) await requestPermission();
    } catch {
      // Desktop has no real permission prompt. Send anyway rather than letting
      // an unexpected answer here turn every alert into a silent no-op.
    }
    return;
  }

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

/**
 * Fires an OS notification. This is the whole point of the desktop app over a
 * browser tab: it reaches you when the window is closed to the tray.
 */
export function notify(title: string, body: string, sound = SOUND_DONE): void {
  if (isTauri) {
    try {
      sendNotification({ title, body, sound });
      return;
    } catch (error) {
      console.error("Tauri notification failed, falling back to the web API", error);
    }
  }

  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/** A question is the one alert that genuinely blocks the agent, so it gets its own sound. */
export function notifyQuestion(title: string, body: string): void {
  notify(title, body, SOUND_QUESTION);
}
