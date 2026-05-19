//! Individual lookup sources for the query resolver.
//!
//! Each source exposes a single async `lookup(client, query, limit) ->
//! Result<Vec<(String, String)>, String>` function returning `(artist,
//! title)` pairs. Sources must not panic on network errors — they return
//! `Err(String)` which the orchestrator logs but otherwise treats as an
//! empty result.

pub mod brave;
