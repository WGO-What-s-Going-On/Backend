// No I/O or awaited work is added to the existing location request.
const listeners = new Set<(userId: number) => void>();
export function onNotificationLocationSaved(
  listener: (userId: number) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notificationLocationSaved(userId: number) {
  // A notification observer cannot turn a committed location write into an API failure.
  // Periodic consent reconciliation also repairs observations lost during a restart.
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {}
  }
}
