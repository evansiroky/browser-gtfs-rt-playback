# Architecture

Foundational technical decisions for browser-gtfs-rt-playback.

## Purpose

A browser-based tool for playing back GTFS Realtime (GTFS-RT) data.

## Status

The repository is new: no code, stack, or structure has been decided yet. This file is the
place to record those decisions *before* building against them. Cover, as each is settled:

- Language, framework, and build tooling
- Where GTFS-RT feeds and static GTFS data come from, and how they are loaded in the browser
- How recorded or archived feed data is represented and stored
- Playback model: how time, speed, and seeking map to feed snapshots
- Hosting and deployment

Until then, nothing here is a requirement; do not infer one from this file's absence.
