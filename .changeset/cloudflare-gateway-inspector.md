---
'@vercel/board': patch
---

`inspector()` takes a `visitor` that names who a gateway let in: the page starts as them and asks no name. It loads in a Cloudflare Worker, and the cloudflare template serves it at a gateway's host.
