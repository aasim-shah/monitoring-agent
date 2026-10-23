# Handoff — M14.4 AI Assistant UI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m14-ai` |
| **Plan** | M14 plan Task 5 |
| **Workbooks** | WB-14 §8 |

## Delivered

- **Navigation:** "AI Assistant" is enabled for `ai.use` (owner, admin, operator, and analyst; not viewers). It opens `/orgs/:org/products/:product/ai`.
- **AI Assistant page:**
  - Your conversations from the last 90 days are on the left, with a "New conversation" button.
  - The chat shows stored messages, then live turns:
    - Each tool step shows while it runs ("Checking host metrics…") and when done ("Checked …" or "Could not check …").
    - The answer arrives once the run finishes.
  - The first question creates the conversation. A `?q=` query parameter fills in the question.
  - Notices appear when AI is turned off or no provider is configured.
- **`Answer`:**
  - `[E#]` citations become chips. Each opens an evidence panel with the tool, its status, links to the sources, and the data the model saw.
  - It shows a confidence chip and "Numbers checked against the evidence" when the answer is verified.
  - An unverified answer gets an alert listing the problems. A partial one says the investigation is incomplete.
  - Missing evidence is listed.
- **Incident detail:** an "Ask AI" link appears when AI is on and the member has `ai.use`. It asks about that incident's metrics, errors, and impact.
- **Settings:** an "AI assistant" card shows the provider and model and has an on/off switch.
- **`lib/sse.ts`:** `openEventStream` can now POST a JSON body.

## Tests

- `components/ai/ai.test.tsx` (6): citations open the evidence panel, the unverified and partial alerts, the chat streaming steps then the answer, a stream error, and the settings switch and the "no provider" notice.
- Also: the Ask AI link test, the nav test (enabled, and hidden for viewers), and the SSE POST test.
- The full web suite passes (141).
