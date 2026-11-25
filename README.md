# DSH Debate Bridge

Use `POST /dsh-debate/opponent/v2` for explicit effort. It accepts the legacy start body with required `model` (`provider/model`) and `reasoningEffort`, an exact adapter-owned ID. Success returns `{ sessionId, reasoningEffort }`. A malformed or unsupported request returns 400; a live or restored Session without a matching recorded next selection returns 409 without prompting or repinning it. Do not retry an explicit effort on the legacy endpoint.

`GET /dsh-debate/models` advertises `supportsReasoningEffort` and may include a `reasoningEfforts` list of `{ id, name }` on each model. Discovery does not replace live adapter validation.

`DSH_PROPOSER_REASONING_EFFORT` accompanies the active `DSH_PROPOSER_MODEL` only when the request header records a non-adapter-defaulted effort. The Debate Arena displays stored Proposer model and effort when available.
