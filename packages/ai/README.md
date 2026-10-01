# @jsails/ai

A provider-neutral AI runtime for [JSails](https://jsails.org): `createAiRuntime` owns message validation, the tool-calling agent loop, and its bounds over an injectable `AiTransport`, `aiTool` turns a `jsails/data` contract into a validated tool, and the built-in transports talk to any chat-completion HTTP endpoint or an MCP server without bundling a provider SDK.

```sh
npm install @jsails/ai
```

Documentation: <https://jsails.org/docs/ai>
