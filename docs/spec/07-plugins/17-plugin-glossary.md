# 17. Plugin glossary

This reference standardizes plugin terminology for plugin authoring and
documentation review, including distinctions that affect execution and
authorization. Each entry links to its contract; detailed behavior belongs to
that contract and the current implementation.

## 1. Usage conventions

- Preserve identifier spelling and case, including `agent.extension`, `manifest.renderer`, `sessionId` and `turnId`; translated UI labels are not API names.
- Distinguish host (the application) from a network host, and runtime (the execution environment) from elapsed running time. Qualify the component and API when discussing processes, authorization or IDs.
- Reserve proxy for a network intermediary; never use it for the Agent or the plugin call broker.
- Quote UI labels, logs and protocol literals with their original names.

## 2. Execution and trust

| Term | Meaning and usage | Contract |
|---|---|---|
| Agent | The model-driven execution loop that reasons and invokes tools. Use Agent in plugin prose; reserve proxy for a network intermediary. | [Agent runtime](../03-runtime/02-agent-runtime.md) |
| Host | Slyy as the application that loads plugins and supplies APIs. Name Electron Main or Rust host-core when the responsible component matters. | [Process model](../03-runtime/07-process-model.md) |
| Rust host-core | The Rust component that owns SQLite, durable host state and native host operations; distinct from the Electron main process. | [Process model](../03-runtime/07-process-model.md) |
| Agent Runtime | The Node runtime that integrates the agent loop, model calls, tools and agent extensions. Runtime means the execution environment, not elapsed time. | [Agent runtime](../03-runtime/02-agent-runtime.md) |
| Sidecar | A host-managed child process, such as Rust host-core or the Node Agent Runtime. Specify which sidecar; the word alone does not identify a trust boundary. | [Process model](../03-runtime/07-process-model.md) |
| Plugin process | The separate Electron `utilityProcess` that evaluates a plugin main entry. Its raw Node APIs retain the operating-system user's privileges. | [Spec 01](01-plugin-system.md) |
| Renderer | The Electron process that renders UI. Distinguish the application renderer, which hosts trusted renderer extensions, from isolated plugin panel/view pages. | [Process model](../03-runtime/07-process-model.md) |
| Process isolation | Running plugin main code in a separate process so it has no live Electron Main objects. This does not confine raw Node filesystem or network access. | [Spec 04](04-plugin-security.md) |

## 3. Plugin contributions

| Term | Meaning and usage | Contract |
|---|---|---|
| Plugin | The manifest-based unit of installation, enablement, permissions and contributions in Slyy. Agent extensions are contributions owned by a plugin. | [Spec 01](01-plugin-system.md) |
| Manifest | The `manifest.json` declaration of identity, entries, permissions and contributed features. A declaration requests a capability; it is not itself user authorization. | [Spec 02](02-plugin-manifest-schema.md) |
| Contribution / contribution point | A contribution is a declared feature, such as a command or theme; a contribution point is the host-defined place or field accepting it, such as `contributes.commands`. | [Spec 02](02-plugin-manifest-schema.md) |
| Command | A registered action callable from the command palette or an authorized shortcut. A command registration does not by itself register an Agent tool. | [Spec 09](09-plugin-command-palette.md) |
| Agent tool | An operation exposed to the Agent with a name, description, argument schema and execute handler. Plugin tool names are namespaced by the host. | [Spec 03](03-plugin-api.md) |
| Skill | A discoverable instruction document whose body can be loaded into model context. A skill is not an executable `ExtensionAPI` module or an MCP server. | [Spec 01](01-plugin-system.md) |
| MCP server | A Model Context Protocol server whose tools can be exposed to the Agent. Plugin contributions declare stdio or HTTP transport with the corresponding permission. | [Spec 02](02-plugin-manifest-schema.md) |
| Background service | A declared resident service registered by the plugin and started/stopped under host supervision inside the plugin process. It is not a separate OS service. | [Spec 05](05-plugin-lifecycle.md) |
| Provider | A host provider record representing a model-service integration, including its protocol and authentication configuration. Plugin provider contributions create host-owned records. | [Spec 02](02-plugin-manifest-schema.md) |
| Adapter | An implementation layer that maps a protocol or API onto the runtime, such as a speech adapter or the Desktop `ExtensionAPI` adapter. Name the adapted interface. | [Spec 16](16-trusted-extensions.md) |
| Agent extension / trusted extension | A `contributes.agentExtensions` module executed inside the Agent sidecar through the supported `ExtensionAPI` subset, requiring `agent.extension`. It does not run in the plugin main process. | [Spec 16](16-trusted-extensions.md) |
| Renderer extension | The ES module named by `manifest.renderer`, loaded into the application renderer with `renderer.extension`. It shares the host document; UI slots are not a sandbox. | [Spec 13](13-plugin-permissions-matrix.md) |

## 4. UI surfaces

| Term | Meaning and usage | Contract |
|---|---|---|
| Plugin panel | The isolated HTML entry named by `manifest.ui.panel`, opened in a separate `BrowserWindow` with the `ui.panel` permission. A floating widget is a panel placement, not a renderer extension. | [Spec 03](03-plugin-api.md) |
| Work panel view | A `contributes.views` HTML surface docked in the application work panel. It uses the same panel bridge and isolation policy as detached plugin panels. | [Spec 03](03-plugin-api.md) |
| UI slot | A host-defined mount point where a renderer extension registers a component with `pi.slots.register`. It belongs to the host document, unlike an isolated HTML view. | [Spec 13](13-plugin-permissions-matrix.md) |
| Composer | The chat input surface that holds the draft and attachments. Distinguish a user-invoked composer transform from an Agent tool or automatic message submission. | [Spec 03](03-plugin-api.md) |

## 5. Authorization and execution context

| Term | Meaning and usage | Contract |
|---|---|---|
| Permission | A named host API capability, such as `fs.read` or `agent.extension`, declared in `manifest.permissions`. Its risk label is not a grant. | [Spec 13](13-plugin-permissions-matrix.md) |
| Grant | The host-recorded approval of a requested permission. Brokered API admission checks declared and granted permissions together, plus applicable resource constraints. | [Spec 04](04-plugin-security.md) |
| Consent / confirmation | The user's answer to a host-owned approval prompt, such as an out-of-scope file request. Do not assume every permission check opens a first-use prompt. | [Spec 04](04-plugin-security.md) |
| Activation scope | The global or project-limited selection controlling where an enabled plugin applies. It does not grant filesystem access or replace permission grants. | [Spec 01](01-plugin-system.md) |
| Filesystem scope | Root-relative patterns in `manifest.fs.read.scope`, `manifest.fs.write.scope` and `manifest.fs.delete.scope` bound brokered file operations. Distinguish these from the plugin's activation scope. | [Spec 04](04-plugin-security.md) |
| Plugin-private data directory | The calling plugin's directory returned by `pi.plugin.getDataPath()`, separate from its code and the host database. Private namespacing is not an OS sandbox. | [Spec 11](11-plugin-storage-isolation.md) |
| Workspace | The current project-folder context reported by `pi.workspace.get()`, including a primary root and optional group roots. Reading this metadata grants no file access; a `remote-project:` identity is not a local path. | [Spec 03](03-plugin-api.md) |
| Project / project group | A project row and a logical folder group are different host entities. The `projectId` on each `pi.projects.list()` result row identifies a project; the `projectId` returned by `pi.workspace.get()` identifies a group. These IDs are not interchangeable. | [Spec 03](03-plugin-api.md) |
| Session | The Agent conversation identified by `sessionId`, with its own transcript and runtime context. It is distinct from a Chromium session partition. | [Spec 03](03-plugin-api.md) |
| Turn | One host-tracked execution within a session, identified by `turnId`. It can include multiple model requests and tool calls; a terminal state need not mean task success. | [Spec 03](03-plugin-api.md) |
| Model context | The messages and instructions prepared for a model request. `session.getLlmContext` returns a bounded, compaction-aware projection of the invoking tool session, not unrestricted transcript access. | [Spec 03](03-plugin-api.md) |

## 6. Communication and isolation

| Term | Meaning and usage | Contract |
|---|---|---|
| IPC | Communication across process boundaries. Application renderer IPC, the plugin-process channel and the panel bridge have different callers and callable vocabularies. | [Spec 12](12-plugin-ipc-and-host-services.md) |
| RPC | A request/response invocation across a boundary. Remote here does not require a network host; the plugin broker also exchanges calls over local process messaging. | [Spec 12](12-plugin-ipc-and-host-services.md) |
| Broker | The Electron Main dispatcher that routes plugin `pi.*` calls, checks permissions and resource policy, and invokes host services. It is not a network proxy. | [Spec 12](12-plugin-ipc-and-host-services.md) |
| Panel bridge | The preload-exposed `window.pluginBridge` interface used by isolated panel/view pages. It does not expose the plugin process's full pi object. | [Spec 03](03-plugin-api.md) |
| Message bus | Host-routed publish/subscribe messaging between plugins, bounded by declared topics/patterns and grants. A received payload conveys data, not additional authority. | [Spec 04](04-plugin-security.md) |
| Sandbox | An enforced execution boundary. Plugin panel/view pages have Electron sandboxing and no Node integration; plugin main code and trusted renderer/Agent extensions have different trust models. | [Spec 04](04-plugin-security.md) |
| Session partition | The per-plugin Chromium storage/cookie session used by panel/view pages. It is not an Agent session or a separate OS user. | [Spec 04](04-plugin-security.md) |
| Egress allowlist | The `manifest.net.domains` rules checked on host-mediated network paths. The separate `net.anyHost` grant controls allowlist exemptions; other endpoint restrictions still apply. This policy does not sandbox raw Node networking. | [Spec 04](04-plugin-security.md) |
| Network proxy | A configured intermediary for outbound HTTP/SOCKS traffic. Keep proxy distinct from Agent and from the plugin call broker. | [ADR 0177](../../adr/0177-user-configurable-outbound-proxy.md) |

## 7. Lifecycle

| Term | Meaning and usage | Contract |
|---|---|---|
| Enabled / loaded | Enabled is the persisted user choice; loaded means the current runtime instance is present. A registry entry alone is not proof that the process is running. | [Spec 05](05-plugin-lifecycle.md) |
| Hot reload | Reloading a development plugin after source changes. The host checks the recorded permission/file-scope approval; a manifest edit does not silently widen the approved reach. | [Spec 10](10-plugin-devex.md) |
| Unload / uninstall | Unload ends the runtime instance and withdraws resources while retaining private data. Uninstall removes the registry row and managed code/private data by default, while preserving development source. | [Spec 11](11-plugin-storage-isolation.md) |
