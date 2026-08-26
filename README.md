# api-bus-app

A bus API application.

## Requirements

- Node.js 20+ (developed on Node 24)
- npm 11+

## Getting started

```bash
npm install
npm test
```

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the app |
| `npm test` | Run the test suite |
| `npm run lint` | Lint the source |

## CI

Every push and pull request to `main` runs the [CI workflow](.github/workflows/ci.yml)
on Node 20 and 22: install, lint, then test.
