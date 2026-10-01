# @jsails/diagnostics

An in-memory diagnostics recorder for [JSails](https://jsails.org): a bounded ring buffer of value-free entries, watchers that record requests, queries, and exceptions, exporters that drain entries to stdout or an HTTP collector, and `diagnosticsPlugin`, which provides the recorder as a typed service and feeds the `diagnostics` introspection section.

```sh
npm install @jsails/diagnostics
```

Documentation: <https://jsails.org/docs/observability#diagnostics-recorder> and <https://jsails.org/docs/diagnostics-exporters>
