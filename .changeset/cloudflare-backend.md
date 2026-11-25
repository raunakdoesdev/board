---
'@vercel/board': minor
---

Add `@vercel/board/backend-cloudflare`: `durableObject()` keeps a board in a Durable Object's SQLite with its schedule on the object's alarm, `r2Blob()` keeps its files in R2, and `cloudflareAccess()` and `bearerTokens()` let people and agents in. The board skill installs with `npx skills add raunakdoesdev/board --skill board -g`.
