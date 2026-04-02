# API Compatibility Checklist

This project ships a Chrome extension that updates slowly, and backend services that may change frequently.
The backend must remain backward compatible with already-published plugin versions.

## Compatibility Rule

- Keep old endpoints working.
- Add fields, but do not remove or rename existing fields used by the plugin.
- Preserve response status semantics for plugin-critical paths.
- Treat the proxy registry service and proxy service as compatibility layers for existing plugin builds.

## Plugin-Critical Registry Service Contract

Service: `server/server.js`

Required endpoints:

- `GET /health`
- `GET /api/proxies/select`
- `POST /api/downloads/start`
- `POST /api/downloads/complete`
- `POST /api/downloads/fail`
- `POST /api/proxies/heartbeat`
- `POST /api/proxies/download-events`

Critical behaviors:

- `GET /api/proxies/select` must continue to return `200` with `data.proxy.baseUrl` when a healthy registered proxy exists.
- `GET /api/proxies/select` must continue to return `404` when no healthy registered proxy exists.
- Download lifecycle endpoints must remain best-effort and accept the current plugin payload shape.
- Registry service must not silently substitute static fallback proxies for the plugin.

Additive metadata now exposed:

- `apiVersion`
- `capabilities`

## Plugin-Critical Proxy Service Contract

Service: `proxy_server/service.js`

Required endpoints:

- `GET /health`
- `GET /proxy?url=...`
- `GET /api/node-status`

Critical behaviors:

- `/proxy?url=...` must continue to proxy Docker token, manifest, and blob requests.
- Request headers used by the plugin must continue to pass through:
  - `Authorization`
  - `X-Download-Id`
  - `X-Image`
  - `X-Tag`
  - `X-Arch`
- Large blob requests must continue to stream rather than buffer the entire response in memory.
- Existing response content types and status handling for token/manifest/blob fetches must remain compatible.

Additive metadata now exposed:

- `apiVersion`
- `capabilities`
- `activeTransfers` in `/api/node-status`

## Safe Backend Changes

- Add new fields to existing JSON responses.
- Add new non-breaking endpoints such as `/api/v2/...`.
- Improve retries, caching, dashboards, logging, or transfer monitoring.
- Add health metadata and capability negotiation fields.

## Unsafe Backend Changes

- Renaming `/api/proxies/select` or `/proxy`.
- Removing `proxy.baseUrl` from proxy selection responses.
- Changing success responses to a different shape without preserving old fields.
- Changing proxy selection failures from `404` to `200` with an empty object.
- Requiring new request fields from existing plugin builds.
- Making `/proxy` return buffered JSON wrappers instead of the proxied body.

## Release Checklist

Before shipping backend changes:

- Verify `GET /health` still returns `ok: true`.
- Verify `GET /api/proxies/select` still returns a usable `proxy.baseUrl`.
- Verify the plugin can still fetch:
  - Docker token
  - tag manifest
  - arch manifest
  - blob
- Verify a completed download still reaches:
  - `/api/downloads/start`
  - `/api/downloads/complete`
- Verify a failed download still reaches:
  - `/api/downloads/fail`
- Verify `/proxy?url=...` still works for large blobs.

## Versioning Guidance

- `apiVersion` is informational and additive.
- Do not gate existing plugin behavior on `apiVersion`.
- When introducing a breaking backend contract, add a new endpoint version and keep the old one alive until the plugin rollout is complete.
