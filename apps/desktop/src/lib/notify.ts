import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** True inside the Tauri shell, false when running the UI in a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function initNotifications(): Promise<void> {
  if (isTauri) {
    try {
      if (!(await isPermissionGranted())) await requestPermission();
    } catch {
      // Desktop has no real permission prompt. Send anyway and let it fail
      // loudly in the console rather than going quiet here.
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
 *
 * Deliberately not gated on a cached permission flag. On Windows the toast is
 * delivered through the installed app's AppUserModelID, and an unexpected
 * permission answer used to turn this into a silent no-op, which is the worst
 * possible failure for the one feature you are relying on while away.
 */
export function notify(title: string, body: string): void {
  if (isTauri) {
    try {
      sendNotification({ title, body });
      return;
    } catch (error) {
      console.error("Tauri notification failed, falling back to the web API", error);
    }
  }

  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
