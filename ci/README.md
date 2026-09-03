# CI recipes (not active)

These files are kept as recipes only. Nothing here runs: GitHub Actions only
picks up workflows under `.github/workflows/`, and this repository
deliberately does not have that directory.

## github-actions-wasm.yml

Builds `emnp21kai_sdl2` with Emscripten on every push and uploads the
`.html`/`.js`/`.wasm` as an artifact. To turn it on:

    mkdir -p .github/workflows
    cp ci/github-actions-wasm.yml .github/workflows/wasm.yml

Pushing a file under `.github/workflows/` needs a token with the `workflow`
scope (`gh auth refresh -h github.com -s workflow`).

Note that the GitHub Pages site is served straight from the `main` branch
root, not from a workflow, so the browser demo does not depend on this.
