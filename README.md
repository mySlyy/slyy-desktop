<div align="center">

# ● slyy

### Slyy desktop: a local-first workspace for AI agents

macOS · Windows · Linux — a brand of Wapsol GmbH · [slyy.ai](https://slyy.ai)

**[Download](https://github.com/mySlyy/releases/releases/latest)** · [slyy.ai](https://slyy.ai) · [Plugin development](docs/plugin-development.md)

</div>

Slyy brings projects, agents, models, plugins and workflows into one persistent
desktop workspace. Projects and data stay on your machine; models stay
replaceable. The UI ships in English and German.

> **Current release line: 0.23.x.**

## Install and update

Download the installer for your platform from
[Releases](https://github.com/mySlyy/releases/releases/latest):

| Platform | Package | Updates |
| --- | --- | --- |
| macOS (Apple silicon, Intel) | `Slyy-<version>-<arch>.dmg` | in-app |
| Windows x64 | `Slyy-Setup-<version>.exe` | in-app |
| Windows x64 (no install) | ZIP / portable | manual |
| Linux | AppImage (in-app), deb / rpm (manual) | |

Slyy keeps its data in `~/.slyy-gen2` and its app state in the `Slyy Gen2`
application-data folder, separate from any earlier Slyy Desktop or PI-Desktop
installation.

## Run from source

Requirements: Node.js `>=22.19`, pnpm `>=10`, stable Rust toolchain.

```bash
git clone https://github.com/mySlyy/slyy-desktop.git
cd slyy-desktop
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

Validate with `pnpm typecheck`, `pnpm lint` and `pnpm test`.
Architecture, specs and ADRs live under [`docs/`](docs/); contributor rules are
in [`AGENTS.md`](AGENTS.md).

## Origin and license

Slyy is based on [PI-Desktop](https://github.com/vastsa/PI-Desktop) and its Pi
agent runtime. Internal package names (`@pi-desktop/*`), environment variables
(`PI_DESKTOP_*`) and the `pi-desktop-host-core` binary keep their upstream
names on purpose; see
[`docs/adr/slyy-downstream-branding.md`](docs/adr/slyy-downstream-branding.md).

Licensed under the [GNU LGPL-3.0](LICENSE), like the upstream project.
