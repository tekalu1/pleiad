# Vendored OAuth code

The files `pkce.mjs`, `oauth-page.mjs` and `openai-codex-oauth.mjs` in this
directory are derived from `@earendil-works/pi-ai` (specifically
`packages/ai/src/utils/oauth/{pkce,oauth-page,openai-codex}.ts`) at
https://github.com/earendil-works/pi, by way of procway-code
(`ai-agent/src/auth/oauth/`), which vendored them first.

They are vendored here (rather than added as an npm dependency) because
agent-host keeps its dependency list to `ws` + the Agent SDK, and the OAuth
flow is a few hundred lines of plain `.mjs` that needs no build step.

Changes from the procway-code copy: the default `originator` is `"agent-host"`
and the callback bind host is read from `AGENT_HOST_OAUTH_CALLBACK_HOST`.

The upstream license is reproduced below.

---

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
