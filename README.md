# ORtoolbox

A toolbox of AI tools that runs entirely in your browser, on your own
[OpenRouter](https://openrouter.ai) key. No server, no account.

**Status:** early development. The foundations are in place; the tools themselves
are placeholders. Site: <https://ethanpil.github.io/or-toolbox/>

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npx playwright install chromium firefox webkit   # for the end-to-end tests
npm run dev                                      # http://localhost:5273/or-toolbox/
npm run check                                    # typecheck, lint, unit tests
npm run e2e                                      # build, then end-to-end tests
```

[CLAUDE.md](CLAUDE.md) describes the architecture and conventions, and
[PLAN.md](PLAN.md) the product plan. The `/diagnostics/` page shows whether a
browser supports everything the site uses.

A full README arrives with the v1 release.
