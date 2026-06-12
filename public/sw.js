// Service worker: shows the daily reminder push and opens the app on tap.
// Pushes are sent without a payload (simpler and avoids Web Push encryption),
// so the notification text is fixed here.

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('🏆 Family Leaderboard', {
      body: 'Time to check in — how did yesterday go?',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'daily-reminder', // replaces any unread reminder instead of stacking
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) =>
      wins.length ? wins[0].focus() : self.clients.openWindow('/')
    )
  );
});
