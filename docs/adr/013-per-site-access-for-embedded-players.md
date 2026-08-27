# ADR-013: Per-site access for a player embedded from another origin

- **Status:** Accepted
- **Date:** 2026-08-27
- **Applies:** PROJECT_BIBLE.md §13.7 (host permission policy), §8.10 (content script
  lifecycle), §4.15 (optional permissions), §12.6 (network observation)
- **Amends:** nothing. §13.7 already permits "optional, per-origin host permissions only when a
  user explicitly opts a site in, and revocable". This records how detection applies it.

## Context

1.6.0 taught the extension to observe frames, because a video host wraps its player in an
`/embed/` iframe and the top document then holds no media at all. That fixed the sites whose
embed is **same-origin**.

It did nothing for the ones whose embed is not. Measured on a real page, from the user's own
browser:

```
ORIGIN   https://vidara.so
IFRAMES  ['CROSS https://morningmarkets.ink/e/isV3ux8JCZyNO']
VIDEOS   []
ENTRIES  8
CANDIDATES  ['other vidara.so /assets/images/favicon/favicon.ico 3KB',
             'other vidara.so …/apple-touch-icon.png 12KB']
```

Two favicons. The page's entire media stack — the player, its playlist, its segments, its
`blob:` URL — is inside a frame belonging to a different origin.

`activeTab` grants the tab's **top-level** origin. Chromium does not extend it to a
cross-origin frame, so `scripting.executeScript({ allFrames: true })` silently injects into
the top document only: there is no error to report, no permission to catch, and nothing
observed. Detection then returns zero items and the popup says **"No media detected"** — which
is false. The truthful statement is "not allowed to look".

The same boundary explains a second symptom on the same class of site. A background `fetch`
at an origin the extension holds no permission for is subject to CORS, so a host that does not
send `Access-Control-Allow-Origin` cannot be probed or read even when its URL is known. One
grant lifts both.

### What was rejected

- **Broad host access at install.** Forbidden by §13.3 and §13.7, and it would trade the
  product's central promise for the convenience of never asking.
- **`webRequest` observation.** Needs the same host permission to see the same requests, and
  adds an interception surface for no additional reach.
- **Reconstructing the stream from the `blob:` handle.** Not resolvable within the security
  model; §13 forbids page-world injection, which is the only thing that could reach it.
- **Guessing the embed's playlist URL from its page URL.** A constructed URL is exactly what
  §12.6 forbids probing, and it would be wrong more often than right.

## Decision

The top document reports the **origins** of the frames it embeds — read from the frame
elements' own `src` attributes, which is the one thing about a cross-origin frame a page may
see. Nothing is entered, nothing is fetched, and the frame's document stays as unreachable as
it was.

The popup turns that list into a question naming the site, and offers it in place of the false
"No media detected". The user's click requests host access **for those origins only**; the
grant is what makes `allFrames` injection reach the frame, and the frame's own observations
then arrive as its own report. Declining leaves the offer standing and reports no error,
because declining is an answer.

Consequences of the shape:

- **The origin is re-derived at the trust boundary.** What lands in a permission prompt is
  what the user is being asked to trust, so `frameOriginsFrom` accepts only `http(s)` and
  reduces each to a bare origin — never a path, never a pattern, capped in count. A page
  cannot get itself asked about on someone else's behalf.
- **Nested embeds resolve by iteration.** A granted frame reports the origins **it** embeds,
  which merge into the tab's list, so the next question is asked in turn rather than requiring
  a blanket grant up front.
- **A refresh re-enters frames.** The once-per-page guard from 1.6.0 exists to keep automatic
  passes cheap; it must not outlast a new grant, so an explicit refresh clears it.
- **Grants are revocable and listed.** Settings already lists every granted origin with a
  Revoke; this feature adds nothing new to remove.

## Consequences

A site whose player lives on another origin is detectable, and downloadable, **after** the
user opts that origin in — and says so plainly before they do. Nothing about the default
posture changes: no standing host permission, none requested at install, none taken without a
click. What changes is that the extension stops reporting an empty page when the truth is that
it was not allowed to look.
