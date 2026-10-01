# @jsails/notifications

A multi-channel notification delivery seam for [JSails](https://jsails.org): defined notifications (`defineNotification`) delivered through mail (inline or queued), a database inbox with read/unread state, realtime broadcast, or your own channels, and `notificationsPlugin`, which exposes a `NotificationsService` that fans each notification out to named channels and aggregates failures into one value-free error.

```sh
npm install @jsails/notifications
```

Documentation: <https://jsails.org/docs/notifications>
