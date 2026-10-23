# Handoff — M11.1 Log viewer UI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m11-logs` |
| **Plan** | M11 plan Task 5 |
| **Workbooks** | WB-12 UC-12-01 |

## Delivered

- **The server page** (`infrastructure/[agentId]`) gains a **Logs** section for members with `logs.tail`.
  - It shows one button per source from `GET /log-sources`: each monitored pack's logs, plus "System journal".
  - One tail is open at a time.
- **`LogViewer`** (`components/logs/log-viewer.tsx`):
  - **States:** Connecting…, Waiting for new lines…, Live, Stream ended, and Stopped with the API's reason as an alert (for example "At most 2 live tails per agent").
  - **Controls:** Pause (incoming lines are buffered, with a "N new lines" count), Resume (flushes them), Clear, and Close.
  - **Display:**
    - It keeps the newest 2,000 lines.
    - It scrolls to new lines unless the user scrolled up.
    - `[pcp] …` notices (dropped lines, stream stopped) are shown in italics.
  - **Note:** "Masked on the server before sending; nothing is stored."
  - **Closing:** closing or leaving the page aborts the stream, so the API closes the session and the agent stops.
- **`lib/sse.ts`:** `SseParser` and `openEventStream(url, handlers)`.

## Tests

- `log-viewer.test.tsx`:
  - lines append and the view caps at 2,000
  - dropped-line notices are marked
  - Pause buffers and Resume flushes; Clear empties the view
  - the end of the stream and error reasons are shown
  - closing and unmounting disconnect
- `log-sources.test.tsx`: the source list comes from the API; nothing renders without `logs.tail`.
- `lib/sse.test.ts`: events split across chunks, comments skipped, and a 429 message surfaced.
