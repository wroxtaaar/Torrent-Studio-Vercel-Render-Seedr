// Audio chime generator using Web Audio API
export function playNotificationSound(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    
    // Pleasant double chime: 587Hz (D5) -> 880Hz (A5)
    const now = ctx.currentTime;
    
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.15);
    gain2.gain.setValueAtTime(0.25, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.6);
  } catch (e) {
    // Audio output might be restricted by browser autoplay policy
    console.warn('Audio chime playback omitted:', e);
  }
}

// Safely query notification permission without throwing in iframe environments
export function getNotificationPermission(): NotificationPermission {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
  } catch (e) {
    // Sandboxed or iframe policy restricted
  }
  return 'default';
}

// Request permission for Web Push Notifications
export async function requestPushPermission(): Promise<NotificationPermission> {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const permission = await Notification.requestPermission();
      return permission;
    }
  } catch (e) {
    console.warn('Error requesting notification permission:', e);
  }
  return 'denied';
}

// Dispatch browser push notification safely
export function dispatchBrowserNotification(title: string, body: string, icon = '/favicon.ico'): void {
  playNotificationSound();

  try {
    if (getNotificationPermission() === 'granted') {
      if ('serviceWorker' in navigator && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready
          .then(registration => {
            (registration as any).showNotification(title, {
              body,
              icon,
              badge: icon,
              vibrate: [200, 100, 200]
            });
          })
          .catch(() => {
            try {
              new Notification(title, { body, icon } as any);
            } catch {}
          });
      } else {
        new Notification(title, { body, icon } as any);
      }
    }
  } catch (e) {
    console.warn('Native notification failed, falling back gracefully:', e);
  }
}
