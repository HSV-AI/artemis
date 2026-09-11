# Web search

## Status

Implemented.

## Problem

Artemis can read a specific URL (`web_fetch`) but could not perform a general
web search. Scheduled tasks — the daily AI news digest, the weekend events
digest, and the Wednesday HSVAI meetup check — need ranked web results, and
until now they carried ad-hoc "search fallback" wording with no registered
capability behind it. The validated mechanism is to fetch a search-results page
over HTTP, exactly like `web_fetch` reads any page: a search-results URL
(DuckDuckGo's HTML endpoint) returns a plain HTML page of ranked results whose
links carry the source URLs. Packaging this as a registered custom tool gives
every conversation — interactive and scheduler-fired alike — a reusable,
versionable web-search capability built entirely on the existing direct-fetch
mechanism, with no new harness tool.

## Scope

This protocol owns:

- the `web_search` PI custom tool and its prompt-registry entry
- search-results URL construction for the supported engines
- per-engine result parsing and search-redirect unwrapping
- the DuckDuckGo-first auto fallback to Bing

It does not change `web_fetch`, the GitHub tools, scheduler authorization, or
any other tool contract.

## Observable behavior

Artemis registers a `web_search` tool for every profile in every conversation,
including scheduler-fired generations. It accepts:

- `query` (required, non-empty string) — the web search query
- `limit` (optional integer, 1–20, default 8) — maximum ranked results returned
- `engine` (optional: `auto` default, `duckduckgo`, or `bing`) — `auto` tries
  DuckDuckGo first and falls back to Bing; the explicit values pin the engine

Executing it fetches the engine's search-results page and returns a ranked,
numbered list in which every entry carries the title, the unwrapped source URL,
and a snippet, all labeled as untrusted external web content:

```text
Web search results for "<query>" (via <engine> search):
<N> ranked result(s):

1. <title>
   URL: <unwrapped source URL>
   <snippet>
...
```

The tool's prompt registry tells Artemis to use `web_search` when a question
needs current web information and to follow up on results with `web_fetch`.
Scheduled prompts invoke it like any registered tool, replacing the former
ad-hoc search-fallback wording.

## Contracts and data flow

```text
model -> web_search tool
        -> direct HTTP GET to the engine search-results URL
           (same conventions as web_fetch: no model credentials, redirects
            followed, HTML first, 100,000-character read bound)
        -> per-engine parser -> ranked {title, url, snippet}
        -> sanitize + label -> model
```

The search-results URL is constructed by URL-encoding the query into a fixed
endpoint per engine:

- DuckDuckGo (primary): `https://html.duckduckgo.com/html/?q=<encoded query>`
- Bing (fallback): `https://www.bing.com/search?q=<encoded query>`

DuckDuckGo HTML-endpoint parsing: every `<a class="result__a">` anchor is one
ranked result in document order; the nearest following
`<a class="result__snippet">` anchor before the next title anchor is its
snippet. Bing parsing: each `<li class="b_algo">` organic block carries its
title and redirect-wrapped link in the `<h2>` anchor and its snippet in the
first `<p>`. Both parsers strip markup, decode entities, skip ad results and
search-engine-internal links, skip results whose source URL cannot be
unwrapped, deduplicate by source URL, and cap at `limit`.

Redirect unwrapping recovers the source URL from each engine's wrapper:

- DuckDuckGo `//duckduckgo.com/l/?uddg=<encoded source URL>&...` — the source
  URL rides in the `uddg` query parameter; wrapped ad links (marked with
  `ad_provider` or `ad_domain`) and DuckDuckGo-internal links are dropped.
- Bing `https://www.bing.com/ck/a?...&u=a1<base64url source URL>&...` — the
  source URL rides in the `u` parameter, prefixed with `a1` and encoded as
  URL-safe base64; ad links (`/aclk`) and unwrappable links are dropped.

Only `http:` and `https:` targets are accepted anywhere in the unwrapping.
Direct (already-source) hrefs pass through unchanged.

## Configuration

None. The tool reuses the process fetch implementation (the same
provider-independent direct fetch as `web_fetch`, injected as
`fetchImplementation` in tests). The engine endpoints are fixed constants of
this protocol, not configuration.

## Persistence

None. Searches are stateless tool calls; nothing is stored.

## Security and privacy

- The same defenses as `web_fetch` apply to search output: no model-provider
  API key reaches the engine; returned titles, snippets, and URLs are
  sanitized (role delimiters neutralized, instruction-override phrases
  redacted, with a security notice when anything changed) and wrapped in
  explicit begin/end external-content markers naming the search URL.
- The query is URL-encoded into the engine URL; only the query text reaches the
  search engine. The engine sees the Artemis process's egress identity, never
  model credentials.
- Unwrapping accepts only HTTP(S) targets and silently drops unusable or
  non-HTTP redirects, so engine wrappers and ad redirects do not leak into the
  model context as source URLs.
- Fetched search pages are bounded and parsed, never replayed verbatim; search
  engines have network reachability equal to the Artemis process, and operators
  must apply runtime egress controls where internal addresses must stay
  unreachable.

## Failure handling

- A blank query or an invalid `limit` (non-integer or outside 1–20) is rejected
  before any network request.
- A non-successful engine response raises `web_search (<engine>) failed (status
  <code>): <bounded upstream text>`. In `auto` mode the other engine is still
  attempted before giving up; a pinned engine surfaces its failure directly.
- A fetched page with zero parseable results (for example an anomaly/challenge
  page) is treated like an empty result set: `auto` falls back to the other
  engine, a pinned engine errors `web_search found no results for "<query>" on
  <engine>`.
- When both engines are exhausted, the tool raises one aggregate error naming
  each engine's outcome.
- All tool errors follow the normal generation-failure path and produce no
  Discord response.

## Verification

- `test/web-search-tool.test.ts` covers registration, blank-query and limit
  validation, the DuckDuckGo search-URL construction and fetch conventions,
  ranked DuckDuckGo parsing with `uddg` unwrapping and ad/internal/unwrappable
  skipping, default and explicit limits, the automatic Bing fallback with
  `ck/a`/`u` unwrapping, pinned engines, per-engine HTTP errors, the aggregate
  no-results error, adversarial snippet sanitization, and parser/unwrap unit
  tests, including a live-web smoke check of the fallback path.
- `test/pi-gateway.test.ts` covers registration of `web_search` among the
  custom tools for interactive and scheduler-fired generations and its
  advertisement in the Available Tools system-prompt registry.

## References

- [Configurable model provider](model-provider.md) — the direct HTTP fetch mechanism `web_search` shares with `web_fetch`.
- [Scheduler execution engine](scheduler-execution.md) — scheduled turns run with the full custom-tool registry, so scheduled prompts can call `web_search`.
- [Clean-room rebuild guide](rebuild-guide.md) — the `web_search` tool contract for compatible implementations.