# Max Self-Hosted Bot — Milestone D v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WebSocket client connecting to `wss://max-bot-production-7455.up.railway.app/ws_in/:bot_id` and writing raw 16 kHz mono Int16 PCM frames causes those frames to be broadcast as Max's microphone in the meeting — every participant hears them, with NO echo of their own voice (which was the bug in Milestone D v1).

**Architecture:** Add a second `module-null-sink` (`virtual_mic_input`) dedicated to the injection path. The existing `module-virtual-source virtual_mic` gets an explicit `master=virtual_mic_input.monitor` argument, breaking the unintended loopback from `virtual_speaker.monitor`. ffmpeg writes audio to `pulse:virtual_mic_input` (a sink, which is writable) instead of trying to write to a source. PulseAudio routes the bytes through the new sink's monitor to `virtual_mic`, which Chrome's `getUserMedia` uses. No FIFO. No `module-pipe-source`. No mystery PulseAudio startup issue from Milestone D v1.

**Tech Stack:** PulseAudio (already running in production), ffmpeg (already installed), TypeScript, Node 20, Playwright Chromium with `--use-fake-ui-for-media-stream`.

**Pre-conditions in place:**
- Production is HEALTHY on PR #18's revert. `/health` returns 200. Dockerfile has `module-virtual-source` with no explicit master (the loopback bug).
- `src/bot/audioInject.ts` is currently INCONSISTENT: it writes to `/tmp/pulse/virtual_mic.fifo` (from PR #14, never reverted). That path doesn't exist in production, so AudioInject's ffmpeg subprocess will silently fail when /join is called and `/ws_in/` clients connect.
- `src/bot/audioInject.test.ts` is also still in the PR #14 FIFO-shaped state.
- All other Milestone D v1 code is intact: `wsServer.ts` has `/ws_in/:bot_id`, `app.ts` constructs AudioInject in `/join`, `/diag/inject/:bot_id` works.
- Memory rules from yesterday: do not seek workarounds, listen to symptoms, no apostrophes in Dockerfile heredocs.

**What ships at end of Milestone D v2:**
- `/diag/pulse` shows TWO null-sinks (`virtual_speaker`, `virtual_mic_input`) and ONE virtual-source (`virtual_mic` with explicit master)
- `POST /join` succeeds, AudioInject's ffmpeg writes to `pulse:virtual_mic_input` (alive, exit_code null)
- Streaming a WAV via `scripts/play-audio-to-bot.js` is heard by Suren in the meeting as Max's voice
- Critically: **no echo of Suren's own voice through Max**

**Out of scope:**
- max-brain integration (Milestone E)
- Hardening, auto-reconnect, multi-bot (Milestone F)
- Investigating WHY PR #17's PulseAudio crashed — we're sidestepping that issue entirely because we never touch /start.sh's mkfifo lines (those don't exist in this plan)

---

## What this plan does NOT do (deliberately)

- **Does NOT use `module-pipe-source` or FIFOs.** That was Milestone D v1's broken approach. Five PRs of attempted fixes documented in memory.
- **Does NOT switch to Web Audio injection.** That was the "pivot" approach Suren correctly rejected as seeking a way out.
- **Does NOT install new system packages.** No `libasound2-plugins` etc. We use the existing ffmpeg → pulse path.
- **Does NOT change AudioInject's API contract** with the rest of the system. `pushInt16Buffer(buf)` stays the same; only the ffmpeg output target changes.

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `Dockerfile` | Modify | `/start.sh` heredoc: add second `module-null-sink sink_name=virtual_mic_input`. Modify `module-virtual-source virtual_mic` to include `master=virtual_mic_input.monitor`. Add `\|\| true` on the two `pactl set-default-*` calls so they don't crash /start.sh if a module load failed. |
| `src/bot/audioInject.ts` | Modify | Revert from FIFO-target back to pulse-sink-target. ffmpeg args: `-f pulse virtual_mic_input` instead of `-f s16le /tmp/pulse/virtual_mic.fifo`. Constructor option renamed `fifoPath` → `pulseSink` (default `virtual_mic_input`). |
| `src/bot/audioInject.test.ts` | Modify | Tests updated for new option name + new ffmpeg arg shape. |
| `docs/CLAUDE-NOTES.md` | Modify | Append Milestone D v2 section with the actual fix and lessons. |

**Files we deliberately do NOT touch:**
- `src/app.ts` — `/join` and `/diag/inject/:bot_id` already work with AudioInject's API; only internals change
- `src/bot/wsServer.ts` — `/ws_in/:bot_id` already calls `session.audioInject.pushInt16Buffer(buf)` correctly
- `src/bot/sessions.ts` — schema unchanged
- `src/bot/joinMeet.ts`, `audioCapture.ts`, `audioStream.ts` — unrelated to injection
- `scripts/play-audio-to-bot.js` — already works
- Everything else in upstream meet-teams-bot — stays untouched

---

## Decisions locked in for D v2

- **Two-null-sinks + virtual-source-with-master pattern.** This is the canonical PulseAudio way to route writable audio into a source. Avoids FIFOs entirely. Module-virtual-source's `master=` argument is what should have been there from the start.
- **ffmpeg target `pulse:virtual_mic_input`.** PulseAudio's pipe lib (libpulse), not ALSA's pulse plugin (which would need `libasound2-plugins`). This is the `-f pulse` approach from PR #13, just pointing at the new sink instead of the source.
- **Harden /start.sh against partial failures.** Add `|| true` on the two `pactl set-default-*` calls. If they fail (because a module load returned non-zero), don't kill the whole script.
- **No mkfifo, no dummy writer, no module-pipe-source.** Lessons learned from v1.
- **No new system packages.** Just rearrange existing modules.

---

## Task D2.0: Branch + sanity check current state

**Files:** None modified.

- [ ] **Step 1: Branch from main**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-d-v2/null-sink-routing
```

- [ ] **Step 2: Confirm current state matches memory**

```bash
grep -nE "load-module|virtual_mic" Dockerfile
```

Expected output (PR #18 revert state):
```
88:pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
90:pactl load-module module-virtual-source source_name=virtual_mic\n\
92:pactl set-default-source virtual_mic\n\
```

```bash
grep -nE "fifoPath|virtual_mic.fifo" src/bot/audioInject.ts
```

Expected: matches present (audioInject.ts is in inconsistent FIFO state).

- [ ] **Step 3: Verify production /health and /diag**

```bash
curl -s https://max-bot-production-7455.up.railway.app/health
# expected: {"status":"ok","service":"max-bot","version":"0.1.0"}

curl -s https://max-bot-production-7455.up.railway.app/diag | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('pulse_sources:')
print(d['pulse_sources'][:300])
"
# expected: virtual_mic listed as module-virtual-source.c (loopback bug present)
```

- [ ] **Step 4: Verify Node + jest available**

```bash
unset NODE_ENV
source ~/.nvm/nvm.sh && nvm use 20
node --version
ls node_modules/.bin/jest && echo "jest-ok" || echo "jest-MISSING"
```

If jest missing: `npm ci --include=dev`.

- [ ] **Step 5: Run existing tests to confirm baseline**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: `Tests: 38 passed, 38 total`.

If a test fails because of the FIFO state, note which one — D2.2 will fix it.

---

## Task D2.1: Fix audioInject.test.ts — failing tests for new ffmpeg args (TDD red)

**Files:**
- Modify: `src/bot/audioInject.test.ts`

We update the tests FIRST to specify the new behavior: ffmpeg targets `pulse:virtual_mic_input`, option name is `pulseSink`.

- [ ] **Step 1: Open `src/bot/audioInject.test.ts` and replace the option-name tests**

Find this block (around line 80-105):

```typescript
    it('spawns ffmpeg with f32le float-input + s16le FIFO output', () => {
        new AudioInject({
            sampleRate: 16000,
            fifoPath: '/tmp/pulse/virtual_mic.fifo',
        })
        const cmd = mocks.spawnMock.mock.calls[0][0]
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(cmd).toBe('ffmpeg')
        expect(args).toEqual(
            expect.arrayContaining([
                '-f',
                'f32le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-i',
                '-',
                '-f',
                's16le',
                '/tmp/pulse/virtual_mic.fifo',
            ]),
        )
    })

    it('defaults fifoPath to /tmp/pulse/virtual_mic.fifo', () => {
        new AudioInject({ sampleRate: 16000 })
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(args).toContain('/tmp/pulse/virtual_mic.fifo')
        expect(args).toContain('s16le')
    })
```

Replace with:

```typescript
    it('spawns ffmpeg with f32le float-input + pulse sink output', () => {
        new AudioInject({
            sampleRate: 16000,
            pulseSink: 'virtual_mic_input',
        })
        const cmd = mocks.spawnMock.mock.calls[0][0]
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(cmd).toBe('ffmpeg')
        expect(args).toEqual(
            expect.arrayContaining([
                '-f',
                'f32le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-i',
                '-',
                '-f',
                'pulse',
                'virtual_mic_input',
            ]),
        )
    })

    it('defaults pulseSink to virtual_mic_input', () => {
        new AudioInject({ sampleRate: 16000 })
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(args).toContain('virtual_mic_input')
        expect(args).toContain('-f')
        expect(args).toContain('pulse')
    })
```

- [ ] **Step 2: Run the test to verify red**

```bash
./node_modules/.bin/jest src/bot/audioInject.test.ts --runInBand 2>&1 | tail -10
```

Expected: 2 failures around the new tests because the implementation still writes to FIFO with `-f s16le`.

---

## Task D2.2: Fix audioInject.ts implementation (TDD green)

**Files:**
- Modify: `src/bot/audioInject.ts`

- [ ] **Step 1: Replace the constructor + spawn args**

Open `src/bot/audioInject.ts`. Find the `AudioInjectOptions` interface and the constructor body. Replace them with:

```typescript
export interface AudioInjectOptions {
    sampleRate: number
    /**
     * PulseAudio sink name to write audio into. Default 'virtual_mic_input'.
     * The sink's monitor is the master of the virtual_mic source, so audio
     * written here surfaces as Max's microphone in Chrome's getUserMedia.
     */
    pulseSink?: string
}

export class AudioInject extends EventEmitter {
    public readonly child: ChildProcess
    public stderrTail: string[] = []
    private stopped = false

    constructor(opts: AudioInjectOptions) {
        super()
        const sink = opts.pulseSink ?? 'virtual_mic_input'
        // Write Float32 audio into a PulseAudio sink. The sink is a
        // null-sink in /start.sh whose monitor is set as the master of
        // the virtual_mic source. Chrome's getUserMedia reads from
        // virtual_mic, so what we write here becomes Max's mic.
        //
        // Why a sink (not module-pipe-source / FIFO): Milestone D v1
        // attempted module-pipe-source with FIFOs; that approach hit a
        // PulseAudio startup failure we couldn't root-cause in 5 PRs.
        // The null-sink-monitor → virtual-source pattern is canonical
        // PulseAudio and avoids that whole class of problem.
        //
        // Why -f pulse (not -f alsa pulse:foo): libasound2-plugins is
        // not installed in the upstream Dockerfile, so the ALSA pulse
        // plugin isn't available. -f pulse uses libpulse directly,
        // which IS installed via pulseaudio-utils.
        const args = [
            '-loglevel',
            'warning',
            '-f',
            'f32le',
            '-ar',
            String(opts.sampleRate),
            '-ac',
            '1',
            '-i',
            '-',
            '-f',
            'pulse',
            sink,
        ]
        this.child = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        // Capture stderr so /diag/inject can surface why ffmpeg died.
        this.child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            this.stderrTail.push(text)
            if (this.stderrTail.length > 20) {
                this.stderrTail.splice(0, this.stderrTail.length - 20)
            }
        })
        this.child.on('error', (err) => this.emit('error', err))
        this.child.on('exit', (code) => this.emit('exit', code ?? -1))
    }
```

Keep `pushInt16Buffer` and `stop` unchanged below this block.

- [ ] **Step 2: Run tests to verify green**

```bash
./node_modules/.bin/jest src/bot/audioInject.test.ts --runInBand 2>&1 | tail -8
```

Expected: 7/7 tests pass.

- [ ] **Step 3: Run full suite as regression check**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: `Tests: 38 passed, 38 total`.

- [ ] **Step 4: Commit**

```bash
git add src/bot/audioInject.ts src/bot/audioInject.test.ts
git commit -m "fix(audioInject): write to PulseAudio sink, not FIFO

Reverts the FIFO-target approach from PR #14 (which was abandoned
in PR #18's Dockerfile revert) back to writing into a PulseAudio
sink via -f pulse. The new sink (virtual_mic_input) will be added
to /start.sh in the next task.

This resolves the state inconsistency where Dockerfile expected one
audio path but audioInject.ts targeted a different (non-existent) one.

7/7 audioInject tests pass; 38/38 across the full src/(app|bot) suite."
```

---

## Task D2.3: Modify Dockerfile — add second null-sink + master=

**Files:**
- Modify: `Dockerfile`

The `/start.sh` heredoc inside the `RUN echo '...'` block currently has:

```
pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
    sink_properties=device.description=Virtual_Speaker,device.class=sound\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
pactl set-default-sink virtual_speaker\n\
pactl set-default-source virtual_mic\n\
```

We need to:
- Add a second null-sink `virtual_mic_input` AFTER the existing `virtual_speaker` null-sink
- Add `master=virtual_mic_input.monitor` to the `module-virtual-source virtual_mic` line
- Add `|| true` on the two `pactl set-default-*` calls

**Critical: no apostrophes in any comment we add. Memory rule from yesterday.**

- [ ] **Step 1: Apply the edit**

Use the Edit tool with this exact change:

Replace:
```
pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
    sink_properties=device.description=Virtual_Speaker,device.class=sound\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
pactl set-default-sink virtual_speaker\n\
pactl set-default-source virtual_mic\n\
```

With:
```
pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
    sink_properties=device.description=Virtual_Speaker,device.class=sound\n\
\n# Second null-sink dedicated to mic injection. Its monitor becomes the\n# master of virtual_mic, so audio written via pulse:virtual_mic_input\n# surfaces in Chrome getUserMedia. Without this and the explicit\n# master= below, virtual_mic defaults to monitoring virtual_speaker,\n# causing the meeting incoming audio to loopback as Max outgoing.\n\
pactl load-module module-null-sink sink_name=virtual_mic_input \\\n\
    sink_properties=device.description=Virtual_Mic_Input,device.class=sound\n\
pactl load-module module-virtual-source source_name=virtual_mic \\\n\
    master=virtual_mic_input.monitor\n\
pactl set-default-sink virtual_speaker || true\n\
pactl set-default-source virtual_mic || true\n\
```

- [ ] **Step 2: Verify no stray apostrophes were introduced**

```bash
grep -nE "load-module|virtual_mic|master=" Dockerfile | head -10
grep -c "'" Dockerfile
```

The first command should show:
```
88:pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
... (comment block)
91:pactl load-module module-null-sink sink_name=virtual_mic_input \\\n\
93:pactl load-module module-virtual-source source_name=virtual_mic \\\n\
94:    master=virtual_mic_input.monitor\n\
```

The second command counts apostrophes. Expected: 2 (the opening `'` of `echo '` and the closing `'` of `' > /start.sh`). If it shows more, search for and remove the extras.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "fix(dockerfile): two-null-sink routing for injection — kill audio loopback

Audio loopback in v1: module-virtual-source virtual_mic without
explicit master= defaulted to virtual_speaker.monitor, which routed
incoming Meet audio back out as Max's mic. Suren heard his own
voice echoed through Max.

Fix: add a second null-sink (virtual_mic_input) dedicated to the
injection path. Its monitor becomes the explicit master of
virtual_mic. ffmpeg writes to pulse:virtual_mic_input (the sink)
in audioInject.ts. Audio flows:

  ffmpeg -> virtual_mic_input (null-sink)
  virtual_mic_input.monitor -> master of virtual_mic (source)
  Chrome getUserMedia reads virtual_mic -> Meet broadcasts

No FIFO. No module-pipe-source. No PulseAudio startup mystery.
Just canonical PulseAudio routing with the missing master argument.

Also hardens set-default-sink and set-default-source with || true
so they don't kill /start.sh if a prior module load failed."
```

---

## Task D2.4: Deploy + verify with /diag

**Files:** None modified.

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin milestone-d-v2/null-sink-routing
gh pr create --base main --head milestone-d-v2/null-sink-routing \
    --title "Milestone D v2: two-null-sink routing kills the audio loopback" \
    --body "Replaces the FIFO + module-pipe-source approach from D v1 with the canonical PulseAudio pattern: a second null-sink dedicated to mic injection, plus an explicit master= on the existing virtual-source. ffmpeg writes to pulse:virtual_mic_input (the sink), audio flows through the monitor to virtual_mic, Chrome reads virtual_mic. No loopback path. Five D v1 PRs of failed attempts are documented in the milestone D in-progress memory file."
```

- [ ] **Step 2: Merge the PR**

```bash
gh pr merge --merge --delete-branch
git checkout main
git pull --rebase origin main
```

- [ ] **Step 3: Wait for Railway redeploy**

```bash
echo "current UTC: $(date -u)"
echo "waiting 130s for build + deploy..."
sleep 130
```

- [ ] **Step 4: Verify /health and the new PulseAudio topology**

```bash
curl -s -w "HTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
# expected: 200 with the version payload
```

```bash
curl -s https://max-bot-production-7455.up.railway.app/diag | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('startsh timestamp:', d['startsh_present'][:80])
print('pulse_info:', d['pulse_info'][:120])
print('pulse_sources:')
print(d['pulse_sources'][:400])
"
```

**Acceptance for D2.4:** `/diag` shows TWO sinks in `pulse_sources` output (well, sources, but they include `.monitor` sources of all sinks):

```
1  virtual_speaker.monitor     module-null-sink.c        s16le 2ch 44100Hz  ...
2  virtual_mic_input.monitor   module-null-sink.c        s16le 2ch 44100Hz  ...    ← NEW
3  virtual_mic                 module-virtual-source.c   float32le 2ch 44100Hz ...
```

If only one `.monitor` source appears, the new null-sink didn't load. Check Railway deploy logs for the actual error.

- [ ] **Step 5: Cross-check with `pactl list sinks short`**

Add a `pactl list sinks short` query via `/diag/pulse` or `pactl_sinks` field if we already expose it. Otherwise, accept the source listing as proof. Two `.monitor` entries means two null-sinks exist.

---

## Task D2.5: Live acceptance — Suren hears a WAV played by Max, NO echo

**Files:** None modified.

Suren-in-the-loop. Manual verification.

- [ ] **Step 1: Suren joins a fresh Google Meet**

Use the test link `https://meet.google.com/mmg-mjgn-njd` or create a new meeting.

- [ ] **Step 2: Send POST /join**

```bash
curl -s -X POST https://max-bot-production-7455.up.railway.app/join \
    -H 'content-type: application/json' \
    -d '{"meeting_url":"https://meet.google.com/mmg-mjgn-njd","bot_name":"Max"}' \
    > /tmp/join.out 2>&1 &
for i in $(seq 1 18); do
    sleep 5
    if grep -q "bot_id\|error" /tmp/join.out 2>/dev/null; then
        cat /tmp/join.out
        break
    fi
done
```

Expected: `{"bot_id":"<uuid>"}` within ~30s.

- [ ] **Step 3: Confirm ffmpeg is alive**

```bash
BOT_ID=$(python3 -c "import json; print(json.load(open('/tmp/join.out'))['bot_id'])")
echo "bot_id: $BOT_ID"
curl -s https://max-bot-production-7455.up.railway.app/diag/inject/$BOT_ID | python3 -m json.tool
```

Expected:
- `ffmpeg_pid`: non-null
- `ffmpeg_exit_code`: null (still running)
- `ffmpeg_stderr_tail`: empty or just informational warnings

If `ffmpeg_exit_code` is non-null, read `ffmpeg_stderr_tail` for the error and fix before proceeding.

- [ ] **Step 4: Stream a WAV into Max's mic**

Use the boosted capture from Milestone C as a known-good 16 kHz mono WAV:

```bash
node scripts/play-audio-to-bot.js \
    wss://max-bot-production-7455.up.railway.app/ws_in/$BOT_ID \
    /Users/surendrankandasamy/Documents/max-bot-capture-boosted.wav
```

Expected output:
```
loaded 967294 bytes (30.2s @ 16kHz mono Int16)
ws open, streaming...
streamed 967294 bytes in 30.7s
ws closed (code=1005)
```

- [ ] **Step 5: Verify Suren hears the WAV from Max in the meeting, with NO echo**

Acceptance criteria:
- (a) Suren hears speech coming from Max's tile (the contents of the WAV — Suren's own voice from the earlier capture)
- (b) When Suren speaks during the test, his own voice is NOT echoed back through Max

Both must be true. If (a) fails, audio routing is broken. If (b) fails, the loopback bug isn't fully fixed and we need to investigate the routing further.

- [ ] **Step 6: Tear down**

```bash
curl -s -X POST https://max-bot-production-7455.up.railway.app/leave/$BOT_ID
```

- [ ] **Step 7: Update CLAUDE-NOTES.md with the result**

Append to `docs/CLAUDE-NOTES.md`:

```markdown
## Milestone D v2 — Accepted YYYY-MM-DD

- Live acceptance: Suren heard /Users/surendrankandasamy/Documents/max-bot-capture-boosted.wav play through Max in https://meet.google.com/mmg-mjgn-njd
- No echo of Suren's own voice through Max
- Architecture: ffmpeg -> pulse:virtual_mic_input (null-sink) -> .monitor -> virtual_mic (virtual-source with explicit master=) -> Chrome getUserMedia -> Meet broadcast
- bot_id: <uuid>

The 5 failed D v1 PRs (#14-#17 + #18 revert) are preserved in git history as a documented dead-end.

Ready for Milestone E: max-brain integration.
```

Commit:

```bash
git add docs/CLAUDE-NOTES.md
git commit -m "docs: milestone D v2 accepted — audio injection working, no echo"
git push
```

---

## Milestone D v2 acceptance checklist

- [ ] All Jest tests pass locally (38/38)
- [ ] Railway deploy `ACTIVE`, `/health` 200
- [ ] `/diag` shows TWO `.monitor` sources (virtual_speaker.monitor + virtual_mic_input.monitor)
- [ ] `POST /join` succeeds
- [ ] `/diag/inject/:bot_id` shows ffmpeg alive (exit_code null)
- [ ] WAV streamed via `scripts/play-audio-to-bot.js` audible through Max in the meeting
- [ ] **No echo of Suren's own voice through Max**
- [ ] `POST /leave/:bot_id` cleans up

When all 8 are checked: D v2 is done, ready for Milestone E.

---

## What if D2.4 or D2.5 fails

**If D2.4's diag shows the second null-sink didn't load:**
- Read Railway deploy logs (Build Logs and Deploy Logs tabs)
- Most likely: a typo in the load-module command. Re-check the heredoc string formation: any apostrophes? any unbalanced quotes? any stray characters from the editor?
- DO NOT add `|| true` to the `module-null-sink` line — we WANT to know if it fails. Failure should be visible.

**If D2.5's step 5 has (a) audio comes through but (b) echo is still present:**
- The `master=virtual_mic_input.monitor` argument was not applied to virtual_mic
- Verify with `/diag`: the `pulse_sources` field should show `virtual_mic` with no `s16le 2ch` (since virtual sources don't have their own format; they inherit from master)
- Check Railway logs for `pactl load-module module-virtual-source ... master=virtual_mic_input.monitor` — confirm it ran without error

**If D2.5's step 5 has (a) audio does NOT come through:**
- Check `ffmpeg_stderr_tail` via `/diag/inject/:bot_id`
- Most likely cause: PulseAudio rejected the sink name. Verify with `pactl list sinks short` via a new `/diag/pulse` field.

**Do NOT propose a pivot or workaround. Per memory rule.** If the v2 architecture itself proves wrong, that's a research task to find a different canonical PulseAudio routing — not a switch to FIFOs or Web Audio or system package installs.

---

## Self-review

**Spec coverage:**
- ✅ Acceptance criterion (WAV plays through Max, no echo) explicit in D2.5 step 5
- ✅ Loopback root cause documented and fixed by explicit `master=` argument
- ✅ State inconsistency from D v1 (audioInject.ts FIFO vs Dockerfile pulse) resolved in D2.2
- ✅ Memory rules respected: no apostrophes in heredoc edit, no workaround pivots in failure handling

**Placeholder scan:**
- D2.7 step 7 has `YYYY-MM-DD` and `<uuid>` placeholders — those are intentional fill-in-during-execution markers, not plan failures.
- No "TBD", "implement later", or "similar to" patterns elsewhere.

**Type consistency:**
- `AudioInjectOptions.pulseSink` introduced in D2.2 matches the test expectation in D2.1.
- ffmpeg args `-f pulse <sink_name>` consistent between test (D2.1) and impl (D2.2).
- Sink name `virtual_mic_input` consistent across Dockerfile (D2.3), audioInject default (D2.2), and acceptance verification (D2.4 step 4).

**Scope check:**
- Plan focuses on Milestone D v2 only.
- Estimated time: 30 minutes for D2.0-D2.3 (TDD pass), 5 min for D2.4 deploy + verify, 10 min for D2.5 live test. ~45 min total if everything goes right.
- Even with one round of failure debugging, should fit in a single focused session.

No issues found. Plan ready for execution.
