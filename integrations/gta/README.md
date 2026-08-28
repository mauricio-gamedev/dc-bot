# GTA Interactive bootstrap

This directory tracks the Android/SA-MP bootstrap used to evaluate GTA: San Andreas as a MiojoPlays Interactive target.

## Current phase

Phase 1 only proves that the open-source SA-MP Mobile client can be built reproducibly for ARM64 in GitHub Actions.

Pinned upstream source:

- repository: `kuzia15/SAMP-Mobile`
- ref: `5e531514a0bbb3d56b1a72e51fa44b18cfaf2ee2` (`GTA-2.11`)
- Android ABI: `arm64-v8a`
- Java: 17
- compile/target SDK: 36
- NDK: `26.2.11394342`

The workflow is `.github/workflows/gta-samp-build.yml` and uploads `GTA-2.11-debug.apk` plus its SHA-256 checksum as an Actions artifact.

## Interactive direction

If the Android client test succeeds, the next phase is a separate open.mp server bridge:

`Kick chat -> MiojoPlays bot -> authenticated GTA bridge -> open.mp gamemode/filterscript -> in-game event`

Candidate live actions include player healing, weather changes, wanted level, vehicle/event spawns and controlled chaos events. Commands will be allowlisted, rate-limited and scoped to the streamer's own server.

## Game data

This repository and CI workflow do not contain or distribute proprietary GTA: San Andreas game assets. A legitimate compatible game installation/data set is required on the Android device for runtime testing.
