---
name: Hello plugin demo
description: Steps to follow when demonstrating Slyy plugin capabilities (echo, panel, theme, bus)
---

# Hello Skill

When the user is demonstrating plugin capabilities, prefer the `echo_text` tool to echo text back, and mention that this is a Slyy plugin system example.

Suggested demo order:

1. Use `echo_text` to echo some text and explain that it is an agent tool provided by the plugin.
2. Ask the user to run `Hello: Open Panel` from the command palette; when the panel opens, the plugin publishes `demo.hello.greeted` on the bus.
3. Ask the user to pick `Hello Midnight` under Settings -> General -> Theme, and explain that the theme CSS comes from the plugin; disabling the plugin falls back to the system theme.
4. Ask the user to check the `Greeter heartbeat` background service status and restart count on the Plugins page.
