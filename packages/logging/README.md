# @jsails/logging

A record-first structured logging service for [JSails](https://jsails.org): every call builds a frozen `LogRecord` that pluggable channels (console, memory, null) receive and formatters (JSON, line) render, with optional diagnostics and signal sinks and a `loggingPlugin` that provides the logger as a typed service.

```sh
npm install @jsails/logging
```

Documentation: <https://jsails.org/docs/observability#logging>
