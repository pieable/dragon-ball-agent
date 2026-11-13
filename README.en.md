# Dragon Ball Agent

A shared source of working principles and skills for Codex, Claude Code, DeepSeek Harness and Antigravity, with native adapters and local private layers.

The current branch builds isolated candidates from 19 skills and 194 reviewed source files. Codex includes 11 native roles. Other hosts retain unresolved native role, permission and lifecycle differences. Full candidates are not deployment-ready; actual host loading and integration validation remain pending.

- [Chinese guide](README.md)
- [Build, preview and recovery](INSTALL.md)
- [Host capabilities](docs/HOST-CAPABILITIES.md)
- [Local materials and licensing](docs/SKILL-LAYERS.md)
- [Integration catalog](integrations/README.md)

The synchronizer performs three-way comparison, preserves local changes, backs up managed changes and supports explicit rollback. It does not copy credentials, private histories, unsupported assets or host-managed runtimes. Dependencies are reported explicitly rather than silently removed.

Original work is MIT-licensed; included third-party materials retain their own terms.
