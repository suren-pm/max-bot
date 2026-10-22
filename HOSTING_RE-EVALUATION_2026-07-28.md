# Max-Bot Hosting Re-Evaluation — 2026-07-28

Full end-to-end research pass. Supersedes the ASN conclusion in `HANDOFF_2026-06-08.md`.
Four parallel research agents; primary sources cited throughout.

---

## TL;DR — four findings that change the decision

1. **"Otter does it without issues" is false.** Every major vendor hits the exact same wall we did. They just push the fix onto the *customer's* Workspace settings and sell "signed-in bots" as a premium tier. We were comparing our reality against their marketing.
2. **There is no official Google API that lets a bot SPEAK.** The Meet Media API is verifiably receive-only. So the "legitimate path" I floated last session does not exist for Max. Anyone with a talking bot is doing browser automation.
3. **The ASN theory is very likely wrong.** Recall.ai runs thousands of bots from AWS datacenter IPs and documents zero ASN-related failures. Our error message maps precisely to Google's *documented* host-policy / sign-in gates.
4. **Managed speaking-bot vendors now cost less than the Railway bill we just cancelled.** At Max's real volume (~5.5 hrs/month) this is $3–12/month. The cost + iteration-freedom argument that justified the entire self-hosting project no longer holds.

---

## 1. How the commercial players actually do it

**Dominant mechanism: headless Chromium browser bots.** Not official APIs. Attendee's README states it plainly: *"Google Meet doesn't provide any support at all, so you need to run a full instance of Google Meet in Chrome."*

**Most join as anonymous guests — and it visibly breaks for them:**

| Vendor | Evidence they hit our exact wall |
|---|---|
| **Fireflies** | Own docs: *"Fireflies joins Google Meet as a guest, so this must be enabled [in Workspace admin]. If not, Fred won't be able to join."* Also warns its bot gets labelled **"potential risk"** in the waiting room — "expected behavior." |
| **Circleback** | Troubleshooting doc says fix join failures by disabling *"Only authenticated users can join"* / enabling guest access. |
| **Otter.ai** | Joins as guest, needs host admit. In active federal litigation (*In re Otter.AI Privacy Litigation*, N.D. Cal). |
| **Read.ai** | Blocked network-wide by Univ. of Washington, Chapman, UC Riverside. Has since moved to a botless Media API integration. |
| **Avoma** | Anonymous guest; you add `assistant@avoma.com` to the calendar invite. |

**Google is actively tightening this in 2026** — a new *"safeguarded guest admit flow"* (announced Feb 2026) routes suspected bots into a **default-deny** queue. Microsoft Teams began labelling third-party bots "Unverified" (MC1251206, GA mid-June 2026). This is getting harder, not easier.

**So the honest answer to "how are they fine and we're stuck?"** — they aren't fine. The difference is they (a) make the customer loosen Workspace settings, and (b) offer **authenticated bots via SSO** for customers who can't. We were trying to beat the gate with stealth instead of walking through the front door with an identity.

## 2. The official Google path cannot work for Max

The **Meet Media API** is the only Google surface with real-time in-call audio. It is **receive-only** — this is not inference, it's in Google's own reference docs:

- Docs mandate `direction: 'recvonly'` transceivers; Meet answers `sendonly`.
- All three OAuth scopes are literally named `...readonly` (`meetings.conference.media.readonly`).
- Use-case verbs throughout are "consume", never "publish"/"send".

Also still **Developer Preview** (re-confirmed 2026-07-08), and requires *the Cloud project, the OAuth principal, and **all participants*** to be enrolled in the preview program.

The Meet **REST API** is metadata + post-hoc artifacts only. Add-ons SDK is a UI iframe, no media. Gemini Live API is genuinely bidirectional but has **no Meet integration** — there's no supported way to pipe its output back into a call.

> **Conclusion: for a bot that must SPEAK, browser automation is the only path in 2026.** Max is in the harder category — most vendors are listen-only.

## 3. Root cause: we probably misdiagnosed it

Evidence against the Railway-ASN theory:

- **Recall.ai runs its whole fleet on AWS EC2 datacenter IPs** ("each bot spins up on its own EC2 instance which has a dedicated IP"). Their FAQ documents every join failure mode in detail — **IP/ASN is never mentioned.** If Google blocked datacenter ASNs from Meet joins, their business would not function.
- **Our exact error maps to documented, named causes.** Recall publishes sub-codes: `google_meet_knocking_disabled` ("meeting has disallowed external participants from asking to join") and `google_meet_sign_in_missing_login_credentials` ("meeting requires all participants to be signed in"). Google's own docs: unchecking *"Anyone with the meeting link can ask to join"* means **"Anonymous users or third-party bots, like note takers, that attempt to use 'Ask to join' are automatically denied access without actions required by the host."**
- **Fingerprint alone can produce this identical error with IP held constant** — Brave browser issue #32836: user on a residential IP got "You can't join this video call" in Brave but not Chrome/Safari/Firefox on the same connection. Cause: Brave's anti-fingerprinting. Disabling it fixed the join.
- **The May 2026 "Railway blocked by Google Cloud" article we cited was a red herring** — that was a GCP *billing/tenant* suspension, unrelated to Meet joins.

The Mac-vs-Railway test co-varied OS, Chromium build, Docker net stack, fonts/canvas/audio fingerprint, **and possibly logged-in Chrome profile state** — all at once. Attributing it to ASN was an over-fit.

**Most→least likely causes:** (1) confounded test / fingerprint+profile state, (2) meeting host access policy requiring sign-in, (3) Google's new Feb-2026 default-deny guest classifier, (4) behavioural bot detection (incl. bot *display name* filtering), (5) ASN — unsupported.

## 4. What authenticated actually means (and its own trap)

Recall's docs are the best primary source here. They support three sign-in methods and rank them:

- **SSO V2 / SAML — "the fastest and most reliable sign-in method."** Requires a **dedicated, separate paid Workspace** (cannot reuse an existing one — it rewires org-wide SSO).
- **Username/password — "the slowest, and can sometimes fail if Google rejects the request or displays a CAPTCHA."**

> Key nuance: it's not merely *authenticated vs anonymous*. **Typing credentials into Google's login form is itself a bot-detection trigger.** SSO works because it never touches that form. Also note Recall's hard warnings: use a brand-new Workspace domain, never an admin account.

Cost: ~$7/user/mo for the Workspace seat, plus SSO/SAML setup. **This is a real path but it is not cheap in effort, and it carries account-suspension risk we cannot fully quantify** (no documented pattern of suspensions for notetaker bots, but ToS prohibits automated access; vendors architect defensively around it).

## 5. Residential proxies are the wrong tool (technically, not just financially)

**Chrome's SOCKS5 client is TCP-only — it does not implement UDP ASSOCIATE.** So WebRTC's UDP media path cannot go through a SOCKS/HTTP proxy. Your options are to force `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, which falls back to **TCP relay** — head-of-line blocking on a real-time voice loop, risking stalls rather than graceful degradation. Against Max's ~1.1s latency budget that's an unbounded risk.

Bandwidth cost was never the issue (real Opus audio ≈ 1 GB/month → a few dollars). **The correct way to get a residential IP is a home machine or a free Tailscale exit node — not a proxy subscription.**

## 6. Options, costed at Max's real volume

Max = one daily standup. **~15 min × 22 workdays ≈ 5.5 hrs/month** (the 20–40 hr figure was over-estimated).

| Option | Cost/mo | Speaks? | Data control | Effort | Verdict |
|---|---|---|---|---|---|
| **MeetingBaaS Speaking Bots** | ~$4–7 | ✅ Built on **Pipecat** — our exact stack | 3rd party | **Low** — we forked their repo; V1 already ran on MBaaS | **Fastest path back to working** |
| **Vexa.ai** | **$12 flat** (1 concurrent bot, *unlimited* meetings) or $0.30/hr; **Apache 2.0, self-hostable free** | ✅ `/speak` | Yours if self-hosted | Low–med | **Best licence + kills the iteration-cost problem** |
| **Attendee (OSS)** | $0 self-host / $0.50 hr hosted | ✅ audio in+out via WS | Yours | Med | ELv2 — fine for internal use |
| **Home Mac / mini-PC** | ~$0 (+UPS) | ✅ | Yours | Med | Residential IP, **already proven to work** |
| **Cloud self-host + Workspace SSO** | ~$7 seat + host | ✅ | Yours | **High** | Only if data must stay in-house *and* cloud |
| **Recall.ai** | ~$3 (5 hrs free) | ✅ Output Media, best docs | 3rd party | Low | ⛔ **Previously SCRAPPED on security grounds — excluded** |
| **Google Meet Media API** | n/a | ❌ **receive-only** | — | — | ⛔ Cannot work |

**The economics that started this whole project have inverted.** We left MBaaS for "iteration freedom" because every test burned tokens. Vexa's $12 flat/unlimited and Recall/Attendee's 5 free hours solve exactly that — and all of them cost less than the $5/mo Railway subscription we just cancelled, with zero infrastructure to maintain.

## 7. Recommendation

**Primary: go managed on MeetingBaaS Speaking Bots, or self-host Vexa.** Rationale: Max must speak (rules out the official API and most vendors); we've now spent months on an infrastructure problem that costs ~$5/month to make disappear; MBaaS is already security-vetted here (V1 ran on it) and its Speaking Bots stack is Pipecat — the same framework Max's brain already uses. Vexa is the hedge: Apache 2.0, self-hostable, $12 flat.

**Do not** rebuild the browser bot on another cloud host. Every candidate is a datacenter ASN, the ASN theory is unsupported, and a host swap would likely change nothing while costing another cycle.

**Keep** `suren-pm/max-bot` @ `36b535e`. It is proven-correct from residential and is the fallback if we ever want full in-house control on a home machine.

### ⏰ Timing note
Railway's subscription ends **Jul 29, 2026 — tomorrow.** After that Railway tears down all resources. Everything is backed up (`_railway_offline_backup_2026-07-06/`), so nothing is lost — but **there is no point running any further test on Railway.** Whatever we do next starts elsewhere.

### The one cheap test that settles the old question (optional, ~30 min, $0)
If we ever want to self-host again, run the **existing Docker container on the Mac** (residential IP + Linux/Docker fingerprint, anonymous guest).
- **Joins** → the Docker/Linux environment is fine; the failure really was network-side.
- **Fails** → it was the container fingerprint all along, and no host migration would ever have fixed it.

This isolates fingerprint from IP in a single run, needs no Railway, and costs nothing.

---

## Sources
Google: [Media API concepts (recvonly)](https://developers.google.com/workspace/meet/media-api/guides/concepts) · [Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview) · [Meet REST API](https://developers.google.com/workspace/meet/api/guides/overview) · [Safeguarded guest admit flow, Feb 2026](https://workspaceupdates.googleblog.com/2026/02/safeguarded-guest-admit-flow-in-google-meet.html) · [Meeting access types](https://support.google.com/a/users/answer/11989526) · [Admin: external apps recording Meet](https://support.google.com/a/answer/14670779)
Vendors: [Recall Google Meet FAQ (failure sub-codes)](https://docs.recall.ai/docs/google-meet-faq) · [Recall signed-in bots](https://docs.recall.ai/docs/google-meet-login-getting-started) · [Recall bot login credentials](https://docs.recall.ai/docs/bot-login-credentials) · [Recall Output Media](https://docs.recall.ai/docs/stream-media) · [Recall: build a Meet bot from scratch](https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot) · [MeetingBaaS Speaking Bots](https://docs.meetingbaas.com/speaking-bots) · [MeetingBaaS pricing](https://pricing.meetingbaas.com/pricing) · [Vexa pricing](https://vexa.ai/pricing) · [Vexa GitHub](https://github.com/Vexa-ai/vexa) · [Attendee](https://github.com/attendee-labs/attendee) · [Fireflies: joins as guest](https://guide.fireflies.ai/articles/7581948912-how-to-invite-fireflies-to-google-meet-meetings) · [Circleback troubleshooting](https://support.circleback.ai/en/articles/10489225-troubleshoot-circleback-not-joining-a-meeting) · [Read.ai botless](https://www.read.ai/post/read-ai-introduces-a-botless-integration-with-google-meet)
Technical: [Brave #32836 — fingerprinting causes identical error](https://github.com/brave/brave-browser/issues/32836) · [Chrome WebRTC IP handling policy](https://chromeenterprise.google/policies/web-rtc-ip-handling/) · [discuss-webrtc: SOCKS5 UDP unsupported](https://groups.google.com/g/discuss-webrtc/c/E3FX4bp363M) · [UC Today: platforms tighten bot controls](https://www.uctoday.com/security-compliance-risk/ai-meeting-bots-controls-microsoft-zoom-google/)
