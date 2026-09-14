<p align="right">
  <a href="README.md">中文</a> | <strong>English</strong>
</p>

<div align="center">
  <img src="assets/four-star-dragon-ball.png" alt="Four-Star Dragon Ball" width="180">

  <h1>
    Dragon Ball Agent
    <br>
    <sub>Come forth, Shenron! Grant my wish!</sub>
  </h1>
</div>

After going to great lengths to collect ~~$200~~ all seven Dragon Balls...

**User:** Come forth, Shenron! Grant my wish!

**Shenron:** State your wish.

**User:** I want a GPT that can truly work with me over the long term! It should always remember what I am actually trying to accomplish. It should handle simple things on its own and bring in subagents for complex work. And no matter what happens, it must never interrupt me with questions—just decide everything by itself!

**Shenron:** That wish cannot be granted.

**User:** Why not?

**Shenron:** Your requirements contradict each other.

**User:** ...Fair enough. Let me revise it. Normally, it should use its own judgment. But when the goal is unclear, an important decision is at stake, or the cost could be significant, it should ask me. The rest of the time, it should not come running to me over every trivial detail.

**Shenron:** That can be granted.

**User:** One more thing! Subagents should not be summoned at random, either. It should handle simple work itself. When the method and the definition of done are already clear, it can delegate the task directly. But if a stage still calls for ongoing investigation, judgment, and changes of direction, put one lead in charge of the entire stage.

**Shenron:** Your wish is clear.

**User:** Then begin!

**Shenron:** Your wish is being granted.

...

**User:** Wait!

**Shenron:** Go on.

**User:** I changed my mind about that earlier part. If there is already a complete result, do not redo the same work just for the sake of “independent verification.” Only investigate further when there is an actual contradiction or gap.

**Shenron:** That can be granted.

---

A Codex instruction system for long-term collaboration. The primary agent continuously owns user understanding, overall design, core implementation, and final judgment, delegating bounded responsibilities when useful.

> Community configuration, not an official OpenAI project. Model, role, and tool support depends on the receiving environment.

## Working method

Follow an evolving loop: update understanding, fill information gaps, plan the next bounded round, then execute and evaluate its result. The overall route develops with evidence. Plan numbers make cumulative effort visible within a task; simple tasks need no formal numbering.

- Product development revisits value, experience, scope, and success criteria as ideas and feedback develop.
- Code development implements and verifies real usage paths, distinguishing local checks from complete outcomes.
- Deep research builds the decision-relevant domain framework, then selects candidates and deeper investigations while retaining reusable module-level value.
- Delegation divides responsibilities and outputs. The primary agent does not repeat delegated research through different sources, and still owns retained design, key code, and integration.

## Current structure

| Layer | Files | Purpose |
| --- | --- | --- |
| Global guidance | [global/AGENTS.md](global/AGENTS.md) | Work loop, authority, collaboration, and communication |
| Roles | [agents/](agents/README.md) | 10 self-contained role definitions |
| Task methods | [skills/](skills/) | Skills and supporting resources |
| Installation | [INSTALL.md](INSTALL.md), [examples/](examples/) | Merge installation and project adaptation |
| Release history | [docs/HISTORY.md](docs/HISTORY.md) | Current changes and previous versions |

Current hosts discover standalone role TOML files from the agent directory. A per-role entry in `config.toml` is not required. Keep the user's main model and check availability of models specified in role files.

## 12 Skills

| Area | Skills |
| --- | --- |
| Development and experience | `product-development`, `code-development`, `code-review`, `frontend-design` |
| Research and judgment | `deep-research`, `search-source-registry`, `company-research-brief`, `xy-axis-thinking` |
| Task state and communication | `workflow-state-distiller`, `workflow-route-mapper`, `eli5` |
| Instruction maintenance | `write-instructions-zh` |

Descriptions specify when a Skill applies; its body and references provide the method. External tools, plugins, and credentials are supplied by the receiving environment.

## Installation

Follow the [installation guide](INSTALL.md) to merge selected content while preserving existing configuration. Verify installed files, host discovery, and real task behavior separately. Clearly report anything not tested.

Historical shared Base files, Root configuration mirrors, and the forced-fork Hook are no longer active installation inputs. They remain accessible through [release history](docs/HISTORY.md). Personal configuration, sessions, memories, and secrets are excluded.

## License

Original repository content uses [MIT](LICENSE). Third-party files retain their own licenses and attribution; see [third-party notes](docs/THIRD_PARTY.md).

---

**User:** Great. By the way, I have one more wish.

**GPT:** You've reached your usage limit.
