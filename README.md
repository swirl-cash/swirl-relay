# SWIRL Relay

Independent transaction Relayer with dynamic Gas quotes and private fee notes.

## Source layout

- `packages/relay/src`: quote validation, dynamic fees, POI checks, submission and refill logic.
- `packages/relay/src/*.test.ts`: 23 Relayer tests in the integrated suite.

This is the component source snapshot of the tested SWIRL Protocol workspace. For the root dependency lockfile, integrated build and complete cross-component test flow, use [swirl-protocol](https://github.com/swirl-cash/swirl-protocol).

Never commit real private keys, recovery phrases, API credentials, server environment files or local service state. Public contract addresses, verification keys and proving artifacts are not account credentials.
