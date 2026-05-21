# Contributing to neegde

## Before you start

Read the [wiki](https://wiki.neegde.ru) — it covers the architecture, streaming internals, search pipeline, and key invariants. Pull requests that break the invariants listed there will be asked to fix them.

## Dev setup

```bash
# macOS
brew install libtorrent-rasterbar

# Ubuntu
sudo apt-get install libtorrent-rasterbar-dev cmake

git clone --recurse-submodules https://github.com/neegde/neegde-tauri.git
cd neegde-tauri
npm install
cargo tauri dev
```

Requirements: Node 20+, Rust stable, CMake 3.20+.

Fast type check without C++: `cargo check`

## Submitting a pull request

- Base your branch off `dev`, target `dev` (not `main`).
- One logical change per PR. If it touches Rust and frontend, that's fine — if it's two unrelated features, split them.
- Run `cargo fmt`, `cargo clippy`, and `npm run typecheck` before pushing.
- Every PR gets a meme. This is not optional.

## Reporting bugs

Open an [issue](https://github.com/neegde/neegde-tauri/issues). Include: what you did, what you expected, what happened, and your OS + build type (dev/release).

## Scope

neegde streams from RuTracker and SoulSeek. Features that add new sources, new playback backends, or general-purpose download managers are outside scope and probably won't be merged. Fixes, performance improvements, and platform support are welcome.
