import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** True inside the Tauri shell, false when running the UI in a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let granted = false;

export async function initNotifications(): Promise<void> {
  if (!isTauri) return;
  try {
    granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
  } catch {
    granted = false;
  }
}

/**
 * Fires an OS notification. This is the whole point of the desktop app over a
 * browser tab: it reaches you when the window is closed to the tray.
 */
export function notify(title: string, body: string): void {
  if (isTauri && granted) {
    try {
      sendNotification({ title, body });
      return;
    } catch {
      // Fall through to the web API below.
    }
  }

  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

export async function ensureWebNotificationPermission(): Promise<void> {
  if (isTauri) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}
