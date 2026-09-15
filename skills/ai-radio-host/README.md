# AI Radio Host

Production Skill for One Radio's complete Chinese show-copy pipeline.

The Skill accepts a locked playlist and low, medium, or high host-break frequency. It researches facts, fixes placements, and drafts each break with a factual and program-position check. Checked drafts are internal checkpoints. One whole-show editorial pass proposes precise local edits, followed by affected-claim verification and final locking. Style preferences never trigger a metadata template. Sparse-fact short introductions are valid choices; unresolved factual claims are removed without adding release years or albums by default.

Integration boundary: this is the Skill contract, not proof that its caller implements the workflow. The runtime must dispatch `fact_check` and `show_edit`, retain checkpoints, apply edits, and lock the final version explicitly. Existing callers that only send `currentBreak` receive a fact check; they do not automatically gain a whole-show editorial pass. Runtime changes and live listening validation are separate work.

The account-playlist confirmation runtime requires completed research receipts for every song before writing. The configured LLM now directs real search and page-reading actions through `AutonomousMusicResearchService`: it chooses follow-up queries, follows discovered links, reads more text when needed, and decides when evidence is sufficient. Sources are not restricted to Wikipedia; song, album, and artist facts retain their actual subject, source URL, and a quote verified against the retrieved text. Search snippets alone cannot become evidence. There is no song-count, query-round, or fact-count cutoff.

`PublicMusicWebAccess` discovers links through Exa's hosted search MCP, with public Brave, 360 Search, and DuckDuckGo pages as alternate channels. It reads original HTML and tries the Jina reader when direct extraction fails. Exa supports anonymous searches with a service quota; the optional server environment variable `EXA_API_KEY` is sent in a header for an existing paid account. See [Exa's official MCP documentation](https://exa.ai/docs/reference/exa-mcp). No key is required to start, and this integration does not purchase a plan.

This follows the Web Access search/read/adapt workflow; it does not invoke the developer's personal browser or install the global Skill's CDP scripts. Public search services can rate-limit or change their HTML. Searches are queued, unavailable engines cool down, and repeated failures stop with an incomplete receipt rather than fabricated no-results. Network failures without sufficient alternative evidence block writing and preserve the playlist for retry. Completed receipts may be reused for 30 minutes in the same service instance. This gate does not establish the whole-show editorial integration described above.

Host copy has no minimum speaking duration. The runtime estimates duration from the final text instead of clamping sparse copy to five seconds or treating every web page as enough for a long introduction. TTS instructions require natural delivery and stop when the text ends; timing-padding directives are discarded. These are text estimates and request controls, not measured audio durations or evidence of live listening validation.

Existing generated files under `reports/`, if present locally, describe earlier evaluations and are not validation evidence for this revision.

- `SKILL.md`: routing, boundary, placement formula, and whole-show workflow
- `references/research-contract.md`: web research and source verification
- `references/writing-method.md`: placement, selective writing, examples, and read-aloud checks
- `references/generator-contract.md`: whole-show placement and single-break writer output
- `references/reviewer-contract.md`: factual gates, one whole-show edit, patch application, and stopping rules
- `evals/`: trigger behavior fixtures
