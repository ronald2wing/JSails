# @jsails/notifications

A multi-channel notification delivery seam for [JSails](https://jsails.org): a small `NotificationMessage` contract that any channel can consume, an in-memory channel for tests, a mail channel over `@jsails/mail`, and `notificationsPlugin`, which exposes a `NotificationsService` that fans each message out to named channels and aggregates failures into one value-free error.

```sh
npm install @jsails/notifications
```

Documentation: <https://jsails.org/docs/services#notifications>
